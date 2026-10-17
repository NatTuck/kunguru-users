#!/usr/bin/env bash
# certbot --manual DNS-01 hooks for Joker.com (svc.joker.com /nic/replace).
#
# Usage (this exact command is stored in the certbot renewal config):
#   joker-hook.sh add <zone> <credentials-file>
#   joker-hook.sh rm  <zone> <credentials-file>
#
# certbot exports CERTBOT_DOMAIN and CERTBOT_VALIDATION. Joker's /nic/replace
# replaces *all* TXT values at a label on every call, so each name being
# validated must map to its own label. The wildcard pair does:
#   *.kunguru.net        -> _acme-challenge.kunguru.net
#   *.users.kunguru.net  -> _acme-challenge.users.kunguru.net
# (different labels, so one value per call is safe and no accumulation is
# needed). If the apex is ever added to a DNS-01 cert it shares the
# _acme-challenge label with the wildcard and this hook would need to
# accumulate values -- see scripts/nginx/acme/README.md.
set -euo pipefail

action="${1:?usage: joker-hook.sh add|rm <zone> <credentials-file>}"
zone="${2:?missing zone}"
creds="${3:?missing credentials file}"

endpoint="https://svc.joker.com/nic/replace"

# Credentials file is a shell env file (root:root 0600), e.g.
# /etc/letsencrypt/secrets/kunguru.net.env with JOKER_USERNAME/JOKER_PASSWORD.
# shellcheck disable=SC1090
set -a
. "$creds"
set +a
: "${JOKER_USERNAME:?missing JOKER_USERNAME in $creds}"
: "${JOKER_PASSWORD:?missing JOKER_PASSWORD in $creds}"

domain="${CERTBOT_DOMAIN:?CERTBOT_DOMAIN not set by certbot}"
value="${CERTBOT_VALIDATION:-}"

# label = _acme-challenge + the domain's prefix below the zone:
#   kunguru.net        (prefix "")      -> _acme-challenge
#   users.kunguru.net  (prefix "users") -> _acme-challenge.users
suffix=".${zone}"
prefix=""
case "$domain" in
  "$zone") prefix="" ;;
  *"$suffix") prefix="${domain%"$suffix"}" ;;
  *)
    echo "joker-hook: domain '${domain}' is not under zone '${zone}'" >&2
    exit 1
    ;;
esac
label="_acme-challenge"
[[ -n "$prefix" ]] && label="${label}.${prefix}"

# cleanup clears the label; add sets the single value.
[[ "$action" == "rm" ]] && value=""

resp="$(curl -fsS --max-time 30 -X POST "$endpoint" \
  --data-urlencode "username=${JOKER_USERNAME}" \
  --data-urlencode "password=${JOKER_PASSWORD}" \
  --data-urlencode "zone=${zone}" \
  --data-urlencode "label=${label}" \
  --data-urlencode "type=TXT" \
  --data-urlencode "value=${value}" \
  --data-urlencode "ttl=60")" || {
  echo "joker-hook: POST to ${endpoint} failed" >&2
  exit 1
}

# Joker returns "OK: ..." on success, or a documented error token (badauth,
# nohost, !yours, ...) otherwise.
case "$resp" in
  OK*) echo "joker-hook: ${action} TXT ${label}.${zone} -> ${resp}" ;;
  *) echo "joker-hook: Joker error: ${resp}" >&2; exit 1 ;;
esac
