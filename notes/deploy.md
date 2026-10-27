
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

Cross-server ssh for provisioning jobs, for hosts that are not the app's own
machine. A host with `sshTarget: "localhost"` runs its steps **locally** as the
app user (`sudo -n env -i … bash -s`), so it needs no key or ssh-to-self.

```sh
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519    # if no key yet
# authorize on a remote user server (from a controller that already has access):
#   cat <gateway key>.pub | ssh kunguru@10.0.1.2 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'
# verify (remote hosts only):
ssh -o BatchMode=yes kunguru@10.0.1.2 'sudo -n true'   # accept host key once
```

A one-host instance therefore needs no ssh setup at all — only passwordless
`sudo` for the app user, which the bootstrap's ssh-access step grants.

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

Two files. Neither is instance identity in the repo: the env file lives outside
the checkout, and the JSON is the tracked, secret-free instance config.

- `~/.config/kunguru-users.env` selects the instance and carries runtime/secrets:
  `KUNGURU_INSTANCE=<name>` (loads `deploy/instances/<name>.json`), an optional
  `KUNGURU_CONFIG=<path>`, and `NODE_ENV=production`. `PORT`/`HOST` are **not**
  read — the listen address is `runtime` in the instance JSON.
- `deploy/instances/<name>.json` holds the deployment identity: domain, XMPP
  domain, `gatewayHost`/`snikketHost`, the host list, and the LLM endpoint.

There are no built-in defaults: a missing file or required field refuses to
start (see `server/config.ts`).

### One-host instances

Use a single host row with `sshTarget: "localhost"` and point `gatewayHost` and
`snikketHost` at it (`deploy/instances/single.example.json`) — see
`notes/topology.md` §2.2. `gatewayWgIp` may be empty, host operations run
locally, and bootstrap skips WireGuard. The trust caveat still applies:
co-located accounts share the network namespace, so identity is only IP-trusted
— enable the internal auth socket (§4a) on a one-host instance.

If you converted from a gateway + user-server config, disable the host rows that
are no longer in the instance config (dry run first):

```sh
pnpm hosts-prune            # list
pnpm hosts-prune --apply    # disable
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

### 4a. Internal auth socket (recommended)

`/internal/auth` is the endpoint nginx calls for every routed host. By default
it listens on the app's loopback TCP port, which any local user can also reach
(and, if the app is down, could bind). On a shared host put it on a unix socket
that only nginx and the app user can use:

```sh
sudo cp deploy/kunguru-users.tmpfiles /etc/tmpfiles.d/kunguru-users.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/kunguru-users.conf   # /run/kunguru-users
```

Then add the socket to the instance JSON and restart:

```json
"runtime": { "port": 3030, "host": "127.0.0.1", "authSocket": "/run/kunguru-users/auth.sock" }
```

```sh
systemctl --user restart kunguru-users
pnpm sites-reconcile      # points the gateway's auth subrequest at the socket
```

Verify: the socket answers and the TCP endpoint does not:

```sh
curl -s -o /dev/null -w '%{http_code}\n' --unix-socket /run/kunguru-users/auth.sock \
  -H 'X-Original-Host: users.<base>' http://localhost/internal/auth   # 403/200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3030/internal/auth  # 404
```

The app refuses to start if the path exists and is not a socket; it removes a
stale socket left by a previous run.

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
*.users.kunguru.net    legacy SAN only; nothing is served (no redirects)
```

The `.users.` subtree is retired: those hosts return 404. The SAN may remain in
the existing certificate; it is not used by the renderer.

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
The identity signing key is `data/identity-key.pem` (0600, generated on first
use) — back it up with the database, or clients that pinned its public key must
re-pin the new one.

### Cutover to the two-port model + static sites (one-time)

The alias migration is **destructive** (it drops the `aliases` table), and the
session cookie is now `<base>`-wide, so do these in order:

1. **Back up the DB** before the first start of the new build:
   `cp -a data data.bak-$(date +%F)`.
