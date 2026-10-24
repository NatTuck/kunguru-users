#!/usr/bin/env bash
# webui/ensure.sh  (run as root on the user's host over `sudo bash -s`)
#
# Converges a per-tenant Hermes WebUI (pinned to our fork of
# nesquena/hermes-webui; see notes/webui-identity.md) for
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
#   WEBUI_DEFAULT_MODEL          default LLM for new WebUI chats (Bifrost
#                                `provider/name`); exported to the WebUI as
#                                HERMES_WEBUI_DEFAULT_MODEL
#   WEBUI_TRUSTED_PROXIES        WEBUI_LOGOUT_URL (both optional)
#   WEBUI_GROUP_PROFILE_MAP      JSON map pinning a group account's sessions to
#                                the root profile, e.g. {"ops":"default"}
#                                (exported as HERMES_WEBUI_GROUP_PROFILE_MAP)
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
agent_dir="${home}/.hermes/hermes-agent"
repo_dir="${home}/.local/apps/hermes-webui"
# The WebUI source. Pinned to our fork/branch until the trusted-user-identity
# patch is upstream (nesquena/hermes-webui#8522); see notes/webui-identity.md.
webui_repo="${WEBUI_REPO:-https://github.com/NatTuck/hermes-webui.git}"
webui_ref="${WEBUI_REF:-kunguru/trusted-user-identity}"
unit="${home}/.config/systemd/user/hermes-webui.service"

# hermes_python: the interpreter that carries the Hermes agent's dependencies.
# Upstream moved from the legacy in-tree venv to a PM-managed generation
# recorded in <HERMES_HOME>/installs/<key>/facts.json; fall back to the old
# in-tree venv for installs that predate the change.
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
  py="${agent_dir}/venv/bin/python"
  if [[ -x "$py" ]]; then
    printf '%s' "$py"
    return 0
  fi
  return 1
}

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
webui_default_model="${WEBUI_DEFAULT_MODEL:-}"
group_profile_map="${WEBUI_GROUP_PROFILE_MAP:-}"

# Optional unit line, emitted only when set (an empty value could be parsed as
# invalid JSON by the WebUI).
extra_env=""
if [[ -n "$group_profile_map" ]]; then
  # systemd processes quotes/escapes in unit values, so a JSON value must have
  # its quotes and backslashes escaped to survive into the environment.
  escaped_map="${group_profile_map//\\/\\\\}"
  escaped_map="${escaped_map//\"/\\\"}"
  extra_env="Environment=HERMES_WEBUI_GROUP_PROFILE_MAP=${escaped_map}"
fi

# --- lingering user manager (webui must survive logout/reboot) ---
loginctl enable-linger "$USERNAME"
for _ in $(seq 1 20); do
  [[ -S "/run/user/${uid}/systemd/private" ]] && break
  sleep 1
done

venv_py="$(hermes_python || true)"
if [[ -z "$venv_py" || ! -x "$venv_py" ]]; then
  echo "error: could not find a Python with the Hermes agent dependencies" >&2
  echo "       (looked under ${home}/.hermes/installs and ${agent_dir}/venv; run hermes/ensure.sh first)" >&2
  exit 1
fi

# --- clone or update the WebUI checkout ---
if [[ ! -d "${repo_dir}/.git" ]]; then
  echo "[changed] cloning hermes-webui for ${USERNAME} (${webui_ref})"
  install -d -o "$USERNAME" "${home}/.local/apps"
  run_as_user "git clone --depth 1 --branch '${webui_ref}' '${webui_repo}' '${repo_dir}'"
else
  # Update in place. Point an existing checkout (possibly cloned from upstream
  # before the fork existed) at the fork/ref, then hard-reset to its tip:
  # shallow clones can't fast-forward when history is rewritten.
  run_as_user "git -C '${repo_dir}' remote set-url origin '${webui_repo}' >/dev/null 2>&1 || true; git -C '${repo_dir}' fetch --depth 1 origin '${webui_ref}' >/dev/null 2>&1 && git -C '${repo_dir}' reset --hard FETCH_HEAD >/dev/null 2>&1 || true"
fi
webui_commit="$(run_as_user "git -C '${repo_dir}' rev-parse --short HEAD" 2>/dev/null || true)"
[[ -n "$webui_commit" ]] && echo "[ok] hermes-webui at ${webui_commit} (${webui_ref})"
if [[ ! -f "${repo_dir}/server.py" ]]; then
  echo "error: hermes-webui server.py missing at ${repo_dir}" >&2
  exit 1
fi

# --- deps: the agent environment already carries pyyaml/cryptography; top up ---
# uv moved with the PM layout (was ~/.hermes/bin/uv, now a store tool), so try
# both before giving up.
for uv in "${home}/.hermes/bin/uv" "${home}/.hermes/tools"/*/uv; do
  if [[ -x "$uv" ]]; then
    run_as_user "'${uv}' pip install --quiet --python '${venv_py}' -r '${repo_dir}/requirements.txt' >/dev/null 2>&1 || true"
    break
  fi
done

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
Environment=HERMES_WEBUI_DEFAULT_MODEL=${webui_default_model}
${extra_env}
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
