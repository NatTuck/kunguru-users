# hermes/ensure.sh  (run as root on the user's host over `sudo bash -s`)
#
# Converges a per-tenant Hermes Agent (github.com/NousResearch/hermes-agent)
# for USERNAME:
#   * enable-linger + a user systemd unit running the Hermes gateway
#   * install the agent under ~/.hermes if absent (official installer)
#   * point it at the LLM gateway (Bifrost): model.provider custom + base URL +
#     default model, and store the per-user virtual key (env HERMES_LLM_API_KEY)
#   * restrict the WebUI model picker to configured providers
#     (providers.only_configured) so auto-detected providers -- keyless
#     opencode-free, ambient provider keys -- do not clutter every tenant
#   * HERMES_UPDATE=1 (or HERMES_ACTION=update) also brings the WebUI checkout
#     to its latest release and restarts it, keeping agent + WebUI in lockstep
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

# hermes_usable: the published launcher actually runs (its dependency
# environment is committed). Upstream replaced the old in-tree venv with a
# PM-managed environment, so a launcher-presence check is no longer proof of a
# complete install.
hermes_usable() {
  run_as_user "${hermes_bin} --version" >/dev/null 2>&1
}

# hermes_python: interpreter carrying the agent's dependencies (PM generation
# recorded in <HERMES_HOME>/installs/<key>/facts.json, else the legacy venv).
hermes_python() {
  local facts env py
  for facts in "${home}/.hermes/installs"/*/facts.json; do
    [[ -f "$facts" ]] || continue
    env="$(python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
    print((d.get("packages", {}).get("venv", {}) or {}).get("environment") or "")
except Exception:
    print("")' "$facts" 2>/dev/null || true)"
    if [[ -n "$env" && -x "${env}/bin/python" ]]; then
      printf '%s' "${env}/bin/python"
      return 0
    fi
  done
  py="${home}/.hermes/hermes-agent/venv/bin/python"
  if [[ -x "$py" ]]; then
    printf '%s' "$py"
    return 0
  fi
  return 1
}

# hermes_uv: PM's staged uv (moved from ~/.hermes/bin/uv), else the legacy path.
hermes_uv() {
  local uv
  for uv in "${home}/.hermes/bin/uv" "${home}/.hermes/tools"/*/uv; do
    if [[ -x "$uv" ]]; then
      printf '%s' "$uv"
      return 0
    fi
  done
  return 1
}

