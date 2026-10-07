#!/usr/bin/env bash
# hermes/set-model.sh  (run as root on the user's host over `sudo bash -s`)
#
# Switches a tenant's default LLM model (a Bifrost `provider/name` id) and
# restarts the Hermes gateway so the new default takes effect. Lightweight on
# purpose: unlike hermes/ensure.sh it does NOT reinstall/update the agent or
# re-converge plugins/skills; it only rewrites model.default and restarts.
#
# The WebUI is restarted as a separate step (scripts/webui/restart.sh) so its
# cached model catalog is dropped too.
#
# Idempotent.
#
# Env:
#   USERNAME (required)   HERMES_MODEL (required)
set -euo pipefail

: "${USERNAME:?missing required env: USERNAME}"
: "${HERMES_MODEL:?missing required env: HERMES_MODEL}"

if [[ ! "$USERNAME" =~ ^[a-z][a-z0-9._-]{0,31}$ ]]; then
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

if ! run_as_user 'systemctl --user cat hermes-gateway.service' >/dev/null 2>&1; then
  echo "error: hermes-gateway.service not installed for ${USERNAME} (provision the account first)" >&2
  exit 1
fi

echo "[changed] setting hermes default model to '${HERMES_MODEL}' for ${USERNAME}"
run_as_user "hermes config set model.default '${HERMES_MODEL}' >/dev/null"

echo "[changed] restarting hermes gateway for ${USERNAME}"
if ! out="$(run_as_user 'systemctl --user restart hermes-gateway' 2>&1)"; then
  echo "error: failed to restart hermes gateway for ${USERNAME}" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

sleep 2
if run_as_user 'systemctl --user is-active hermes-gateway' >/dev/null 2>&1; then
  echo "[ok] default model '${HERMES_MODEL}' active for ${USERNAME}"
else
  echo "error: hermes gateway for ${USERNAME} not active after restart" >&2
  exit 1
fi
