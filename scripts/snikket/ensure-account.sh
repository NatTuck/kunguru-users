# snikket/ensure-account.sh  (run as root on the Snikket host over `sudo bash -s`)
#
# Idempotently converges a Snikket (Prosody) account. An existing account is
# left exactly as it is -- re-running setup must never change something already
# set up (in particular, it must not reset a user's password). The account's
# password is only set when the account is created, or when SNIKKET_ACCOUNT_FORCE=1
# explicitly requests a reset (used by password reset and by re-enabling a user
# whose XMPP credential was intentionally randomized).
#
# The secret is taken from the environment only and is never printed.
#
# Required env: SNIKKET_ACCOUNT_USERNAME
#   SNIKKET_ACCOUNT_PASSWORD (needed only when creating or forcing)
#   SNIKKET_ACCOUNT_FORCE    (default 0; 1 = reset an existing account)
#   SNIKKET_CONTAINER        (default snikket)

set -euo pipefail

: "${SNIKKET_ACCOUNT_USERNAME:?missing required env: SNIKKET_ACCOUNT_USERNAME}"
container="${SNIKKET_CONTAINER:-snikket}"
force="${SNIKKET_ACCOUNT_FORCE:-0}"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not available on the Snikket host" >&2
  exit 1
fi

if [[ ! "$SNIKKET_ACCOUNT_USERNAME" =~ ^[a-z0-9._-]{1,64}$ ]]; then
  echo "error: invalid xmpp username '${SNIKKET_ACCOUNT_USERNAME}'" >&2
  exit 1
fi

domain="$(docker exec "$container" printenv SNIKKET_DOMAIN 2>/dev/null)"
if [[ -z "$domain" ]]; then
  echo "error: could not read SNIKKET_DOMAIN from container '$container'" >&2
  exit 1
fi

# Account files live under Snikket's data volume (the default files backend):
#   /snikket/prosody/<domain>/accounts/<user>.dat
account_file="/snikket/prosody/${domain}/accounts/${SNIKKET_ACCOUNT_USERNAME}.dat"
exists=0
if docker exec "$container" test -f "$account_file" 2>/dev/null; then
  exists=1
elif docker exec "$container" test -f /snikket/prosody/prosody.sqlite 2>/dev/null; then
  # Non-default sqlite backend: we cannot cheaply probe account existence, so
  # fall back to always re-applying (which resets the password).
  echo "warning: snikket uses the sqlite backend; cannot preserve existing account passwords" >&2
fi

if (( exists )) && [[ "$force" != "1" ]]; then
  echo "[ok] snikket account '${SNIKKET_ACCOUNT_USERNAME}@${domain}' already exists (unchanged)"
  exit 0
fi

: "${SNIKKET_ACCOUNT_PASSWORD:?missing required env: SNIKKET_ACCOUNT_PASSWORD (needed to create or reset the account)}"

# prosodyctl register creates the account (if absent) and sets its SCRAM
# credential. We only reach it for a missing account or an explicit reset.
if docker exec "$container" prosodyctl register \
  "$SNIKKET_ACCOUNT_USERNAME" "$domain" "$SNIKKET_ACCOUNT_PASSWORD" \
  >/tmp/snikket-register.log 2>&1; then
  if (( exists )); then
    echo "[ok] snikket account '${SNIKKET_ACCOUNT_USERNAME}@${domain}' password updated"
  else
    echo "[ok] snikket account '${SNIKKET_ACCOUNT_USERNAME}@${domain}' created"
  fi
  rm -f /tmp/snikket-register.log
else
  cat /tmp/snikket-register.log >&2
  rm -f /tmp/snikket-register.log
  echo "error: failed to configure snikket account '${SNIKKET_ACCOUNT_USERNAME}@${domain}'" >&2
  exit 1
fi