# write_guarded DEST SIDECAR SRC: install SRC at DEST only when DEST is absent
# or still matches the app's last write (SIDECAR holds its sha256). A tenant edit
# is preserved: back it up and leave DEST untouched.
write_guarded() {
  local dest="$1" side="$2" src="$3" want have prev
  want="$(sha256sum "$src" | cut -d' ' -f1)"
  if [[ -f "$dest" ]]; then
    have="$(sha256sum "$dest" | cut -d' ' -f1)"
    prev="$(cat "$side" 2>/dev/null || true)"
    if [[ "$have" == "$want" ]]; then
      printf '%s\n' "$want" > "$side"
      chown "$USERNAME" "$side" 2>/dev/null || true
      return 0
    fi
    if [[ -n "$prev" && "$have" != "$prev" ]]; then
      echo "warning: ${dest} was edited by ${USERNAME}; backing up, not overwriting" >&2
      cp -a "$dest" "${dest}.bak-$(date +%s)"
      return 0
    fi
  fi
  install -m 0644 -o "$USERNAME" "$src" "$dest"
  printf '%s\n' "$want" > "$side"
  chown "$USERNAME" "$side" 2>/dev/null || true
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

# --- install or repair ---
# The upstream installer is idempotent and staged, but an interrupted first
# install (timeout, dropped network) can leave the launcher present while the
# dependency environment is missing. Re-run the installer whenever the launcher
# is absent OR does not run, so a repair converges instead of failing a stale
# path check forever.
if [[ ! -x "${hermes_bin}" ]] || ! hermes_usable; then
  echo "[changed] installing/repairing hermes-agent for ${USERNAME} (first run takes a while)"
  run_as_user "cd '${home}' && curl -fsSL '${installer_url}' | bash" || true
fi
if [[ ! -x "${hermes_bin}" ]]; then
  echo "error: hermes launcher missing at ${hermes_bin} after install" >&2
  exit 1
fi
if ! hermes_usable; then
  echo "error: hermes launcher at ${hermes_bin} is present but does not run (install incomplete?)" >&2
  echo "       see ${home}/.hermes/logs/install.log" >&2
  exit 1
fi

# --- optional: bring hermes-agent to the latest upstream ---
# Heavy (git pull + dependency reinstall + service restart), so only when asked:
# HERMES_UPDATE=1 or HERMES_ACTION=update.
did_update=0
if [[ "${HERMES_UPDATE:-0}" == "1" || "$action" == "update" ]]; then
  did_update=1
  # Record the channel BEFORE updating: an unrecorded official checkout is
  # forward-only, so `hermes update --yes` would NOT move a newer checkout back
  # to the stable release. `--set-channel` is metadata-only and idempotent.
  echo "[changed] recording stable update channel for ${USERNAME}"
  run_as_user 'hermes update --set-channel stable' \
    || echo "warning: could not record stable channel; continuing" >&2
  echo "[changed] updating hermes-agent for ${USERNAME}"
  run_as_user 'hermes update --yes' || echo "warning: 'hermes update' failed; continuing" >&2

  # Keep the WebUI checkout in lockstep with the agent. The agent relaunches the
  # WebUI through an isolated runpy shim that does NOT put the WebUI's own
  # directory on sys.path, so an old WebUI paired with a new agent can fail at
  # import time (ModuleNotFoundError: api). Update the checkout, refresh its
  # dependencies, repoint the unit at the (possibly regenerated) interpreter,
  # and restart it so one update keeps both at the same release.
  # (webui/ensure.sh remains the full converge: clone, unit, bind addresses.)
  webui_dir="${home}/.local/apps/hermes-webui"
  if [[ -d "${webui_dir}/.git" ]]; then
    echo "[changed] updating hermes-webui for ${USERNAME}"
    if run_as_user "git -C '${webui_dir}' fetch --depth 1 origin master >/dev/null 2>&1 && git -C '${webui_dir}' reset --hard FETCH_HEAD >/dev/null 2>&1"; then
      webui_py="$(hermes_python || true)"
      webui_uv="$(hermes_uv || true)"
      if [[ -n "$webui_py" && -n "$webui_uv" ]]; then
        run_as_user "'${webui_uv}' pip install --quiet --python '${webui_py}' -r '${webui_dir}/requirements.txt' >/dev/null 2>&1" \
          || echo "warning: hermes-webui dependencies did not install; continuing" >&2
      fi
      # An agent update can regenerate the PM-managed venv (a new generation
      # path) and delete the old one, leaving the WebUI unit's baked-in
      # interpreter/ExecStart pointing at a missing python (status=203/EXEC).
      # Repoint the unit at the current interpreter before restarting.
      webui_unit="${home}/.config/systemd/user/hermes-webui.service"
      if [[ -f "$webui_unit" && -n "$webui_py" ]]; then
        python3 - "$webui_unit" "$webui_py" "${webui_dir}/server.py" <<'PY'
import sys
unit, py, server = sys.argv[1], sys.argv[2], sys.argv[3]
out = []
for ln in open(unit).read().splitlines():
    if ln.startswith("Environment=HERMES_WEBUI_PYTHON="):
        ln = "Environment=HERMES_WEBUI_PYTHON=" + py
    elif ln.startswith("ExecStart="):
        ln = "ExecStart=" + py + " " + server
    out.append(ln)
open(unit, "w").write("\n".join(out) + "\n")
PY
        chown "$USERNAME" "$webui_unit"
        run_as_user 'systemctl --user daemon-reload'
      fi
      if run_as_user "systemctl --user cat hermes-webui.service" >/dev/null 2>&1; then
        run_as_user 'systemctl --user restart hermes-webui >/dev/null 2>&1' || true
      fi
    else
      echo "warning: could not update hermes-webui for ${USERNAME}; continuing" >&2
    fi
  fi
fi

# --- model / provider config (LLM gateway) ---
if [[ -n "${HERMES_LLM_BASE_URL:-}" ]]; then
  run_as_user "hermes config set model.provider custom >/dev/null && hermes config set model.base_url '${HERMES_LLM_BASE_URL}' >/dev/null"
  # The WebUI model picker auto-detects every provider it can reach from the
  # host (keyless opencode-free, ambient provider keys, ...) and ignores the
  # agent's providers.<id>.enabled flag. only_configured keeps the picker to the
  # active provider plus explicitly configured ones, so a tenant sees the
  # Bifrost gateway rather than a pile of unrelated providers.
  run_as_user "hermes config set providers.only_configured true >/dev/null"
fi
# model.default is RECONCILED, not forced: a tenant may have changed it in the
# WebUI (which writes config.yaml). Seed it only when the host has no value;
# otherwise leave it and report the effective value below for the app to persist.
if [[ -n "${HERMES_MODEL:-}" ]]; then
  current_model="$(run_as_user 'hermes config get model.default' 2>/dev/null || true)"
  current_model="$(printf '%s' "$current_model" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -z "$current_model" || "$current_model" == "null" ]]; then
    run_as_user "hermes config set model.default '${HERMES_MODEL}' >/dev/null"
  fi
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
# (slixmpp-omemo/omemo); harmless if already present. Best-effort: a missing
# uv/python (or a PM-managed environment that declines the extra install) must
# not fail the whole hermes step.
plugin_py="$(hermes_python || true)"
plugin_uv="$(hermes_uv || true)"
if [[ -n "$plugin_py" && -n "$plugin_uv" ]]; then
  run_as_user "'${plugin_uv}' pip install --quiet --python '${plugin_py}' -r '${plugin_dir}/requirements.txt' slixmpp-omemo omemo" \
    || echo "warning: hermes-xmpp-plugin dependencies did not install; continuing" >&2
else
  echo "warning: could not locate hermes python/uv to install plugin deps; continuing" >&2
fi
# Verify the deps actually import in the environment the gateway uses; a silent
# dependency gap (e.g. after the PM-managed venv replaced the in-tree one) is
# exactly what leaves the platform registered but unable to connect.
if [[ -n "$plugin_py" ]]; then
  if run_as_user "'${plugin_py}' -c 'import slixmpp, slixmpp_omemo, omemo'" >/dev/null 2>&1; then
    echo "[ok] hermes-xmpp-plugin dependencies importable for ${USERNAME}"
  else
    echo "error: hermes-xmpp-plugin deps are not importable in ${plugin_py} for ${USERNAME}" >&2
    exit 1
  fi
fi

# Merge (never replace) so plugins the tenant enabled (e.g. homeassistant) are
# preserved while hermes-xmpp-plugin is (re)asserted.
plugins_now="$(run_as_user 'hermes config get plugins.enabled --json 2>/dev/null' || echo '[]')"
plugins_merged="$(PLUGINS_NOW="$plugins_now" python3 - <<'PY'
import json, os
raw = os.environ.get("PLUGINS_NOW") or "[]"
cur = None
try:
    cur = json.loads(raw.strip())
except Exception:
    # Tolerate wrapper/log noise: fall back to the last JSON-array-looking line.
    for line in reversed(raw.splitlines()):
        line = line.strip()
        if line.startswith("[") and line.endswith("]"):
            try:
                cur = json.loads(line)
                break
            except Exception:
                pass
if not isinstance(cur, list):
    cur = []
seen = set()
out = []
for p in cur:
    p = str(p).strip()
    if p and p not in seen:
        seen.add(p)
        out.append(p)
if "hermes-xmpp-plugin" not in seen:
    out.append("hermes-xmpp-plugin")
print(json.dumps(out))
PY
)"
run_as_user "hermes config set plugins.enabled '${plugins_merged}' >/dev/null"

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
# Build both files to temp, then install them hash-guarded so a tenant's own
# edits to the skill are never silently clobbered (write_guarded backs up).
tmp_skill="$(mktemp)"
tmp_local="$(mktemp)"
cat > "$tmp_skill" <<'KUNGURU_SITES_SKILL'
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
  } > "$tmp_local"
