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
identity_pubkey="${KUNGURU_IDENTITY_PUBKEY_DER:-}"
# Account kind (user | group): groups get the shared-session identity plugin.
account_kind="${KUNGURU_ACCOUNT_KIND:-user}"
# WebUI source/ref (our fork until the trusted-user-identity patch is upstream).
webui_repo="${WEBUI_REPO:-https://github.com/NatTuck/hermes-webui.git}"
webui_ref="${WEBUI_REF:-kunguru/trusted-user-identity}"
case "$account_kind" in
  user|group) ;;
  *) echo "error: invalid KUNGURU_ACCOUNT_KIND '$account_kind' (user|group)" >&2; exit 1 ;;
esac

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
    if run_as_user "git -C '${webui_dir}' remote set-url origin '${webui_repo}' >/dev/null 2>&1 || true; git -C '${webui_dir}' fetch --depth 1 origin '${webui_ref}' >/dev/null 2>&1 && git -C '${webui_dir}' reset --hard FETCH_HEAD >/dev/null 2>&1"; then
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

# --- group identity plugin (shared group WebUI) ---
# A group WebUI serves several members. The WebUI passes the signed-in member
# as the agent's user_id; this plugin announces the speaker on the first turn
# and when the speaker changes -- never on every turn (a sentence per turn is
# pure token waste). Groups only: a user account has a single speaker.
group_identity_dir="${home}/.hermes/plugins/kunguru-group-identity"
if [[ "$account_kind" == "group" ]]; then
  install -d -m 0755 -o "$USERNAME" -g "$(id -gn "$USERNAME")" "$group_identity_dir"
  tmp_plugin="$(mktemp)"
  cat >"$tmp_plugin" <<'YAML'
name: kunguru-group-identity
version: "0.1.0"
description: "Attribute each WebUI turn to the signed-in member of a shared group account; announces only on the first turn and when the speaker changes."
author: "kunguru-users"
provides_hooks:
  - pre_llm_call
  - post_llm_call
YAML
  install -m 0644 -o "$USERNAME" -g "$(id -gn "$USERNAME")" "$tmp_plugin" "$group_identity_dir/plugin.yaml"
  cat >"$tmp_plugin" <<'PY'
"""Attribute WebUI turns to the signed-in member of a shared group account.

The WebUI passes the trusted-auth user as the agent's user_id; the agent
exposes it to pre_llm_call as sender_id. Announcing the speaker on every turn
is wasteful, so this keeps the last announced speaker per session and injects
context only on the first turn and when the speaker changes. The context rides
the current user message's API copy (not the system prompt, and not the
persisted transcript).
"""
import threading

_lock = threading.Lock()
_last_sender = {}
_pending = {}

_FIRST = "[shared group session; current speaker: {}]"
_CHANGED = "[speaker changed: {}]"


def _on_pre_llm_call(session_id=None, sender_id=None, platform=None, **_):
    if platform != "webui" or not sender_id:
        return None
    sid = str(session_id or "")
    sender = str(sender_id)
    with _lock:
        previous = _last_sender.get(sid)
        if previous == sender:
            return None
        _pending[sid] = sender
    return {"context": (_FIRST if previous is None else _CHANGED).format(sender)}


def _on_post_llm_call(session_id=None, **_):
    sid = str(session_id or "")
    with _lock:
        sender = _pending.pop(sid, None)
        if sender:
            _last_sender[sid] = sender


def register(ctx):
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
PY
  install -m 0644 -o "$USERNAME" -g "$(id -gn "$USERNAME")" "$tmp_plugin" "$group_identity_dir/__init__.py"
  rm -f "$tmp_plugin"
  echo "[ok] kunguru-group-identity installed for ${USERNAME}"
fi

# Merge (never replace) so plugins the tenant enabled (e.g. homeassistant) are
# preserved while hermes-xmpp-plugin is (re)asserted.
plugins_now="$(run_as_user 'hermes config get plugins.enabled --json 2>/dev/null' || echo '[]')"
plugins_merged="$(PLUGINS_NOW="$plugins_now" ACCOUNT_KIND="$account_kind" python3 - <<'PY'
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
if os.environ.get("ACCOUNT_KIND") == "group":
    if "kunguru-group-identity" not in seen:
        out.append("kunguru-group-identity")
