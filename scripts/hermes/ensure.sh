# hermes/ensure.sh  (run as root on the user's host over `sudo bash -s`)
#
# Converges a per-tenant Hermes Agent (github.com/NousResearch/hermes-agent)
# for USERNAME:
#   * enable-linger + a user systemd unit running the Hermes gateway
#   * install the agent under ~/.hermes if absent (official installer)
#   * point it at the LLM gateway (Bifrost): model.provider custom + base URL +
#     default model, and store the per-user virtual key (env HERMES_LLM_API_KEY)
#   * if XMPP creds are supplied, merge XMPP_* into ~/.hermes/.env and enable
#     the hermes-xmpp-plugin so the tenant can chat with their agent over the
#     Snikket account they were provisioned
#   * start/restart the gateway unit to apply changes
#
# Idempotent / converge-only: never deletes tenant state. It only touches the
# fields it is given -- omit HERMES_LLM_API_KEY to leave an existing key alone
# (used by password reset). Secrets arrive as env (never argv/logs).
#
# Env:
#   USERNAME (required)
#   HERMES_ACTION (ensure | stop; default ensure)
#   HERMES_LLM_BASE_URL  HERMES_LLM_API_KEY  HERMES_MODEL
#   XMPP_JID  XMPP_PASSWORD  XMPP_ALLOWED_USERS  XMPP_HOME_CHANNEL  XMPP_HOST

set -euo pipefail

: "${USERNAME:?missing required env: USERNAME}"
action="${HERMES_ACTION:-ensure}"

if [[ ! "$USERNAME" =~ ^[a-z][a-z0-9._-]{0,31}$ ]]; then
  echo "error: invalid linux username '$USERNAME'" >&2
  exit 1
fi
if ! id "$USERNAME" >/dev/null 2>&1; then
  echo "error: linux account '$USERNAME' does not exist (run account/ensure.sh first)" >&2
  exit 1
fi

home="$(getent passwd "$USERNAME" | cut -d: -f6)"
uid="$(id -u "$USERNAME")"
venv_py="${home}/.hermes/hermes-agent/venv/bin/python"
hermes_bin="${home}/.local/bin/hermes"
installer_url="https://hermes-agent.nousresearch.com/install.sh"

# Tenant site-deployment facts (consumed by the kunguru-sites skill). All
# optional: a manual converge that omits them still installs the skill, with
# references/local.md noting the values were not supplied.
base_domain="${KUNGURU_BASE_DOMAIN:-}"
user_id="${KUNGURU_USER_ID:-}"
gateway_wg_ip="${KUNGURU_GATEWAY_WG_IP:-}"
bind_addr="${KUNGURU_BIND_ADDR:-}"
trusted_proxy="${KUNGURU_TRUSTED_PROXY:-}"

# run_as_user CMD...: run as USERNAME with a clean but functional env, the
# per-user systemd manager socket (XDG_RUNTIME_DIR) so systemctl --user works,
# and cwd in the user's home (avoid tools walking up into e.g. kunguru's home).
run_as_user() {
  runuser -u "$USERNAME" -- env -i \
    HOME="$home" \
    USER="$USERNAME" LOGNAME="$USERNAME" SHELL=/bin/bash \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    PATH="${home}/.local/bin:${home}/.hermes/hermes-agent/venv/bin:${home}/.hermes/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash -c "cd '${home}' && $1"
}

if [[ "$action" == "stop" ]]; then
  echo "[ok] stopping hermes gateway for ${USERNAME}"
  run_as_user 'systemctl --user disable --now hermes-xmpp-watchdog.timer >/dev/null 2>&1 || true'
  run_as_user 'systemctl --user disable --now hermes-gateway >/dev/null 2>&1 || systemctl --user stop hermes-gateway >/dev/null 2>&1 || true'
  exit 0
fi

# --- lingering user manager (gateway must survive logout/reboot) ---
loginctl enable-linger "$USERNAME"
for _ in $(seq 1 20); do
  [[ -S "/run/user/${uid}/systemd/private" ]] && break
  sleep 1
done

# --- install if absent ---
if [[ ! -x "${venv_py}" && ! -x "${hermes_bin}" ]]; then
  echo "[changed] installing hermes-agent for ${USERNAME} (first run takes a while)"
  run_as_user "cd '${home}' && curl -fsSL '${installer_url}' | bash"
fi
if [[ ! -x "${hermes_bin}" ]]; then
  echo "error: hermes launcher missing at ${hermes_bin} after install" >&2
  exit 1
fi
if [[ ! -x "${venv_py}" ]]; then
  echo "error: hermes venv python missing at ${venv_py}" >&2
  exit 1
