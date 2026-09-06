
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

## 5. nginx reverse proxy (`https://users.<domain>/`)

On the gateway (otter), as root — nginx already owns 80/443 here.

```sh
install -m 0644 deploy/nginx-users.conf /etc/nginx/sites-available/kunguru-users
ln -s /etc/nginx/sites-available/kunguru-users /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d users.ironbeard.com --agree-tos -m nat@ferrus.net -n
```

DNS must point `users.<domain>` at the gateway's public IP before certbot runs.

## 6. Verify

```sh
curl -sI https://users.ironbeard.com/                    # 200, SPA
curl -s  https://users.ironbeard.com/api/auth/me          # 401 (unauth)
# log in as kunguru, create a user on goose, check the job log in the UI.
```

## Upgrading

```sh
cd ~/.local/apps/kunguru-users
git pull --ff-only
mise install                      # no-op unless the pinned node changed
pnpm install --frozen-lockfile
pnpm build
systemctl --user restart kunguru-users
```

Database lives in `<checkout>/data/` (gitignored) and is preserved across pulls.