else:
    # A user account has a single speaker; the plugin is not installed.
    out = [p for p in out if p != "kunguru-group-identity"]
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
description: "Deploy and host web apps and static sites for a kunguru tenant. The gateway nginx, TLS, DNS, and the user-server static nginx are managed centrally; you run your app on the app or app-dev port, or publish static files into ~/www/<label>."
version: 1.1.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [kunguru, sites, hosting, deploy, static-site, app, tls]
    related_skills: [kunguru-operations]
---

# kunguru tenant site deployment

This supersedes the old "kunguru-nginx / ~/www / ~/sites" guidance. A tenant
never touches nginx, certbot, or DNS: the platform runs nginx on your host for
static sites and on the gateway for routing/TLS.

## Read first

`references/local.md` (same directory) lists YOUR hostnames, ports, bind
address, and trusted-proxy address. Read it before deploying anything.

## The model

Each account (a user, or a group) gets one app with two variants plus a managed
WebUI:

| Slot | Hostname | Port | Access |
|---|---|---|---|
| app | `<account>.<base>` | 12000 + id | optional auth (or require_auth) |
| app-dev | `<account>-dev.<base>` | 13000 + id | optional auth (or require_auth) |
| hermes-webui | `<account>-agent.<base>` | 11000 + id | app session (managed) |

`<id>` is the account's numeric id (see `references/local.md`). All three are
proxied over the VPN to your host, so a service bound to a slot port is
reachable immediately.

## Where code and files live

- App code: `~/.local/apps/app` (production) and `~/.local/apps/app-dev` (dev).
- Units: `~/.config/systemd/user/app.service` and `app-dev.service`.
- Static sites: source/build projects in `~/sites/<label>`; the **served
  docroot** is `~/www/<label>` (the built output). The platform's nginx on your
  host serves `~/www/<label>`; you do not run a server for static sites.

### Authentication and identity

The gateway authenticates every request (optionally) and forwards verified
headers; it also strips the session cookie, so your app never sees it:

- `Remote-User` — the signed-in username, or empty for anonymous.
- `Remote-Groups` — comma-separated group names, or empty.

Trust these headers **only** when the TCP peer is the gateway's WG IP
(`references/local.md`); ignore them from any other peer.

Authentication is **optional by default**: anonymous is allowed and
`Remote-User` is populated when the visitor is signed in. To require a login,
redirect the browser to:

```
https://users.<base>/login?next=<urlencoded absolute URL of the current page>
```

The user is returned to `next` after signing in. The WebUI and any host marked
`require_auth` (an app or a static site) get that redirect from the gateway
automatically.

Your app should:

- bind to the address in `references/local.md` (the address the gateway reaches:
  the host's VPN/LAN address, or `127.0.0.1` when your account is on the same
  host as the gateway);
- do **no** password login of its own;
- use `Remote-User` / `Remote-Groups` for identity and authorization.

## Verified identity token (recommended)

Alongside the headers the gateway sets `X-Kunguru-Identity`: a short-lived
(60 s) EdDSA JWT signed with the instance key. Verify it against the public key
in `references/local.md` (base64 SPKI DER), and check that `aud` is your own
hostname. A missing or invalid token means anonymous — never trust the claims
of an unverified token. Prefer the token over `Remote-User` when you need an
unforgeable identity: the header is only as trustworthy as the peer-IP check,
while a verified token cannot be spoofed by another local process. Tokens are
audience-bound, so one captured for another host will not validate for yours.

## Deploying your app

The platform installs two user units for your account:

- `app.service` runs `~/.local/apps/app/run` with `PORT=<app port>` and
  `HOST=<bind address>` (from `references/local.md`);
- `app-dev.service` runs `~/.local/apps/app-dev/run` with the dev port.