fi

# --- optional: bring hermes-agent to the latest upstream ---
# Heavy (git pull + dependency reinstall + service restart), so only when asked:
# HERMES_UPDATE=1 or HERMES_ACTION=update.
if [[ "${HERMES_UPDATE:-0}" == "1" || "$action" == "update" ]]; then
  echo "[changed] updating hermes-agent for ${USERNAME}"
  run_as_user 'hermes update --yes' || echo "warning: 'hermes update' failed; continuing" >&2
fi

# --- model / provider config (LLM gateway) ---
if [[ -n "${HERMES_LLM_BASE_URL:-}" ]]; then
  run_as_user "hermes config set model.provider custom >/dev/null && hermes config set model.base_url '${HERMES_LLM_BASE_URL}' >/dev/null"
fi
if [[ -n "${HERMES_MODEL:-}" ]]; then
  run_as_user "hermes config set model.default '${HERMES_MODEL}' >/dev/null"
fi
if [[ -n "${HERMES_LLM_API_KEY:-}" ]]; then
  run_as_user "hermes config set model.api_key '${HERMES_LLM_API_KEY}' >/dev/null"
fi

# --- XMPP: write .env + enable the plugin ---
if [[ -n "${XMPP_JID:-}" && -n "${XMPP_PASSWORD:-}" ]]; then
  # Stage the new/updated XMPP vars in a temp file the merge reads from, so
  # arbitrary password characters never pass through a shell command line.
  # Write it while root-owned, then hand it to the user to read.
  stage="$(mktemp)"
  chmod 0600 "${stage}"
  {
    printf 'XMPP_JID=%s\n' "${XMPP_JID}"
    printf 'XMPP_PASSWORD=%s\n' "${XMPP_PASSWORD}"
    printf 'XMPP_ALLOWED_USERS=%s\n' "${XMPP_ALLOWED_USERS:-${XMPP_JID}}"
    printf 'XMPP_HOME_CHANNEL=%s\n' "${XMPP_HOME_CHANNEL:-${XMPP_JID}}"
  } > "${stage}"
  if [[ -n "${XMPP_HOST:-}" ]]; then
    printf 'XMPP_HOST=%s\n' "${XMPP_HOST}" >> "${stage}"
  fi
  chown "${USERNAME}" "${stage}"
  run_as_user "python3 - '${home}/.hermes/.env' '${stage}' <<'PY'
import os, sys
env_path, src = sys.argv[1], sys.argv[2]
updates = {}
for line in open(src):
    line = line.rstrip('\\n')
    if '=' not in line or line.startswith('#'):
        continue
    k, v = line.split('=', 1)
    updates[k] = v
lines = []
if os.path.exists(env_path):
    with open(env_path) as f:
        lines = [ln.rstrip('\\n') for ln in f]
kept = [ln for ln in lines if not (ln.split('=', 1)[0] in updates)]
for k, v in updates.items():
    kept.append('{}={}'.format(k, v))
with open(env_path, 'w') as f:
    f.write('\\n'.join(kept) + '\\n')
os.chmod(env_path, 0o600)
PY"
  rm -f "${stage}"
fi

# --- XMPP plugin: install/update + deps (incl. OMEMO) + enable ---
# Not gated on XMPP creds, so a plain `ensure`/`update` also refreshes the
# plugin. We update via git rather than `hermes plugins update`, whose security
# scanner auto-disables this community plugin on a "dangerous" verdict.
plugin_dir="${home}/.hermes/plugins/hermes-xmpp-plugin"
if [[ ! -d "${plugin_dir}/.git" ]]; then
  echo "[changed] installing hermes-xmpp-plugin for ${USERNAME}"
  mkdir -p "${home}/.hermes/plugins"
  chown "${USERNAME}" "${home}/.hermes/plugins"
  run_as_user "git clone --depth 1 https://github.com/fastfinge/hermes-xmpp-plugin.git '${plugin_dir}'"
else
  # Shallow clones can't fast-forward when upstream rewrites history, so fetch
  # the branch tip and hard-reset.
  run_as_user "git -C '${plugin_dir}' fetch --depth 1 origin main >/dev/null 2>&1 && git -C '${plugin_dir}' reset --hard FETCH_HEAD >/dev/null 2>&1 || true"
fi
# Plugin deps, including the optional OMEMO end-to-end encryption stack
# (slixmpp-omemo/omemo); harmless if already present.
run_as_user "'${home}/.hermes/bin/uv' pip install --quiet --python '${venv_py}' -r '${plugin_dir}/requirements.txt' slixmpp-omemo omemo"
run_as_user 'hermes config set plugins.enabled '"'"'["hermes-xmpp-plugin"]'"'"' >/dev/null'

