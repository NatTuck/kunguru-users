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

# run_as_user CMD...: run as USERNAME with a clean but functional env and the
# per-user systemd manager socket (XDG_RUNTIME_DIR) so systemctl --user works.
run_as_user() {
  runuser -u "$USERNAME" -- env -i \
    HOME="$home" \
    USER="$USERNAME" LOGNAME="$USERNAME" SHELL=/bin/bash \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    PATH="${home}/.local/bin:${home}/.hermes/hermes-agent/venv/bin:${home}/.hermes/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash -c "$1"
}

if [[ "$action" == "stop" ]]; then
  echo "[ok] stopping hermes gateway for ${USERNAME}"
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

  plugin_dir="${home}/.hermes/plugins/hermes-xmpp-plugin"
  if [[ ! -d "${plugin_dir}" ]]; then
    echo "[changed] installing hermes-xmpp-plugin for ${USERNAME}"
    mkdir -p "${home}/.hermes/plugins"
    chown "${USERNAME}" "${home}/.hermes/plugins"
    run_as_user "git clone --depth 1 https://github.com/fastfinge/hermes-xmpp-plugin.git '${plugin_dir}'"
  fi
  run_as_user "'${home}/.hermes/bin/uv' pip install --quiet --python '${venv_py}' -r '${plugin_dir}/requirements.txt'"
  run_as_user 'hermes config set plugins.enabled '"'"'["hermes-xmpp-plugin"]'"'"' >/dev/null'
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

sleep 3
if run_as_user 'systemctl --user is-active hermes-gateway' >/dev/null 2>&1; then
  echo "[ok] hermes gateway active for ${USERNAME}"
else
  echo "warning: hermes gateway for ${USERNAME} not active after start; check 'journalctl --user -u hermes-gateway'" >&2
fi

echo "[ok] ensure-hermes complete for ${USERNAME}"
