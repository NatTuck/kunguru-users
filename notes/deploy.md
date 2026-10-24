
# Deploying kunguru-users to a server (user systemd service + nginx)

This runbook deploys the app as a **systemd user service** under the server's
`kunguru` account (lingering, so it starts at boot) and puts it behind the
gateway's nginx as `https://users.<domain>/`. It mirrors the dev toolchain
(mise + node + pnpm). The test target is **otter** serving `users.ironbeard.com`.

Conventions:
- Apps run from `~/.local/apps/<name>` for the owning user.
- The app process user must be able to reach every host it provisions onto
  (`kunguru@<host> 'sudo -n bash -s'`, passwordless) using its own ssh key.
- Repo toolchain is pinned in `.mise.toml` (node). Everything else (pnpm,
  node modules, build) comes from the checkout; only instance config lives
  outside it (`~/.config/kunguru-users.env`).

## 0. Prerequisites on the target (as the app user, `kunguru`)

Cross-server ssh for provisioning jobs. `kunguru@otter` must reach itself
(`localhost`) and the other group hosts over the VPN (`10.0.1.2` = goose).

```sh
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519    # if no key yet
# authorize on self:
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys
# authorize on goose (from the controller that already has kunguru@goose access):
#   cat <otter key>.pub | ssh kunguru@goose 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'
# verify:
ssh -o BatchMode=yes kunguru@localhost 'sudo -n true'
ssh -o BatchMode=yes kunguru@10.0.1.2    'sudo -n true'   # accept host key once
```

## 1. Toolchain (mise, mirroring dev)

```sh
curl https://mise.run | sh        # installs ~/.local/bin/mise
export PATH="$HOME/.local/bin:$PATH"
mkdir -p ~/.local/apps
git clone https://github.com/NatTuck/kunguru-users.git ~/.local/apps/kunguru-users
cd ~/.local/apps/kunguru-users
mise install                      # node 26.1.0 from .mise.toml
mise exec -- npm install -g pnpm@11.7.0
```

## 2. Install + build

```sh
cd ~/.local/apps/kunguru-users
pnpm install --frozen-lockfile
pnpm build                        # client -> dist/
pnpm typecheck
```

## 3. Instance config

```sh
cp deploy/kunguru-users.env.example ~/.config/kunguru-users.env
$EDITOR ~/.config/kunguru-users.env   # PORT/HOST + KUNGURU_SSH_* overrides
```

## 4. Run as a user service (with linger)

```sh
install -d ~/.config/systemd/user
cp deploy/kunguru-users.service ~/.config/systemd/user/
systemctl --user daemon-reload
sudo loginctl enable-linger kunguru     # so the unit starts at boot, no login
systemctl --user enable --now kunguru-users
systemctl --user status kunguru-users
journalctl --user -u kunguru-users      # first-boot admin password is here
```

First boot seeds the `kunguru` admin and prints a **one-time password** to the
journal. Record it, then log in at the public URL. If it is ever lost:
`pnpm reset-admin-pw` (regenerates and prints a new one).

## 5. nginx reverse proxy (`https://users.<base>/`)

On the gateway host, as root — nginx already owns 80/443 here. `deploy/nginx-users.conf`
is a **template**: it uses placeholders nginx rejects, so an unfilled copy fails
`nginx -t`. Fill them from the instance config (`deploy/instances/<instance>.json`:
`domain`, `runtime.port`, `sitesCert`).

```sh
# <base> = instance domain, <port> = runtime.port (default 3030),
# <cert> = sitesCert (default kunguru-sites)
sed -e 's/<base>/kunguru.net/g' -e 's/<port>/3030/g' -e 's/<cert>/kunguru-sites/g' \
  deploy/nginx-users.conf > /etc/nginx/sites-available/kunguru-users
ln -s /etc/nginx/sites-available/kunguru-users /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

DNS must point `users.<base>` (and the wildcards below) at the gateway's public
IP before the certificate can be issued.

### 5a. TLS — the shared wildcard certificate

The app vhost, the Bifrost vhost, and the rendered account/site vhost all reuse
one cert (`sitesCert`): a fixed wildcard pair issued **once** and renewed by
`certbot.timer`. Because the SAN set never changes, adding accounts or static
sites never re-issues a certificate.

```
*.kunguru.net          users. (app), llm. (Bifrost), <account>., <account>-dev.,
                       <account>-agent., <label>. (static sites)
*.users.kunguru.net    legacy; now redundant (the `.users.` app subtree is retired)
```

The `*.users.<base>` SAN is kept until the next issuance so no vhost loses
coverage mid-migration; nothing in the current model needs it.

Issued via Joker DNS-01 (needs the per-zone DynDNS credentials file):

```sh
sudo bash scripts/nginx/acme/install.sh
sudo KUNGURU_BASE_DOMAIN=kunguru.net KUNGURU_ACME_EMAIL=<email> \
  /usr/local/lib/kunguru/acme/ensure-sites-cert.sh