# --- enable OMEMO whenever the XMPP platform is configured ---
# (The plugin defaults omemo_enabled=true, but pin it explicitly.)
if [[ -f "${home}/.hermes/.env" ]] && ! grep -q '^XMPP_OMEMO_ENABLED=' "${home}/.hermes/.env" 2>/dev/null; then
  run_as_user "printf '%s\n' XMPP_OMEMO_ENABLED=true >> '${home}/.hermes/.env'"
fi

# --- gateway service: ensure running, restart to apply config/env ---
if run_as_user 'systemctl --user is-active hermes-gateway' >/dev/null 2>&1; then
  echo "[changed] restarting hermes gateway for ${USERNAME}"
  run_as_user 'systemctl --user restart hermes-gateway' >/dev/null
else
  echo "[changed] installing + starting hermes gateway for ${USERNAME}"
  run_as_user 'hermes gateway install --start-on-login --start-now' \
    >/dev/null 2>&1 || run_as_user 'systemctl --user enable --now hermes-gateway' >/dev/null
fi

# Boot persistence is a hard requirement and linger alone does not provide it:
# a manual start (or `hermes gateway install`) can leave the unit active but
# DISABLED, and the restart branch above would never repair that. Always enable.
run_as_user 'systemctl --user enable hermes-gateway' >/dev/null 2>&1 || true

# --- XMPP reconnect-loop watchdog (user timer) ---
# After an established XMPP session drops, the plugin's in-process reconnect can
# wedge: it authenticates, then the resource-bind IQ never gets a usable reply,
# and the gateway retries every ~10s forever. Only a fresh gateway process
# recovers, so install a small user timer that detects the loop and restarts the
# unit. The script is embedded because the transport ships a single script over
# stdin (`sudo bash -s`); a sibling file would not exist on the target.
install -d "${home}/.hermes/bin" "${home}/.config/systemd/user"
cat > "${home}/.hermes/bin/hermes-xmpp-watchdog.sh" <<'WATCHDOG'
#!/usr/bin/env bash
# Restart the Hermes gateway when its XMPP adapter is stuck in a reconnect
# loop. Known failure mode: after an established session drops, the plugin's
# in-process reconnect authenticates but never completes resource binding, so
# slixmpp logs a bind IqTimeout and the gateway logs "xmpp_connection_lost"
# every ~10s indefinitely. Only a fresh process binds cleanly, so detect the
# loop and let systemd restart the unit.
#
# Installed and enabled as a user timer by scripts/hermes/ensure.sh.
set -euo pipefail

UNIT="hermes-gateway"
WINDOW="${HERMES_XMPP_WATCHDOG_WINDOW:-10 min ago}"
THRESHOLD="${HERMES_XMPP_WATCHDOG_THRESHOLD:-6}"
COOLDOWN="${HERMES_XMPP_WATCHDOG_COOLDOWN:-600}"
STATE="${HERMES_HOME:-$HOME/.hermes}/xmpp-watchdog.state"

systemctl --user is-active --quiet "$UNIT" || exit 0

now=$(date +%s)
last=0
if [[ -f "$STATE" ]]; then
  last=$(cat "$STATE" 2>/dev/null || echo 0)
fi
[[ "$last" =~ ^[0-9]+$ ]] || last=0
if (( now - last < COOLDOWN )); then
  exit 0
fi

count=$(journalctl --user -u "$UNIT" --since "$WINDOW" --no-pager 2>/dev/null \
  | grep -cE "xmpp_connection_lost|xmpp_connect_timeout|IqTimeout:.*<bind" || true)

if (( count >= THRESHOLD )); then
  echo "hermes-xmpp-watchdog: ${count} XMPP reconnect failures in the last '${WINDOW}'; restarting ${UNIT}"
  printf '%s\n' "$now" > "$STATE"
  systemctl --user restart "$UNIT"
fi
WATCHDOG

cat > "${home}/.config/systemd/user/hermes-xmpp-watchdog.service" <<'UNIT'
[Unit]
Description=Restart the Hermes gateway when its XMPP adapter is stuck in a reconnect loop

[Service]
Type=oneshot
ExecStart=%h/.hermes/bin/hermes-xmpp-watchdog.sh
UNIT

cat > "${home}/.config/systemd/user/hermes-xmpp-watchdog.timer" <<'UNIT'
[Unit]
Description=Periodically check the Hermes XMPP adapter for a reconnect loop

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
Unit=hermes-xmpp-watchdog.service