2. **Handle the hand-managed legacy vhosts** on the gateway (`ops`, `ops-dev`,
   `gitbot`, `tongue-tie-dev`, the `tasks.*` `/api/` locations, the static
   `docs` vhost). Any vhost that proxies without the cookie strip is fail-open
   once the cookie is `<base>`-wide. A vhost that still serves a live app should
   be kept and given the strip rather than removed:

   ```nginx
   proxy_set_header Cookie $kunguru_cookie;   # after X-Forwarded-Proto
   ```

   Remove only vhosts with no listener (`gitbot`, `tongue-tie-dev` did not
   answer). Verify with:
   `grep -L kunguru_cookie /etc/nginx/sites-enabled/*` — only `kunguru-users`
   should be listed.
3. **Recreate the retired proxy alias as an account**: create a group named
   `ops` (it provisions the Linux account, shared home and app slots on the
   owner's host). The migration drops the alias and logs a warning; the hostname
   works again once `ops` is an account. An admin may create the group for
   another account (this is how an account that lives on the user server gets
   its group, since Hermes only runs there):

   ```sh
   curl -X POST -b "kunguru_sid=$SID" -H 'Content-Type: application/json' \
     -d '{"name":"ops","owner":"ndinda"}' https://users.<base>/api/groups
   ```

   The group's app slots (`<group>.<base>`, `<group>-dev.<base>`) are shadowed
   by the legacy vhosts until the app is moved into them; its WebUI
   (`<group>-agent.<base>`) is new and routes immediately.
4. **Move the migrated static site's files**: the migration turns the static
   alias `docs` into a static site for its DB owner, served from
   `/home/<owner>/www/docs`; move the built output there and the source project
   to `/home/<owner>/sites/docs`. Note that a site owned by an account with no
   host account (e.g. the `kunguru` admin, which is not a tenant) cannot be
   routed at all — reassign the label to a provisioned account (`nat` owns
   `docs`) and move the files to that account's host.
5. Start the new build, then read `data/migration-warnings.log` (also printed to
   the service log) to confirm what the alias migration did.
6. `pnpm sites-reconcile`; every enabled host should report `[ok]` (this also
   installs nginx + acl on user servers the first time). Then run **Repair** on
   each existing account once so its app slots (directories + user units) are
   installed.
7. Verify (from the gateway):
   - `<account>.<base>`, `<account>-dev.<base>`, `<account>-agent.<base>`;
   - a public and a `require_auth` static site, signed out and in;
   - `/internal/auth` for a **disabled** owner's site returns 403;
   - `.users.` hosts return 404 (no legacy redirects);
   - `ssh <sshUser>@localhost` works on the gateway (the static reconcile SSHes
     to the gateway host on every site change);
   - no root-owned entries in any non-root home:
     `sudo bash scripts/check-home-ownership.sh` on every host (`--fix` repairs).

### State after the kunguru.net cutover (2026-10-24, updated 2026-10-25)

- Deployed from `main` (the feature branch was fast-forwarded); DB backed up to
  `data.bak-<timestamp>` and `deploy/kunguru-users.tmpfiles` installed (auth
  socket `/run/kunguru-users/auth.sock`, dir `2770 kunguru:www-data`).
- `docs.kunguru.net`: static site owned by `nat` on swan, `require_auth=1` and
  `any_authenticated=1` (any signed-in `<base>` user); source `~/sites/docs`,
  served `~/www/docs` (`deploy-docs.sh` builds there).
- `snacks.kunguru.net`: the `snacks` group (owner `nat`) runs the app in its
  app slot on swan; the app serves `dist/` plus `/api/`, data in
  `~/.local/snacks`; the legacy vhost and user unit are retired.
- `kunguru.net`: apex static site (label `apex`) owned by the `crow` group
  (owner `nat`, members `nat`/`ndinda`), served from `/home/crow/www/apex`
  (source `/home/crow/sites/apex`) with the base-domain certificate.
- `ops`/`ops-dev`: the `ops` group's slots on swan; source checkouts at
  `/home/ops/sites/{ops,ops-dev}.kunguru.net` (prod `main`, dev
  `active-rewrite`), DBs at `~/.local/share/{ops,ops-dev}/` (moved out of the
  deploy dir), old units/vhosts disabled.
- `gitbot`: source moved under `/home/nat/gitbot`; vhost/unit retired.
- Fleet WebUI update: 8/8 accounts are on the pinned fork (`b3caae7`). Disable
  stops an account's app slots (and boot enablement) as well as its agent;
  group enable converges the account again and restarts the agent.
- Ownership invariant: no root-owned entries in non-root homes;
  `scripts/check-home-ownership.sh` is the guard (`--fix` repairs) and the
  provisioning scripts repair the paths they manage.
- Branch state: `kunguru-users` and ops prod are on `main`; ops dev is on
  `active-rewrite`; `snacks` and `kunguru.net` are committed on local `main` but
  **could not be pushed** from drongo (the `github.com-kunguru-net` SSH key is
  an ops-repo deploy key, and the snacks repo has no HTTPS credentials).
  `archive/*-2026-10-25` branches hold the pre-normalization state locally.
- Rollback for the ops move: on drongo re-enable
  `ops.kunguru.net-backend.service` and `ops-dev.kunguru.net-backend.service`
  (`systemctl --user enable --now ...`), re-link their vhosts
  (`ln -s /etc/nginx/sites-available/ops{,-dev}.kunguru.net
  /etc/nginx/sites-enabled/`), reload nginx, and disable the group slots. The
  old trees are intact at `~/sites/ops{,-dev}.kunguru.net`.
- App slot actions mean "run it now" / "stop it": `enable`/`disable` map to
  `systemctl --user enable --now` / `disable --now`.
- Group agents are togglable and **off by default**: `accounts.agent_enabled`
  (0), lazy first enable, then start/stop of gateway + WebUI. Each account also
  has an app-ops bearer token (`~/.config/kunguru-agent.env`, 0640 group) for
  `GET/POST /api/agent/apps…`; the owner's personal agent can operate a group's
  app while the group agent is off.

## Upgrading tenant agents (Hermes / XMPP plugin / WebUI)

`scripts/hermes/ensure.sh` converges each tenant's Hermes install, and
`scripts/webui/ensure.sh` converges the WebUI. The WebUI checkout is pinned to
the `NatTuck/hermes-webui` fork's `kunguru/trusted-user-identity` branch (the
per-turn identity patch; see `notes/webui-identity.md`) until upstream PR
#8522 merges — both this step and the agent-update step reset to that ref via
`WEBUI_REPO`/`WEBUI_REF`. A plain `ensure` keeps the XMPP
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
  site's `require_auth` gate.

