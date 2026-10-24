#!/usr/bin/env bash
# account/ensure-membership.sh  (run as root on the group's host, via the app)
#
# Converges the Linux group membership for a group account to the desired set.
# The app is the source of truth (`group_members`); this script makes the Linux
# group match it. Membership changes apply to new sessions (and to the app's
# processes); a member's already-running shell keeps its old groups.
#
# Env:
#   USERNAME                group name (the Linux group)             (required)
#   KUNGURU_GROUP_MEMBERS   space-separated desired member usernames
#
# Idempotent.
set -euo pipefail

log()  { printf '[members] %s\n' "$*"; }
warn() { printf '[members][warn] %s\n' "$*" >&2; }

: "${USERNAME:?missing required env: USERNAME}"
members="${KUNGURU_GROUP_MEMBERS:-}"

if [[ ! "$USERNAME" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
  echo "error: invalid group name '$USERNAME'" >&2
  exit 1
fi
if ! getent group "$USERNAME" >/dev/null; then
  echo "error: linux group '$USERNAME' does not exist (run ensure-group.sh first)" >&2
  exit 1
fi

home="$(getent passwd "$USERNAME" | cut -d: -f6)"
if [[ -d "$home" ]]; then
  # Repair the shared-home permissions; membership only works with them.
  chown "${USERNAME}:${USERNAME}" "$home"
  chmod 2770 "$home"
fi

# Validate the desired set before touching anything.
declare -A want=()
for u in $members; do
  if [[ ! "$u" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
    echo "error: invalid member name '$u'" >&2
    exit 1
  fi
  if ! id "$u" >/dev/null 2>&1; then
    echo "error: member account '$u' does not exist on $(hostname)" >&2
    exit 1
  fi
  want[$u]=1
done

# Current supplementary members (the group's own primary-group user is not
# listed in /etc/group).
current="$(getent group "$USERNAME" | cut -d: -f4 | tr ',' ' ')"

for u in "${!want[@]}"; do
  if [[ " $current " == *" $u "* ]]; then
    continue
  fi
  gpasswd -a "$u" "$USERNAME" >/dev/null
  log "added ${u}"
done

for u in $current; do
  [[ -n "${want[$u]:-}" ]] && continue
  gpasswd -d "$u" "$USERNAME" >/dev/null
  log "removed ${u}"
done

final="$(getent group "$USERNAME" | cut -d: -f4)"
log "members of ${USERNAME}: ${final:-<none>}"
