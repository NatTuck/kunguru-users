#!/usr/bin/env bash
# account/app-control.sh  (run as root on the account's host, via the app)
#
# Reads or changes the state of an account's app slots. The units are user
# units (scripts/account/ensure-apps.sh installs them); this script drives the
# account's user manager as root, which is what the app's UI uses for both user
# and group accounts.
#
# Env:
#   USERNAME             account name                                  (required)
#   KUNGURU_APP_SLOT     app | app-dev | all                          (required)
#   KUNGURU_APP_ACTION   status | enable | disable | restart | logs   (required)
#   KUNGURU_APP_LINES    log lines for `logs` (default 200)
#
# `status` prints stable `KEY=value` blocks (one `SLOT=` block per slot) and
# always exits 0 for a valid account, including when the user manager is not
# running (MANAGER=0). Actions return systemctl's exit status.
set -euo pipefail

: "${USERNAME:?missing required env: USERNAME}"
: "${KUNGURU_APP_SLOT:?missing required env: KUNGURU_APP_SLOT}"
: "${KUNGURU_APP_ACTION:?missing required env: KUNGURU_APP_ACTION}"

action="$KUNGURU_APP_ACTION"
slot="${KUNGURU_APP_SLOT}"
lines="${KUNGURU_APP_LINES:-200}"

case "$slot" in
  app|app-dev) slots=("$slot") ;;
  all) slots=(app app-dev) ;;
  *) echo "error: invalid slot '$slot'" >&2; exit 2 ;;
esac
case "$action" in
  status|enable|disable|restart|logs) ;;
  *) echo "error: invalid action '$action'" >&2; exit 2 ;;
esac
[[ "$lines" =~ ^[0-9]+$ ]] || { echo "error: invalid line count '$lines'" >&2; exit 2; }

if ! id "$USERNAME" >/dev/null 2>&1; then
  echo "error: linux account '$USERNAME' does not exist" >&2
  exit 1
fi
home="$(getent passwd "$USERNAME" | cut -d: -f6)"
uid="$(id -u "$USERNAME")"

run_as_user() {
  runuser -u "$USERNAME" -- env -i \
    HOME="$home" \
    USER="$USERNAME" LOGNAME="$USERNAME" SHELL=/bin/bash \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash -c "cd '${home}' && $1"
}

# The manager is reachable only when a real command succeeds (the socket file
# can exist in a container with no working manager).
manager_up=0
if run_as_user 'systemctl --user show-environment >/dev/null 2>&1' 2>/dev/null; then
  manager_up=1
fi

print_status() {
  local unit="$1" props load enabled active sub exit_code result
  printf 'SLOT=%s\n' "${unit%.service}"
  printf 'UNIT=%s\n' "$unit"
  props="$(run_as_user "systemctl --user show '${unit}'" 2>/dev/null || true)"
  get() { printf '%s\n' "$props" | sed -n "s/^$1=//p"; }
  load="$(get LoadState)"
  enabled="$(get UnitFileState)"
  active="$(get ActiveState)"
  sub="$(get SubState)"
  exit_code="$(get ExecMainStatus)"
  result="$(get Result)"
  printf 'LOAD=%s\n' "${load:-unknown}"
  printf 'ENABLED=%s\n' "${enabled:-unknown}"
  printf 'ACTIVE=%s\n' "${active:-unknown}"
  printf 'SUB=%s\n' "${sub:-unknown}"
  printf 'EXIT=%s\n' "${exit_code:-}"
  printf 'RESULT=%s\n' "${result:-unknown}"
}

if [[ "$manager_up" != "1" ]]; then
  printf 'MANAGER=0\n'
  if [[ "$action" == "status" ]]; then
    for s in "${slots[@]}"; do
      printf 'SLOT=%s\nUNIT=%s.service\nLOAD=unknown\nENABLED=unknown\nACTIVE=unknown\nSUB=unknown\nEXIT=\nRESULT=unknown\n' "$s" "$s"
    done
    exit 0
  fi
  echo "error: the user manager for ${USERNAME} is not running (linger disabled?)" >&2
  exit 3
fi
printf 'MANAGER=1\n'

if [[ "$action" == "status" ]]; then
  for s in "${slots[@]}"; do print_status "${s}.service"; done
  exit 0
fi

if [[ "$action" == "logs" ]]; then
  unit="${slots[0]}.service"
  run_as_user "journalctl --user -u '${unit}' -n ${lines} --no-pager -o short-iso" || true
  exit 0
fi

unit="${slots[0]}.service"
# "enable"/"disable" are user actions ("run it now" / "stop it"), not just
# boot-time symlink changes: --now starts/stops the unit as well.
case "$action" in
  enable) systemctl_action="enable --now" ;;
  disable) systemctl_action="disable --now" ;;
  restart) systemctl_action="restart" ;;
  *) systemctl_action="$action" ;;
esac
if out="$(run_as_user "systemctl --user ${systemctl_action} '${unit}'" 2>&1)"; then
  rc=0
else
  rc=$?
fi
printf '%s\n' "$out"
exit "$rc"
