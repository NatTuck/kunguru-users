#!/usr/bin/env bash
# account/ensure-apps.sh  (run as root on the account's host, via the app)
#
# Installs an account's two app slots: the code directories and the **user
# units** that run them. The account (a user, or a group's Linux user) owns the
# code; the platform owns the unit shape (port + bind address) and manages the
# units through the app's UI.
#
#   ~/.local/apps/app       production slot, PORT=KUNGURU_APP_PORT
#   ~/.local/apps/app-dev   dev slot,        PORT=KUNGURU_APP_DEV_PORT
#   ~/.config/systemd/user/app.service, app-dev.service
#
# Each unit runs the convention start script `run` from its slot directory and
# is enabled at boot. `ConditionPathIsExecutable` keeps a slot inactive (not
# failed) until the account provides an executable `run`.
#
# Env:
#   USERNAME                    account name                          (required)
#   KUNGURU_APP_PORT            production port, e.g. 12000+id        (required)
#   KUNGURU_APP_DEV_PORT        dev port, e.g. 13000+id               (required)
#   KUNGURU_BIND_ADDR           address the gateway reaches: 127.0.0.1
#                               when co-located, else the host's VPN/LAN
#                               address                               (required)
#   KUNGURU_APPS_DRY_RUN=1      print the directories + units; change nothing
#
# Idempotent: it converges the directories, units, linger, and boot enablement,
# and no-ops when nothing differs.
set -euo pipefail

log()  { printf '[apps] %s\n' "$*"; }
warn() { printf '[apps][warn] %s\n' "$*" >&2; }

: "${USERNAME:?missing required env: USERNAME}"
: "${KUNGURU_APP_PORT:?missing required env: KUNGURU_APP_PORT}"
: "${KUNGURU_APP_DEV_PORT:?missing required env: KUNGURU_APP_DEV_PORT}"
: "${KUNGURU_BIND_ADDR:?missing required env: KUNGURU_BIND_ADDR}"

if [[ ! "$USERNAME" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
  echo "error: invalid account name '$USERNAME'" >&2
  exit 1
fi
for p in "$KUNGURU_APP_PORT" "$KUNGURU_APP_DEV_PORT"; do
  [[ "$p" =~ ^[0-9]+$ ]] || { echo "error: invalid port '$p'" >&2; exit 1; }
done

if ! id "$USERNAME" >/dev/null 2>&1; then
  echo "error: linux account '$USERNAME' does not exist (run account/ensure.sh first)" >&2
  exit 1
fi

home="$(getent passwd "$USERNAME" | cut -d: -f6)"
uid="$(id -u "$USERNAME")"
group="$(id -gn "$USERNAME")"
unit_dir="${home}/.config/systemd/user"

# One unit per slot. %h is the account's home in a *user* unit; the gateway's
# address is the only bind address a tenant app should use.
unit_text() {
  local slot="$1" port="$2"
  cat <<EOF
# Managed by kunguru-users (scripts/account/ensure-apps.sh) -- do not edit.
[Unit]
Description=Kunguru app (${USERNAME}, ${slot})
After=network-online.target
Wants=network-online.target
ConditionPathIsExecutable=%h/.local/apps/${slot}/run

[Service]
Type=simple
WorkingDirectory=%h/.local/apps/${slot}
Environment=PORT=${port}
Environment=HOST=${KUNGURU_BIND_ADDR}
UMask=0002
NoNewPrivileges=yes
ExecStart=%h/.local/apps/${slot}/run
Restart=always
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
}

if [[ "${KUNGURU_APPS_DRY_RUN:-0}" == "1" ]]; then
  log "dry run for ${USERNAME} (${home}, uid ${uid}, group ${group})"
  for d in "${home}/.local" "${home}/.local/apps" \
           "${home}/.local/apps/app" "${home}/.local/apps/app-dev" \
           "$unit_dir"; do
    log "would ensure directory ${d} (2770 ${USERNAME}:${group})"
  done
  log "would install ${unit_dir}/app.service:"
  unit_text app "$KUNGURU_APP_PORT"
  log "would install ${unit_dir}/app-dev.service:"
  unit_text app-dev "$KUNGURU_APP_DEV_PORT"
  exit 0
fi

# Directories. The account (and, for a group, its members) must be able to
# write; setgid keeps new files in the account's group. `.config` and
# `.config/systemd` are listed explicitly: `install -d` creates missing parents
# as root, which would leave root-owned directories in the account's home.
# Existing root-owned entries are repaired here too.
for d in "${home}/.local" "${home}/.local/apps" \
         "${home}/.local/apps/app" "${home}/.local/apps/app-dev" \
         "${home}/.config" "${home}/.config/systemd" "$unit_dir"; do
  if [[ ! -d "$d" ]]; then
    install -d -m 2770 -o "$USERNAME" -g "$group" "$d"
    log "created ${d}"
  elif [[ "$(stat -c %u "$d")" == "0" ]]; then
    chown "$USERNAME:$group" "$d"
    log "fixed ownership: ${d}"
  fi
done

# A user manager must exist for the units to run, including at boot.
loginctl enable-linger "$USERNAME" >/dev/null 2>&1 || warn "could not enable linger for ${USERNAME}"
for _ in $(seq 1 20); do
  [[ -S "/run/user/${uid}/systemd/private" ]] && break
  sleep 1
done

changed=0
write_unit() {
  local slot="$1" port="$2" path="${unit_dir}/$1.service" tmp
  tmp="$(mktemp)"
  unit_text "$slot" "$port" >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$path" "$tmp"; then
    rm -f "$tmp"
    log "unchanged: ${path}"
    return 0
  fi
  install -m 0644 -o "$USERNAME" -g "$group" "$tmp" "$path"
  rm -f "$tmp"
  changed=1
  log "wrote: ${path}"
}
write_unit app "$KUNGURU_APP_PORT"
write_unit app-dev "$KUNGURU_APP_DEV_PORT"

run_as_user() {
  runuser -u "$USERNAME" -- env -i \
    HOME="$home" \
    USER="$USERNAME" LOGNAME="$USERNAME" SHELL=/bin/bash \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash -c "cd '${home}' && $1"
}

if ! run_as_user 'systemctl --user show-environment >/dev/null' 2>/dev/null; then
  warn "user manager for ${USERNAME} is not reachable; units installed but not enabled"
  exit 1
fi

if (( changed )); then
  run_as_user 'systemctl --user daemon-reload'
fi
run_as_user 'systemctl --user enable app.service app-dev.service' >/dev/null

# Start a slot only when its run script exists (a fresh account has no code).
for pair in "app:${KUNGURU_APP_PORT}" "app-dev:${KUNGURU_APP_DEV_PORT}"; do
  slot="${pair%%:*}"
  run="${home}/.local/apps/${slot}/run"
  if [[ -x "$run" ]]; then
    run_as_user "systemctl --user start ${slot}.service" || \
      warn "${slot}.service failed to start; see the app's logs"
  else
    log "${slot}: no executable run script yet (unit installed, inactive)"
  fi
done

for slot in app app-dev; do
  state="$(run_as_user "systemctl --user is-active ${slot}.service" 2>/dev/null || true)"
  printf '[apps] %s.service: %s\n' "$slot" "${state:-inactive}"
done
log "app slots converged for ${USERNAME}"
