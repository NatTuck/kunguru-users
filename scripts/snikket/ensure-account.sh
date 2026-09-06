# snikket/ensure-account.sh  (run as root on the Snikket host over `sudo bash -s`)
#
# Idempotently converges a Snikket (Prosody) account for the given username to
# the shared password. The web-app login password and the XMPP password are the
# SAME value (see notes/expanded-design.md); this step pushes that plaintext
# into Snikket's SCRAM store. Re-running resets the password to the current
# value (drift repair). The secret is taken from the environment only and is
# never printed.
#
# Required env: SNIKKET_ACCOUNT_USERNAME  SNIKKET_ACCOUNT_PASSWORD
#   SNIKKET_CONTAINER (default snikket)

set -euo pipefail

: "${SNIKKET_ACCOUNT_USERNAME:?missing required env: SNIKKET_ACCOUNT_USERNAME}"
: "${SNIKKET_ACCOUNT_PASSWORD:?missing required env: SNIKKET_ACCOUNT_PASSWORD}"
container="${SNIKKET_CONTAINER:-snikket}"

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

# prosodyctl register creates the account (if absent) and sets its SCRAM
# credential; running it again simply resets the password. Idempotent by design.
if docker exec "$container" prosodyctl register \
  "$SNIKKET_ACCOUNT_USERNAME" "$domain" "$SNIKKET_ACCOUNT_PASSWORD" \
  >/tmp/snikket-register.log 2>&1; then
  echo "[ok] snikket account '${SNIKKET_ACCOUNT_USERNAME}@${domain}' configured"
  rm -f /tmp/snikket-register.log
else
  cat /tmp/snikket-register.log >&2
  rm -f /tmp/snikket-register.log
  echo "error: failed to configure snikket account '${SNIKKET_ACCOUNT_USERNAME}@${domain}'" >&2
  exit 1
fi
