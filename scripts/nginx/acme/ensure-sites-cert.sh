#!/usr/bin/env bash
# Issue/renew the shared per-user sites certificate as a wildcard pair, using
# Joker DNS-01 via certbot's manual plugin. Run as root on the gateway.
#
# The certificate covers every hostname the per-user sites vhost (and the app
# and Bifrost vhosts, which reuse it) serve:
#   *.kunguru.net          users., llm., <user>., public aliases
#   *.users.kunguru.net    <user>.users., <user>-agent.users., private aliases
#
# Because the SAN set is fixed, this is a one-time job: after the first issue,
# certbot.timer renews it. Reconcile (scripts/nginx/ensure-user-sites.sh) never
# touches certificates, so adding users/aliases no longer re-issues anything.
#
# Env:
#   KUNGURU_BASE_DOMAIN       e.g. kunguru.net                        (required)
#   KUNGURU_ACME_EMAIL        ACME contact                            (required to issue)
#   KUNGURU_SITES_CERT        certbot --cert-name          (default: kunguru-sites)
#   KUNGURU_ACME_CREDENTIALS  Joker creds env file  (default: /etc/letsencrypt/secrets/<base>.env)
#   KUNGURU_FORCE=1           re-issue even if the current cert already matches
set -euo pipefail

base="${KUNGURU_BASE_DOMAIN:?missing KUNGURU_BASE_DOMAIN}"
cert_name="${KUNGURU_SITES_CERT:-kunguru-sites}"
email="${KUNGURU_ACME_EMAIL:-}"
creds="${KUNGURU_ACME_CREDENTIALS:-/etc/letsencrypt/secrets/${base}.env}"
force="${KUNGURU_FORCE:-0}"

here="$(cd "$(dirname "$0")" && pwd)"
hook="${here}/joker-hook.sh"
cert_dir="/etc/letsencrypt/live/${cert_name}"

command -v certbot >/dev/null || { echo "error: certbot not installed" >&2; exit 1; }
[[ -r "$hook" ]] || { echo "error: hook not found: ${hook}" >&2; exit 1; }
[[ -r "$creds" ]] || { echo "error: credentials not readable: ${creds}" >&2; exit 1; }
[[ -n "$email" ]] || { echo "error: KUNGURU_ACME_EMAIL unset" >&2; exit 1; }

want="$(printf '%s\n' "*.${base}" "*.users.${base}" | sort -u | tr '\n' ' ')"
want="${want% }"

# Idempotent: skip when the current cert already has exactly the desired SANs.
if [[ -f "${cert_dir}/cert.pem" && "$force" != "1" ]]; then
  have="$(openssl x509 -in "${cert_dir}/cert.pem" -noout -ext subjectAltName 2>/dev/null \
    | sed -n '2,$p' | tr -d ' ' | tr ',' '\n' | sed -n 's/^DNS://p' | sort -u | tr '\n' ' ')"
  have="${have% }"
  if [[ "$have" == "$want" ]]; then
    echo "[ok] certificate ${cert_name} already covers: ${want}"
    exit 0
  fi
  echo "[info] ${cert_name} SANs are '${have}'; re-issuing for '${want}'"
fi

args=(
  certonly --manual --preferred-challenges dns
  --cert-name "$cert_name"
  --manual-auth-hook "${hook} add ${base} ${creds}"
  --manual-cleanup-hook "${hook} rm ${base} ${creds}"
  --deploy-hook 'systemctl reload nginx'
  --non-interactive --agree-tos -m "$email"
  -d "*.${base}" -d "*.users.${base}"
)
[[ "$force" == "1" ]] && args+=(--force-renewal)

certbot "${args[@]}"