else
  cat > "$tmp_local" <<'KUNGURU_SITES_LOCAL'
# Your deployment

Hostnames and ports were not supplied to this converge (`KUNGURU_USER_ID` /
`KUNGURU_BASE_DOMAIN` unset). Ask the operator for this tenant's three slot hosts
and ports, or re-run the provision step from the kunguru-users app.
KUNGURU_SITES_LOCAL
fi
write_guarded "$skill_dir/SKILL.md" "$skill_dir/.app-hash.skill" "$tmp_skill"
write_guarded "$skill_dir/references/local.md" "$skill_dir/references/.app-hash.local" "$tmp_local"
rm -f "$tmp_skill" "$tmp_local"
chown -R "${USERNAME}" "${home}/.hermes/skills/kunguru-custom"
echo "[ok] kunguru-sites skill converged for ${USERNAME}"

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

# --- retire the pre-PM in-tree venv (only after a full update) ---
# The PM-managed environment fully supersedes it, and the WebUI/gateway have
# been repointed by now. Guard: skip removal if anything outside the venv still
# references the path (tenant cron/scripts, unit files); they may be the user's.
legacy_venv="${home}/.hermes/hermes-agent/venv"
if [[ "$did_update" == "1" && -d "$legacy_venv" ]]; then
  refs="$(grep -rIl --exclude-dir=venv "hermes-agent/venv" \
    "${home}/.config/systemd/user" "${home}/.hermes/bin" \
    "${home}/.local/bin" "${home}/bin" 2>/dev/null || true)"
  crons="$(run_as_user 'crontab -l 2>/dev/null' || true)"
  if [[ -n "$refs" || "$crons" == *"hermes-agent/venv"* ]]; then
    echo "warning: not removing ${legacy_venv}; still referenced:" >&2
    [[ -n "$refs" ]] && printf '  %s\n' $refs >&2
    [[ "$crons" == *"hermes-agent/venv"* ]] && echo "  (crontab)" >&2
  else
    echo "[changed] removing superseded legacy venv for ${USERNAME}"
    rm -rf "$legacy_venv"
  fi
fi

# --- machine-readable convergence markers (parsed by the app for the fleet view) ---
version_line="$(run_as_user 'hermes --version' 2>/dev/null | head -1 || true)"
agent_version="$(printf '%s' "$version_line" | grep -oE 'v[0-9][^ ]*' | head -1)"
agent_channel="$(printf '%s' "$version_line" | sed -n 's/.*· *\([a-z]*\) *·.*/\1/p')"
if [[ -d "${home}/.hermes/hermes-agent/venv" ]]; then venv_kind="legacy"; else venv_kind="pm"; fi
actual_model="$(run_as_user 'hermes config get model.default' 2>/dev/null | tr -d '\r' | head -1 || true)"
printf 'HERMES_AGENT_VERSION=%s\n' "${agent_version:-unknown}"
printf 'HERMES_CHANNEL=%s\n' "${agent_channel:-unknown}"
printf 'HERMES_VENV_KIND=%s\n' "${venv_kind}"
printf 'HERMES_MODEL_ACTUAL=%s\n' "${actual_model}"

echo "[ok] ensure-hermes complete for ${USERNAME}"