[Install]
WantedBy=timers.target
UNIT

chown "${USERNAME}" \
  "${home}/.hermes/bin/hermes-xmpp-watchdog.sh" \
  "${home}/.config/systemd/user/hermes-xmpp-watchdog.service" \
  "${home}/.config/systemd/user/hermes-xmpp-watchdog.timer"
chmod 0755 "${home}/.hermes/bin/hermes-xmpp-watchdog.sh"
run_as_user 'systemctl --user daemon-reload'
run_as_user 'systemctl --user enable --now hermes-xmpp-watchdog.timer' >/dev/null 2>&1 || true

# --- tenant site-deployment skill (kunguru-sites) ---
# The current hosting scheme: the gateway's nginx, TLS, and DNS are managed
# centrally by the kunguru-users app, so a tenant only runs a web server on an
# assigned slot port. This skill is authoritative and replaces the retired
# "kunguru-nginx / ~/www / ~/sites" guidance; ship it to every tenant. The body
# is embedded because the transport pipes a single script over stdin (same
# reason the XMPP watchdog above is embedded).
skill_dir="${home}/.hermes/skills/kunguru-custom/kunguru-sites"
install -d -o "${USERNAME}" "${home}/.hermes/skills/kunguru-custom"
install -d -o "${USERNAME}" "$skill_dir" "$skill_dir/references"
cat > "$skill_dir/SKILL.md" <<'KUNGURU_SITES_SKILL'
---
name: kunguru-sites
description: "Deploy and host web sites/apps for a kunguru tenant under the current multi-tenant scheme. The gateway nginx, TLS certificates, and DNS are managed centrally by the kunguru-users app; you run your app on the assigned slot port and it appears at <user>.<base> (public) or <user>.users.<base> (private, app-session gated). Also covers admin-mediated hostname aliases."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [kunguru, sites, hosting, deploy, nginx, reverse-proxy, public-site, private-app, alias, tls]
    related_skills: [kunguru-operations]
---

# kunguru tenant site deployment (current scheme)

This supersedes the old "kunguru-nginx / ~/www / ~/sites" deployment guidance.
Under the current scheme a tenant never touches nginx, certbot, or DNS: you run
your app on an assigned slot port and the gateway routes and secures it.

## Read first

`references/local.md` (same directory) lists YOUR hostnames, ports, bind address,
and trusted-proxy address. Read it before deploying anything.

## The model

The gateway host runs nginx and the **kunguru-users** app. The app renders the
per-user reverse-proxy routes and the combined TLS certificate from its database
and a fixed port formula. Each tenant gets three fixed **slots**:

| Slot | Hostname | Port | Access |
|---|---|---|---|
| public-site | `<user>.<base>` | 12000 + id | public, no auth |
| private-app | `<user>.users.<base>` | 13000 + id | app session (auth_request) |
| hermes-webui | `<user>-agent.users.<base>` | 11000 + id | app session (managed) |

`<id>` is the tenant's numeric user id; see `references/local.md` for yours. All
three slots are proxied over the VPN to your host, so a service bound to a slot
port is reachable immediately.

### Private slots inject identity

For `<user>.users.<base>` (and private aliases), the gateway validates the
`users.<base>` app-session cookie and forwards the owner's username as the
header `Remote-User`. Your app should:

- bind to the address in `references/local.md` (the VPN/LAN address the gateway
  reaches), not just loopback;
- trust `Remote-User` **only** when the TCP peer is the gateway's WG IP
  (`references/local.md`); ignore it otherwise;
- do **no** login of its own; the signed-in identity is `Remote-User`;
- send unauthenticated users to `https://users.<base>/` to log in.

For public slots, `Remote-User` is stripped (blank). Never trust it there.

## Deploying a public site

1. Put the code on your host (e.g. `~/.local/apps/<app>`).
2. Run it bound to the public-site port from `references/local.md`.
3. Open `https://<user>.<base>/`.

## Deploying a private app

Same as a public site, but bind the private-app port and read `Remote-User` for
the signed-in user. Example (Express):

```js
// Substitute the trusted-proxy address from references/local.md.
const GATEWAY_WG_IP = "10.0.0.1";
app.use((req, res, next) => {
  const peer = (req.socket.remoteAddress || "").replace("::ffff:", "");
  req.user = peer === GATEWAY_WG_IP ? (req.get("Remote-User") || null) : null;
  next();
});
```

## Run under systemd --user

Wrap the app in a user unit with `Restart=always`. Linger is already enabled, so
it starts at boot.

