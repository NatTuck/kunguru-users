#!/usr/bin/env bash
# kunguru bootstrap orchestrator.
#
# Converges the infrastructure that precedes user provisioning:
#   * passwordless ssh access for the controller (ssh-access)
#   * WireGuard hub adopt/verify (wireguard)
#   * Snikket containers on the gateway (snikket)
#   * Bifrost LLM gateway containers on the gateway (bifrost)
#   * nginx owning 80/443 + Snikket/Bifrost reverse proxies (nginx)
#
# Run it from ANY machine that can reach the group over ssh (it does not need
# to be the host the web app runs on):
#
#   cp scripts/bootstrap/group.conf.example scripts/bootstrap/group.conf  # edit it
#   ./scripts/bootstrap/bootstrap.sh --check
#   ./scripts/bootstrap/bootstrap.sh --apply
#   ./scripts/bootstrap/bootstrap.sh --apply --only wireguard
#
# Every step is idempotent and safe to re-run.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${DIR}/../lib/common.sh"
CONF="${DIR}/group.conf"

MODE="--check"
ONLY=""
WAIT_CERTS=0
while (($#)); do
  case "$1" in
    --check) MODE="--check"; shift ;;
    --apply) MODE="--apply"; shift ;;
    --only) ONLY="${2:?--only requires a step name}"; shift 2 ;;
    --wait-certs) WAIT_CERTS=1; shift ;;
    *) echo "usage: bootstrap.sh [--check|--apply] [--only step] [--wait-certs]" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$CONF" ]]; then
  echo "missing inventory: $CONF (copy group.conf.example and edit)" >&2
  exit 1
fi
# shellcheck source=group.conf.example
source "$CONF"

need() { [[ -n "${!1:-}" ]] || { echo "group.conf: missing $1" >&2; exit 1; }; }
need BOOTSTRAP_SSH_USER
need PUBLIC_IP
need PUBLIC_FQDN

declare -A SSH_BY_HOST=()
for h in "${!HOST_ROLES[@]}"; do SSH_BY_HOST[$h]="${HOST_SSH[$h]:-$h}"; done

HUB=""
for h in "${!HOST_ROLES[@]}"; do [[ "${HOST_ROLES[$h]}" == "hub" ]] && HUB="$h"; done
[[ -n "$HUB" ]] || { echo "group.conf: no host with role=hub" >&2; exit 1; }

ssh_addr() { echo "${SSH_BY_HOST[$1]}"; }

# run_remote USER SSH_HOST SCRIPT [KEY=VAL...]
# Pipes lib + env exports + script to `sudo bash -s` on the target.
run_remote() {
  local user="$1" rhost="$2" script="$3"
  shift 3
  {
    local kv name val
    for kv in "$@"; do
      name="${kv%%=*}"
      val="${kv#*=}"
      printf 'export %s=%q\n' "$name" "$val"
    done
    cat "$LIB"
    cat "$DIR/$script"
  } | ssh -o BatchMode=yes -o ConnectTimeout=10 "${user}@${rhost}" 'sudo -n bash -s'
}

# run_check USER SSH_HOST: non-destructive status read via a shell snippet.
run_check() {
  local user="$1" rhost="$2"
  local stmt='set -e
echo "  host: $(hostname)  distro: $(. /etc/os-release; echo $PRETTY_NAME)"
echo "  sudo:  $(sudo -n true 2>/dev/null && echo ok || echo FAIL)"
echo "  wg:    $(ip -brief addr show 2>/dev/null | grep -q wg && echo up || echo down)  $(systemctl is-active wg-quick@wg0 2>/dev/null || true)"
echo "  docker:$(command -v docker >/dev/null && docker --version || echo none)"
echo "  nginx: $(command -v nginx >/dev/null && nginx -v 2>&1 || echo none)"
  echo "  snikket:$(docker inspect snikket >/dev/null 2>&1 && echo containers-present || (test -d /etc/snikket && echo config-only || echo none))"
  echo "  bifrost:$(b=$(docker inspect -f '{{.State.Running}}' bifrost 2>/dev/null); case "$b" in true) echo up;; false) echo down;; *) echo none;; esac)"'
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${user}@${rhost}" 'sudo -n bash -s' <<<"$stmt"
}

