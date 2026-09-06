# account/ensure.sh  (run as root on the target host over `sudo bash -s`)
#
# Idempotently ensures an empty Linux account exists for USERNAME. Safe on a
# clean host and on a host where the account already exists (no-op). Password
# is locked: authentication is key-only until a later credential step.

set -euo pipefail

: "${USERNAME:?missing required env: USERNAME}"

if [[ ! "$USERNAME" =~ ^[a-z][a-z0-9._-]{0,31}$ ]]; then
  echo "error: invalid linux username '$USERNAME'" >&2
  exit 1
fi

if id "$USERNAME" >/dev/null 2>&1; then
  echo "[ok] linux account '${USERNAME}' already exists on $(hostname)"
else
  useradd -m -s /bin/bash -U "$USERNAME"
  passwd -l "$USERNAME" >/dev/null
  echo "[changed] created linux account '${USERNAME}' on $(hostname) (password locked)"
fi