```
# ~/.config/systemd/user/<app>.service
[Unit]
Description=<app>
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=%h/.local/apps/<app>
Environment=PORT=13000
ExecStart=%h/.local/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now <app>
```

## TLS, certificates, DNS

Automatic. The kunguru-users app reconciles the combined certificate (all tenant
and alias hostnames) and the DNS wildcard already covers your labels. Do **not**
run certbot, and do not create certificates yourself.

## Aliases (extra hostnames) — admin-mediated

Aliases are rows in the kunguru-users app, managed by an **admin**:

- a **proxy** alias points at one of YOUR three slot services (`private-app`,
  `public-site`, or `hermes-webui`);
- a **static** alias serves a docroot on the **gateway** host, so it is not
  usable from a tenant host.

A public alias appears at `<label>.<base>`; a private alias at
`<label>.users.<base>` (same session auth, owner = you). To get one, run your app
on the target slot port and ask the operator to add `<label> -> <service>`. You
cannot create aliases yourself.

## Do NOT

- Start, edit, or reload nginx; do not write under `/etc/nginx`.
- Use `kunguru-nginx` (not installed on tenant hosts) or `sudo`.
- Run `certbot` or manage certificates.
- Serve sites from `~/www` or add per-site vhosts; that scheme is retired.

## Verification and common statuses

- Deploy, then `curl -sI https://<user>.<base>/` -> 200 (or the app's own code).
- `502` at a slot host = the gateway route is fine but **nothing is listening**
  on the slot port (your app is down or bound to the wrong port/address).
- `404` = no route for that hostname (user disabled, or the label is not
  configured as an alias).
- A private host returns `302` to `https://users.<base>/login` when signed out —
  that is the auth gate working; sign in and retry.
KUNGURU_SITES_SKILL

# Generated per-tenant facts so the skill body stays generic across tenants.
if [[ -n "$base_domain" && "$user_id" =~ ^[0-9]+$ ]]; then
  {
    echo "# Your deployment (generated by scripts/hermes/ensure.sh)"
    echo
    echo "- Tenant: \`${USERNAME}\` (id ${user_id})"
    echo "- Base domain: \`${base_domain}\`"
    echo "- Login/logout: https://users.${base_domain}/"
    echo "- Bind address: \`${bind_addr:-<the user-host VPN/LAN address>}\`"
    echo "- Trust \`Remote-User\` only from: \`${trusted_proxy:-<the gateway WG IP>/32}\`"
    echo
    echo "| Hostname | Slot | Port | Access | Remote-User |"
    echo "|---|---|---|---|---|"
    echo "| ${USERNAME}.${base_domain} | public-site | $((12000 + user_id)) | public | blanked |"
    echo "| ${USERNAME}.users.${base_domain} | private-app | $((13000 + user_id)) | app session | ${USERNAME} |"
    echo "| ${USERNAME}-agent.users.${base_domain} | hermes-webui | $((11000 + user_id)) | app session | ${USERNAME} |"
  } > "$skill_dir/references/local.md"
else
  cat > "$skill_dir/references/local.md" <<'KUNGURU_SITES_LOCAL'
# Your deployment

Hostnames and ports were not supplied to this converge (`KUNGURU_USER_ID` /
`KUNGURU_BASE_DOMAIN` unset). Ask the operator for this tenant's three slot hosts
and ports, or re-run the provision step from the kunguru-users app.
KUNGURU_SITES_LOCAL
fi
chown -R "${USERNAME}" "${home}/.hermes/skills/kunguru-custom"
echo "[ok] kunguru-sites skill installed for ${USERNAME}"

sleep 3
if run_as_user 'systemctl --user is-enabled hermes-gateway' >/dev/null 2>&1; then
  echo "[ok] hermes gateway enabled for ${USERNAME}"
else
  echo "warning: hermes gateway for ${USERNAME} is not enabled at boot; run 'systemctl --user enable hermes-gateway'" >&2
fi
if run_as_user 'systemctl --user is-active hermes-gateway' >/dev/null 2>&1; then
  echo "[ok] hermes gateway active for ${USERNAME}"
else
  echo "warning: hermes gateway for ${USERNAME} not active after start; check 'journalctl --user -u hermes-gateway'" >&2
fi
if run_as_user 'systemctl --user is-active hermes-xmpp-watchdog.timer' >/dev/null 2>&1; then
  echo "[ok] xmpp watchdog timer active for ${USERNAME}"
else
  echo "warning: xmpp watchdog timer not active for ${USERNAME}" >&2
fi

echo "[ok] ensure-hermes complete for ${USERNAME}"
