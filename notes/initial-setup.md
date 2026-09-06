
# Initial setup for a new group of servers

How to bring a fresh group of servers to the point where user provisioning can start.
Drives the scripts under `scripts/bootstrap/` (see also `notes/expanded-design.md` →
"Initial-install bootstrap").

## Group model

- One **hub** machine (the public gateway; runs WireGuard hub + nginx + Snikket).
- One or more **lanpeer** machines reachable from the hub over an existing WG peer LAN
  (no local WireGuard) — e.g. `goose` at `10.0.1.2` behind a peer gateway.
- Future direct spokes (`role=peer`) dial the hub with their own WireGuard interface.
- The orchestrator runs from ANY controller with passwordless ssh to the group; it does
  **not** need to be the host the web app runs on.

## Premises

- Each server runs Debian 12/13 and has a `kunguru` account (or one will be created) with
  passwordless sudo and passwordless ssh to the other servers in the group.
- DNS already points the public hostnames at the hub's public IP:
  - Snikket primary `chat.<base>` plus `groups.chat.<base>` and `share.chat.<base>`
    (e.g. `chat.ironbeard.com`, `groups.chat.ironbeard.com`, `share.chat.ironbeard.com`).

## Prerequisites (operator)

1. Controller can `ssh` to each server as an initial sudo user (`INIT_SSH_USER`, e.g.
   `nat`) whose key is already authorized. Add `~/.ssh/config` aliases so the names in
   `HOST_SSH` resolve (ProxyJump etc. lives here, not in the scripts).
2. Decide a Snikket admin/Let's Encrypt email.

## 1. Inventory

```sh
cp scripts/bootstrap/group.conf.example scripts/bootstrap/group.conf   # gitignored
$EDITOR scripts/bootstrap/group.conf
```

Fill at minimum:

| Var | Meaning |
| --- | --- |
| `BOOTSTRAP_SSH_USER` | target account on each server (default `kunguru`) |
| `INIT_SSH_USER` | sudo-capable account used once to grant ssh access |
| `CONTROLLER_SSH_KEY` | this controller's public key to authorize |
| `PUBLIC_IP`, `PUBLIC_FQDN` | hub's public IP and hostname |
| `WG_IFACE/HUB_IP/SUBNET/PORT` | existing hub interface facts (adopted, never rebuilt) |
| `SNIKKET_HOST/DOMAIN/ADMIN_EMAIL` | Snikket host, primary domain, admin email (**email required**) |
| `SNIKKET_TWEAK_*_PORT` | Snikket web ports behind nginx (5080/5443) |
| `HOST_ROLES`, `HOST_SSH`, `HOST_PEER_IP` | per-host role (`hub`/`lanpeer`/`peer`), ssh address, hub-facing IP |

## 2. Inspect before touching

```sh
./scripts/bootstrap/bootstrap.sh --check
```

Prints distro/sudo/wg/docker/nginx/Snikket state for every host (unreachable hosts
show up as such until ssh-access runs).

## 3. Run the bootstrap

Run each step or the whole thing — every step is idempotent and safe to re-run:

```sh
# (a) grant the controller key to kunguru@ on every host (creates kunguru if missing)
./scripts/bootstrap/bootstrap.sh --apply --only ssh-access

# (b) adopt/verify the WireGuard hub + hub->peer reachability
./scripts/bootstrap/bootstrap.sh --apply --only wireguard

# (c) stand up Snikket (installs/starts docker, pulls images, converges /etc/snikket)
./scripts/bootstrap/bootstrap.sh --apply --only snikket

# MANUAL: free host :80/:443 on the hub.
# The scripts never manage other services' containers. If anything else binds
# 80/443 (e.g. a dockerized mail stack that auto-started with the docker daemon),
# stop it and set restart=no yourself before the nginx step, or nginx cannot bind.

# (d) nginx takes over 80/443 (removes the legacy wg DNAT of :80/:443, backs up wg0.conf)
./scripts/bootstrap/bootstrap.sh --apply --only nginx
```

Full idempotent pass (no cert waiting): `./scripts/bootstrap/bootstrap.sh --apply`.

## 4. Certificates

Snikket's own cert-manager is the single ACME owner for the Snikket hostnames; nginx
terminates TLS using those certs. The cert-manager retries on its own schedule (startup +
hourly anacron), so normally nothing to do — wait and then enable HTTPS.

To force **exactly one** attempt right after wiring nginx (never loop — this is a real
Let's Encrypt request):

```sh
ssh kunguru@<hub> "docker exec snikket-certs /bin/bash /etc/cron.daily/certbot"
```

When the live cert exists, converge nginx to the HTTPS vhost (idempotent):

```sh
./scripts/bootstrap/bootstrap.sh --apply --only nginx        # or: --apply --wait-certs
```

## 5. Verify

```sh
curl -sI  https://chat.ironbeard.com/          # 301/302 from nginx -> Snikket portal
echo | openssl s_client -servername chat.ironbeard.com -connect chat.ironbeard.com:443 \
  | openssl x509 -noout -subject -dates        # CN=chat.ironbeard.com
./scripts/bootstrap/bootstrap.sh --check
```

## 6. Snikket admin account

Snikket creates its admin via an invitation link (mailed/served by the container). To
print one:

```sh
docker exec snikket create-invite --admin --group default
```

## Rollback / recovery notes

- Before the nginx step, `ensure-nginx` saved the original WireGuard config at
  `/etc/wireguard/wg0.conf.bootstrap.bak` and only stripped the :80/:443 DNAT commands
  (MASQUERADE/forwarding and peers are untouched). Restore the backup + re-add the
  `iptables -t nat -A PREROUTING ... --dport 80/443 ... DNAT` rules to undo the cutover.
- Snikket is plain Docker under `/etc/snikket` (`docker compose up -d` / `down`).
- nginx config lives in `/etc/nginx/sites-available/snikket-<domain>` and
  `kunguru-reject-https` (the latter rejects unknown HTTPS SNI).