user_can_sudo() {
  local user="$1" rhost="$2"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${user}@${rhost}" 'sudo -n true' 2>/dev/null
}

step() { echo; echo "===== step: $1 ====="; }

apply_step_ssh_access() {
  [[ -z "$INIT_SSH_USER" ]] && { echo "INIT_SSH_USER unset; skipping ssh-access"; return; }
  need CONTROLLER_SSH_KEY
  [[ -f "${CONTROLLER_SSH_KEY/#\~/$HOME}" ]] || { echo "controller key not found: $CONTROLLER_SSH_KEY" >&2; exit 1; }
  local pub
  pub="$(cat "${CONTROLLER_SSH_KEY/#\~/$HOME}")"
  local h
  for h in "${!HOST_ROLES[@]}"; do
    step "ssh-access: $h"
    run_remote "$INIT_SSH_USER" "$(ssh_addr "$h")" ensure-ssh-access.sh \
      BOOTSTRAP_SSH_USER="$BOOTSTRAP_SSH_USER" PUBKEY="$pub"
    user_can_sudo "$BOOTSTRAP_SSH_USER" "$(ssh_addr "$h")" \
      || { echo "ssh-access verify FAILED for ${BOOTSTRAP_SSH_USER}@$h" >&2; exit 1; }
  done
}

apply_step_wireguard() {
  local reach=() h
  for h in "${!HOST_PEER_IP[@]}"; do reach+=("${HOST_PEER_IP[$h]}"); done
  step "wireguard (hub ${HUB})"
  run_remote "$BOOTSTRAP_SSH_USER" "$(ssh_addr "$HUB")" ensure-wireguard.sh \
    HOSTNAME_BOOTSTRAP="$HUB" \
    WG_IFACE="$WG_IFACE" WG_HUB_IP="$WG_HUB_IP" \
    WG_SUBNET="$WG_SUBNET" WG_PORT="$WG_PORT" \
    REACH_HOSTS="${reach[*]}"
}

apply_step_snikket() {
  need SNIKKET_DOMAIN
  need SNIKKET_ADMIN_EMAIL
  step "snikket (${SNIKKET_HOST})"
  run_remote "$BOOTSTRAP_SSH_USER" "${SSH_BY_HOST[$SNIKKET_HOST]}" ensure-snikket.sh \
    SNIKKET_DOMAIN="$SNIKKET_DOMAIN" SNIKKET_ADMIN_EMAIL="$SNIKKET_ADMIN_EMAIL" \
    SNIKKET_TWEAK_HTTP_PORT="${SNIKKET_TWEAK_HTTP_PORT:-5080}" \
    SNIKKET_TWEAK_HTTPS_PORT="${SNIKKET_TWEAK_HTTPS_PORT:-5443}"
}

apply_step_bifrost() {
  local bhost="${BIFROST_HOST:-$HUB}"
  step "bifrost (${bhost})"
  run_remote "$BOOTSTRAP_SSH_USER" "${SSH_BY_HOST[$bhost]}" ensure-bifrost.sh \
    BIFROST_PORT="${BIFROST_PORT:-8181}" \
    BIFROST_IMAGE="${BIFROST_IMAGE:-maximhq/bifrost:v2.0.0}" \
    BIFROST_DOMAIN="${BIFROST_DOMAIN:-}" \
    BIFROST_ADMIN_USERNAME="${BIFROST_ADMIN_USERNAME:-admin}" \
    BIFROST_CORS_ORIGINS="${BIFROST_CORS_ORIGINS:-*}"
}

apply_step_nginx() {
  step "nginx (${HUB} owns 80/443)"
  run_remote "$BOOTSTRAP_SSH_USER" "$(ssh_addr "$HUB")" ensure-nginx.sh \
    SNIKKET_DOMAIN="$SNIKKET_DOMAIN" \
    SNIKKET_TWEAK_HTTP_PORT="${SNIKKET_TWEAK_HTTP_PORT:-5080}" \
    SNIKKET_TWEAK_HTTPS_PORT="${SNIKKET_TWEAK_HTTPS_PORT:-5443}" \
    WG_IFACE="$WG_IFACE" DNAT_TARGETS="${DNAT_TARGETS:-10.0.1.2}" \
    BIFROST_DOMAIN="${BIFROST_DOMAIN:-}" \
    BIFROST_PORT="${BIFROST_PORT:-8181}"
}

# Wait for Snikket's cert-manager to obtain certs (proxied through nginx :80).
snikket_cert_ready() {
  local h="$SNIKKET_HOST" data dom="${SNIKKET_DOMAIN}"
  data="$(ssh -o BatchMode=yes -o ConnectTimeout=10 \
    "${BOOTSTRAP_SSH_USER}@$(ssh_addr "$h")" \
    "sudo -n SNIKKET_DOMAIN='${dom}' bash -s" <<'EOF'
set -e
d=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/snikket"}}{{.Source}}{{end}}{{end}}' snikket 2>/dev/null)
[[ -n "$d" && -f "$d/letsencrypt/live/${SNIKKET_DOMAIN}/fullchain.pem" ]] && echo ready || echo pending
EOF
  )" 2>/dev/null
  [[ "$data" == ready ]]
}