Put production code in `~/.local/apps/app` and dev code in
`~/.local/apps/app-dev`, and provide an executable `run` script in each slot.
It must start your server on `$HOST:$PORT` (read them from the environment).
The slot stays **inactive** until `run` exists and is executable, then enable or
restart it from the app's **Your apps** panel, which also shows the unit state
and recent logs.

If the account is yours you can also use `systemctl --user status app` /
`systemctl --user restart app`. Members of a group account use the app's panel:
they have no login session as the group.

Do **not** edit the unit files: the platform manages them (ports, bind address,
restart policy).

Then open `https://<account>.<base>/` (production) or
`https://<account>-dev.<base>/` (dev).

## Static sites

Static sites are owned by a user or group, limited to **5 per owner**. The
platform serves them with nginx on your host; you only publish files:

- source/build project: `~/sites/<label>`
- served docroot: `~/www/<label>` (put the built output here)
- URL: `https://<label>.<base>/`

Build into `~/www/<label>` (for example copy `dist/` or `book/` there). The
platform creates the directory and the nginx route; ask the operator to add the
static site (or use the app's self-service page when available). Do not run your
own nginx or per-site vhosts.

## TLS, certificates, DNS

Automatic. The platform reconciles the wildcard certificate and DNS. Do **not**
run certbot, and do not create certificates yourself.

## Do NOT

- Start, edit, or reload nginx; do not write under `/etc/nginx`.
- Run `certbot` or manage certificates.
- Serve app code from `~/sites` or `~/www`; those are static-site source and
  docroot paths.
- Use `kunguru-nginx` or `sudo`.
- Set a cookie with `Domain=<base>` (or any parent domain). The session cookie
  is stripped on the way to your app, but a cookie you set for the parent domain
  is sent to every host, including the login app — that is cookie tossing. Scope
  your cookies to your own hostname.

## Verification and common statuses

- App: `curl -sI https://<account>.<base>/` -> 200.
- Static site: `curl -sI https://<label>.<base>/` -> 200.
- `502` at a slot host = the gateway route is fine but **nothing is listening**
  on the slot port (your app is down or bound to the wrong port/address).
- `404` = no route for that hostname (account disabled, or the label is not a
  configured app/static site).
- A `require_auth` host returns `302` to `https://users.<base>/login` when
  signed out — that is the auth gate working; sign in and retry.
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
    echo "- Identity token public key (base64 SPKI DER): \`${identity_pubkey:-<not supplied>}\`"
    echo
    echo "| Hostname | Slot | Port | Access | Remote-User |"
    echo "|---|---|---|---|---|"
    echo "| ${USERNAME}.${base_domain} | app | $((12000 + user_id)) | optional (or require_auth) | when signed in |"
    echo "| ${USERNAME}-dev.${base_domain} | app-dev | $((13000 + user_id)) | optional (or require_auth) | when signed in |"
    echo "| ${USERNAME}-agent.${base_domain} | hermes-webui | $((11000 + user_id)) | app session | ${USERNAME} |"
    echo
    echo "Static sites: source ~/sites/<label>, served docroot ~/www/<label>, URL https://<label>.${base_domain}/"
  } > "$tmp_local"
else
  cat > "$tmp_local" <<'KUNGURU_SITES_LOCAL'
# Your deployment

Hostnames and ports were not supplied to this converge (`KUNGURU_USER_ID` /
`KUNGURU_BASE_DOMAIN` unset). Ask the operator for this account's app/app-dev/
WebUI hosts and ports, or re-run the provision step from the kunguru-users app.
Static sites use `~/sites/<label>` (source) and `~/www/<label>` (served).
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

# --- ownership guard ---
# The installer/update mix root and user contexts; never leave a root-owned
# entry in the account's home. The full-home scan is
# scripts/check-home-ownership.sh; this repairs the paths this script manages.
for d in "${home}/.hermes/bin" "${home}/.hermes/plugins" \
         "${home}/.config/systemd/user" "${home}/.local/bin"; do
  [[ -d "$d" ]] || continue
  while IFS= read -r -d '' p; do
    chown "$USERNAME:$USERNAME" "$p" 2>/dev/null || true
  done < <(find "$d" -xdev -user root -print0 2>/dev/null)
done

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
