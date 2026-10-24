#!/usr/bin/env bash
# account/ensure-group.sh  (run as root on the group's host, via the app)
#
# Ensures the Linux account that backs a group. A group is a normal Linux user
# (`kind='group'` in the app) whose primary group is the same name; members are
# added to that group (scripts/account/ensure-membership.sh), so the shared home
# is reachable by them. Login is locked: nobody signs in as a group.
#
# Env:
#   USERNAME (required)   group name (the Linux user and group)
#
# Idempotent.
set -euo pipefail

log() { printf '[group] %s\n' "$*"; }

: "${USERNAME:?missing required env: USERNAME}"
if [[ ! "$USERNAME" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
  echo "error: invalid group name '$USERNAME'" >&2
  exit 1
fi

if id "$USERNAME" >/dev/null 2>&1; then
  log "linux account '${USERNAME}' already exists on $(hostname)"
else
  useradd -m -s /bin/bash -U "$USERNAME"
  passwd -l "$USERNAME" >/dev/null
  log "created linux account '${USERNAME}' on $(hostname) (password locked)"
fi

if ! getent group "$USERNAME" >/dev/null; then
  echo "error: linux group '$USERNAME' does not exist" >&2
  exit 1
fi

home="$(getent passwd "$USERNAME" | cut -d: -f6)"
if [[ ! -d "$home" ]]; then
  echo "error: home directory '$home' is missing" >&2
  exit 1
fi

# Members share the tree: group read/write, setgid so new files stay in the
# group. Other tenants are neither owner nor group and cannot enter.
chown "${USERNAME}:${USERNAME}" "$home"
chmod 2770 "$home"
log "home ${home} is 2770 ${USERNAME}:${USERNAME} (setgid)"

if ! runuser -u "$USERNAME" -- test -w "$home" 2>/dev/null; then
  echo "error: the group account cannot write its own home" >&2
  exit 1
fi

log "group account '${USERNAME}' converged on $(hostname)"