do_apply() {
  [[ -z "$ONLY" || "$ONLY" == "ssh-access" ]] && apply_step_ssh_access
  [[ -z "$ONLY" || "$ONLY" == "wireguard" ]] && apply_step_wireguard
  if [[ -z "$ONLY" || "$ONLY" == "snikket" ]]; then apply_step_snikket; fi
  if [[ -z "$ONLY" || "$ONLY" == "bifrost" ]]; then apply_step_bifrost; fi
  if [[ -z "$ONLY" || "$ONLY" == "nginx" ]]; then apply_step_nginx; fi

  # Snikket's cert-manager obtains certs on its OWN schedule (startup + hourly
  # anacron). We never force ACME runs here. When certs exist, converge nginx
  # to HTTPS. Without --wait-certs we just tell the operator what to do.
  if [[ -z "$ONLY" ]] && [[ -n "$SNIKKET_DOMAIN" ]]; then
    if (( WAIT_CERTS )); then
      echo; echo "===== waiting for Snikket certificates (own schedule; HTTP-01 via nginx) ====="
      local i=0
      while ! snikket_cert_ready; do
        i=$((i + 1))
        if (( i > 60 )); then
          echo "timed out after ~15 min; cert-manager retries hourly, so rerun later:" >&2
          echo "  ./scripts/bootstrap/bootstrap.sh --apply --only nginx" >&2
          exit 1
        fi
        echo "  ... not yet (${i}); checking again in 15s"
        sleep 15
      done
      echo "  Snikket certs present."
      apply_step_nginx
    else
      echo
      echo "NOTE: Snikket cert-manager obtains certs on its own hourly schedule."
      echo "Once they exist, enable the HTTPS vhost by re-running:"
      echo "  ./scripts/bootstrap/bootstrap.sh --apply --only nginx"
    fi
  fi
}

do_check() {
  echo "== group inventory =="
  echo "  hub:            $HUB ($PUBLIC_FQDN / $PUBLIC_IP)"
  echo "  ssh user:       $BOOTSTRAP_SSH_USER (init via ${INIT_SSH_USER:-<none>})"
  echo "  snikket domain: ${SNIKKET_DOMAIN:-<unset>} on ${SNIKKET_HOST}"
  echo "  bifrost:        ${BIFROST_DOMAIN:-<unset>} on ${BIFROST_HOST:-$HUB}"
  for h in "${!HOST_ROLES[@]}"; do
    echo "== ${h} [${HOST_ROLES[$h]}] =="
    run_check "$BOOTSTRAP_SSH_USER" "$(ssh_addr "$h")" || \
      echo "  (unreachable as ${BOOTSTRAP_SSH_USER}; run --apply ssh-access)" 
  done
}

case "$MODE" in
  --check) do_check ;;
  --apply) do_apply ;;
  *) echo "usage: bootstrap.sh [--check|--apply] [--only step]"; exit 1 ;;
esac