**Static sites owned on the gateway host itself** (the admin's accounts) are
served from the gateway vhost's docroot instead of a loopback listener. A
loopback listener would let any local process read a `require_auth` site by
sending the `Host` header directly; the gateway host only gets the directories
and ACLs (`KUNGURU_STATIC_LISTEN=0`).

Side effects of the first reconcile on a user server: `nginx` and `acl` are
installed if missing (nginx is enabled, so Debian's default `:80` vhost starts —
`server_tokens off` is set in the rendered vhosts) and each site's directories
and ACLs are created.

`pnpm sites-reconcile` converges both layers (every host's static listener and
directories, then the gateway routes) from the DB; the app calls the same code
after any account or site change. The gateway is rendered last and is told which
hosts failed, so it never forwards to a listener that is not there.

Provisioning installs each account's two app slots as **user units**
(`app.service`, `app-dev.service`) that run `~/.../run` with the slot port and
bind address; the app's UI shows their state and offers enable/disable/restart/
logs. `HOST` is loopback when the account is on the gateway host and the host's
VPN/LAN address otherwise.

The skill also documents the agent API (`/api/agent/apps…` and
`/api/agent/sites…`) and the per-account token in
`~/.config/kunguru-agent.env`, so an agent can restart its app and manage its
static sites without an operator.

`scripts/hermes/ensure.sh` installs this contract into every tenant as the
`kunguru-sites` skill under `~/.hermes/skills/kunguru-custom/`, embedding the
skill body (the transport pipes a single script over stdin) and generating
`references/local.md` from `KUNGURU_USER_ID`, `KUNGURU_BASE_DOMAIN`,
`KUNGURU_GATEWAY_WG_IP`, `KUNGURU_BIND_ADDR`, and `KUNGURU_TRUSTED_PROXY`
(passed by the `hermes` step in `server/provision.ts`). It supersedes the
retired `kunguru-nginx` / `~/www` / `~/sites` guidance, which should be archived
out of `~/.hermes/skills/` on tenants that still carry it.