```

See `scripts/nginx/acme/README.md` for the credentials file and the DNS-01
rationale. The apex `kunguru.net` / `www.kunguru.net` keeps its own cert and
vhost; it is deliberately not folded in.

## 6. Verify

```sh
curl -sI https://users.<base>/                    # 200, SPA
curl -s  https://users.<base>/api/auth/me          # 401 (unauth)
# log in as kunguru, create a user, check the job log in the UI.
```

## Upgrading

**The deployment at `~/.local/apps/kunguru-users` must be a git checkout** that
tracks `origin/main` (see §1); that is the standard deployment method. If you
find a plain copy with no `.git` (as `drongo` was), convert it in place — the
checkout's tracked files are replaced with the remote's, while ignored state
(`data/`, `dist/`, `node_modules/`) is preserved:

```sh
cd ~/.local/apps/kunguru-users
git init
git remote add origin https://github.com/NatTuck/kunguru-users.git
git fetch --depth 1 origin main
git checkout -f -b main FETCH_HEAD
git branch --set-upstream-to=origin/main main
```

Then deploy:

```sh
cd ~/.local/apps/kunguru-users
git pull --ff-only
mise install                      # no-op unless the pinned node changed
pnpm install --frozen-lockfile
pnpm build
systemctl --user restart kunguru-users
```

On hosts without mise (`drongo`), use the app's bundled Node toolchain instead:
`PATH="$HOME/.hermes/node/bin:$PATH" pnpm …`.

After a change that affects account/site routing (`server/sites.ts`), reconcile
both nginx layers — the gateway routes and every host's static-site listener.
This no longer touches certificates (the shared wildcard cert is fixed and
renewed by `certbot.timer`):

```sh
pnpm sites-reconcile              # or: mise exec -- pnpm sites-reconcile
```

Database lives in `<checkout>/data/` (gitignored) and is preserved across pulls.

## Upgrading tenant agents (Hermes / XMPP plugin / WebUI)

`scripts/hermes/ensure.sh` converges each tenant's Hermes install, and
`scripts/webui/ensure.sh` converges the WebUI. A plain `ensure` keeps the XMPP
plugin and the WebUI current (git fetch + hard-reset, since they're shallow
clones) and installs the optional OMEMO stack (`slixmpp-omemo`/`omemo`), but it
does **not** touch the Hermes agent version.

To move the agent itself to the latest upstream (heavy: git pull + dependency
reinstall + gateway restart), run the hermes step with `HERMES_UPDATE=1` (or
`HERMES_ACTION=update`):

```sh
# on the tenant's host, as the app user (or via the app's transport)
sudo env USERNAME=alice HERMES_UPDATE=1 bash -s < scripts/hermes/ensure.sh
```

Notes:
- The new Hermes plugin security scanner flags the community XMPP plugin as a
  "dangerous" verdict and auto-disables it on `hermes plugins update`. The
  scripts update it via git and re-assert `plugins.enabled`, bypassing that.
- OMEMO is enabled via `XMPP_OMEMO_ENABLED=true` in the tenant's
  `~/.hermes/.env`; the agent publishes its device list on first connect.

## Tenant site deployment (the `kunguru-sites` skill)

Tenants must not touch nginx, certbot, or DNS. The gateway nginx is rendered
centrally by `scripts/nginx/ensure-user-sites.sh` from the DB + a fixed port
formula (`server/sites.ts`), so a tenant exposes an app simply by running a web
server on the assigned **slot port** on their host. Every account (a user, or a
group) has the same two app slots plus a managed WebUI:

| Slot | Hostname | Port | Access |
|---|---|---|---|
| app | `<account>.<base>` | `12000 + id` | optional auth (or `require_auth`) |
| app-dev | `<account>-dev.<base>` | `13000 + id` | optional auth (or `require_auth_dev`) |
| hermes-webui | `<account>-agent.<base>` | `11000 + id` | login required (managed) |

The gateway authenticates every routed host through `/internal/auth`, strips the
session cookie, and injects the verified identity as `Remote-User` /
`Remote-Groups`; a `require_auth` host gets a 401 there and is redirected to the
login page. Tenant apps bind the address the gateway reaches and trust those
headers only from the gateway's WG IP. Extra hostnames need an account name
(a group) — aliases are retired.

### Static sites

A static site is an owner-scoped resource (owner = user or group, 5 per owner):

- label `<label>.<base>`, in the same namespace as account names;
- source/build project `~/sites/<label>`, served docroot `~/www/<label>`;
- served by **nginx on the owner's host** on one gateway-only HTTP listener
  (`PORT_STATIC_SITES`, 14000), rendered by
  `scripts/nginx/ensure-user-static.sh` (which also creates the directories and
  grants `www-data` read access via ACLs — homes are 2770);
- the gateway forwards `<label>.<base>` to `<owner-host>:14000` and applies the
  site's `require_auth` gate. The gateway never serves a tenant docroot.

`pnpm sites-reconcile` converges both layers (gateway routes + every host's
static listener) from the DB; the app calls the same code after any account or
site change.

`scripts/hermes/ensure.sh` installs this contract into every tenant as the
`kunguru-sites` skill under `~/.hermes/skills/kunguru-custom/`, embedding the
skill body (the transport pipes a single script over stdin) and generating
`references/local.md` from `KUNGURU_USER_ID`, `KUNGURU_BASE_DOMAIN`,
`KUNGURU_GATEWAY_WG_IP`, `KUNGURU_BIND_ADDR`, and `KUNGURU_TRUSTED_PROXY`
(passed by the `hermes` step in `server/provision.ts`). It supersedes the
retired `kunguru-nginx` / `~/www` / `~/sites` guidance, which should be archived
out of `~/.hermes/skills/` on tenants that still carry it.

