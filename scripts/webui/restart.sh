#!/usr/bin/env bash
# webui/restart.sh  (run as root on the user's host over `sudo bash -s`)
#
# Restarts the per-tenant Hermes WebUI so it drops its cached model catalog and
# re-fetches `/v1/models` through the tenant's LLM gateway. The admin "Refresh
# models & WebUIs" action runs this for every active tenant after refreshing the
# gateway's upstream provider models.
#
# Lightweight on purpose: unlike webui/ensure.sh it does NOT re-clone/update the
# WebUI or rewrite the unit. It only restarts the existing unit, starting it if
# it is not running. Idempotent.
#
# Env:
#   USERNAME (required)
set -euo pipefail

: "${USERNAME:?missing required env: USERNAME}"

if [[ ! "$USERNAME" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
  echo "error: invalid linux username '$USERNAME'" >&2
  exit 1
fi
if ! id "$USERNAME" >/dev/null 2>&1; then
  echo "error: linux account '$USERNAME' does not exist" >&2
  exit 1
fi

home="$(getent passwd "$USERNAME" | cut -d: -f6)"
uid="$(id -u "$USERNAME")"

# run_as_user CMD...: run as USERNAME with a clean env and the per-user systemd
# manager socket so `systemctl --user` works.
run_as_user() {
  runuser -u "$USERNAME" -- env -i \
    HOME="$home" \
    USER="$USERNAME" LOGNAME="$USERNAME" SHELL=/bin/bash \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    PATH="${home}/.local/bin:${home}/.hermes/hermes-agent/venv/bin:${home}/.hermes/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash -c "cd '${home}' && $1"
}

if ! run_as_user 'systemctl --user cat hermes-webui.service' >/dev/null 2>&1; then
  echo "error: hermes-webui.service not installed for ${USERNAME} (run webui/ensure.sh first)" >&2
  exit 1
fi

echo "[changed] restarting hermes webui for ${USERNAME}"
if ! out="$(run_as_user 'systemctl --user restart hermes-webui' 2>&1)"; then
  echo "error: failed to restart hermes webui for ${USERNAME}" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

sleep 1
if run_as_user 'systemctl --user is-active hermes-webui' >/dev/null 2>&1; then
  echo "[ok] hermes webui active for ${USERNAME}"
else
  echo "error: hermes webui for ${USERNAME} not active after restart" >&2
  exit 1
fi
