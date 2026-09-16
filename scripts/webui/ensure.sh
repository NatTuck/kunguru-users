#!/usr/bin/env bash
# webui/ensure.sh  (run as root on the user's host over `sudo bash -s`)
#
# Converges a per-tenant Hermes WebUI (github.com/nesquena/hermes-webui) for
# USERNAME:
#   * clone/update the WebUI into ~/.local/apps/hermes-webui
#   * a user systemd unit running server.py on WEBUI_PORT, bound to WEBUI_HOST
#   * trusted-header auth: the gateway's nginx authenticates the app session
#     and forwards the owning username as Remote-User; no WebUI password is set
#
# Idempotent / converge-only: never deletes tenant state.
#
# Env:
#   USERNAME (required)          HERMES_ACTION (ensure | stop; default ensure)
#   WEBUI_PORT (required)        WEBUI_HOST (bind address; default 127.0.0.1)
#   WEBUI_TRUSTED_PROXIES        WEBUI_LOGOUT_URL (both optional)
set -euo pipefail

: "${USERNAME:?missing required env: USERNAME}"
action="${HERMES_ACTION:-ensure}"

if [[ ! "$USERNAME" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
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
agent_dir="${home}/.hermes/hermes-agent"
repo_dir="${home}/.local/apps/hermes-webui"
unit="${home}/.config/systemd/user/hermes-webui.service"

# run_as_user CMD...: run as USERNAME with a clean env, the per-user systemd
# manager socket, and cwd in the user's home.
run_as_user() {
  runuser -u "$USERNAME" -- env -i \
    HOME="$home" \
    USER="$USERNAME" LOGNAME="$USERNAME" SHELL=/bin/bash \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    PATH="${home}/.local/bin:${home}/.hermes/hermes-agent/venv/bin:${home}/.hermes/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash -c "cd '${home}' && $1"
}

if [[ "$action" == "stop" ]]; then
  echo "[ok] stopping hermes webui for ${USERNAME}"
  run_as_user 'systemctl --user disable --now hermes-webui >/dev/null 2>&1 || systemctl --user stop hermes-webui >/dev/null 2>&1 || true'
  exit 0
fi

: "${WEBUI_PORT:?missing required env: WEBUI_PORT}"
webui_host="${WEBUI_HOST:-127.0.0.1}"
webui_proxies="${WEBUI_TRUSTED_PROXIES:-127.0.0.1/32}"
logout_url="${WEBUI_LOGOUT_URL:-}"

# --- lingering user manager (webui must survive logout/reboot) ---
loginctl enable-linger "$USERNAME"
for _ in $(seq 1 20); do
  [[ -S "/run/user/${uid}/systemd/private" ]] && break
  sleep 1
done

if [[ ! -x "$venv_py" ]]; then
  echo "error: hermes agent venv python missing at ${venv_py} (run hermes/ensure.sh first)" >&2
  exit 1
fi

# --- clone or update the WebUI checkout ---
if [[ ! -d "${repo_dir}/.git" ]]; then
  echo "[changed] cloning hermes-webui for ${USERNAME}"
  install -d -o "$USERNAME" "${home}/.local/apps"
  run_as_user "git clone --depth 1 https://github.com/nesquena/hermes-webui.git '${repo_dir}'"
else
  # Update in place. Shallow clones can't fast-forward when upstream rewrites
  # history, so fetch the branch tip and hard-reset.
  run_as_user "git -C '${repo_dir}' fetch --depth 1 origin master >/dev/null 2>&1 && git -C '${repo_dir}' reset --hard FETCH_HEAD >/dev/null 2>&1 || true"
fi
if [[ ! -f "${repo_dir}/server.py" ]]; then
  echo "error: hermes-webui server.py missing at ${repo_dir}" >&2
  exit 1
fi

# --- deps: the agent venv already carries pyyaml/cryptography; top up via uv ---
if [[ -x "${home}/.hermes/bin/uv" ]]; then
  run_as_user "'${home}/.hermes/bin/uv' pip install --quiet --python '${venv_py}' -r '${repo_dir}/requirements.txt' >/dev/null 2>&1 || true"
fi

# --- user systemd unit ---
install -d "${home}/.config/systemd/user"
cat > "$unit" <<UNIT
[Unit]
Description=Hermes WebUI (${USERNAME})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${repo_dir}
Environment=HERMES_HOME=${home}/.hermes
Environment=HERMES_WEBUI_AGENT_DIR=${agent_dir}
Environment=HERMES_WEBUI_PYTHON=${venv_py}
Environment=HERMES_WEBUI_STATE_DIR=${home}/.hermes/webui
Environment=HERMES_WEBUI_HOST=${webui_host}
Environment=HERMES_WEBUI_PORT=${WEBUI_PORT}
Environment=HERMES_WEBUI_TRUSTED_AUTH_HEADER=Remote-User
Environment=HERMES_WEBUI_TRUSTED_PROXY_CIDRS=${webui_proxies}
Environment=HERMES_WEBUI_TRUSTED_AUTH_LOGOUT_URL=${logout_url}
ExecStart=${venv_py} ${repo_dir}/server.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
chown "$USERNAME" "$unit"
run_as_user 'systemctl --user daemon-reload'
if run_as_user 'systemctl --user is-active hermes-webui' >/dev/null 2>&1; then
  run_as_user 'systemctl --user restart hermes-webui' >/dev/null
else
  run_as_user 'systemctl --user enable --now hermes-webui' >/dev/null
fi

sleep 3
if run_as_user 'systemctl --user is-active hermes-webui' >/dev/null 2>&1; then
  echo "[ok] hermes webui active for ${USERNAME} on ${webui_host}:${WEBUI_PORT}"
else
  echo "warning: hermes webui for ${USERNAME} not active; check 'journalctl --user -u hermes-webui'" >&2
fi

echo "[ok] ensure-webui complete for ${USERNAME}"
