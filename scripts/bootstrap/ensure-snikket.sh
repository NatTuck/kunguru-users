# ensure-snikket.sh  (run as root on the Snikket host, via BOOTSTRAP_SSH_USER)
#
# Converges a Snikket instance running in Docker on host networking, tuned for
# the reverse-proxy layout (nginx owns 80/443 on this host):
#   * /etc/snikket exists with the official docker-compose.yml
#   * snikket.conf carries SNIKKET_DOMAIN + SNIKKET_ADMIN_EMAIL and the
#     SNIKKET_TWEAK_HTTP/HTTPS_PORT alternative web ports
#   * the containers are up and listening on the tweak ports
#
# Idempotent: existing config/containers are adopted, never clobbered.
#
# Required env: SNIKKET_DOMAIN SNIKKET_ADMIN_EMAIL
#   SNIKKET_TWEAK_HTTP_PORT (default 5080)  SNIKKET_TWEAK_HTTPS_PORT (default 5443)

need SNIKKET_DOMAIN
need SNIKKET_ADMIN_EMAIL

http_port="${SNIKKET_TWEAK_HTTP_PORT:-5080}"
https_port="${SNIKKET_TWEAK_HTTPS_PORT:-5443}"
conf_dir="/etc/snikket"

# --- Docker + compose ---
if ! cmd_exists docker; then
  log "installing docker"
  apt_ensure docker.io docker-compose-v2 || apt_ensure docker.io
fi
if ! systemctl is-active --quiet docker; then
  log "starting docker daemon"
  svc_ensure docker
fi
compose=(docker compose)
if ! docker compose version >/dev/null 2>&1; then
  if cmd_exists docker-compose; then
    compose=(docker-compose)
  else
    fail "neither 'docker compose' nor 'docker-compose' is available"
  fi
fi

# --- /etc/snikket + docker-compose.yml (official) ---
mkdir -p "${conf_dir}"
compose_file="${conf_dir}/docker-compose.yml"
if [[ ! -f "${compose_file}" ]]; then
  log "downloading official snikket docker-compose.yml"
  curl -fsSL -o "${compose_file}" \
    https://snikket.org/service/resources/docker-compose.yml
else
  log "snikket docker-compose.yml present (adopting)"
fi

# --- snikket.conf (converge managed keys; keep the file otherwise intact) ---
conf="${conf_dir}/snikket.conf"
write_file "${conf}" <<EOF
SNIKKET_DOMAIN=${SNIKKET_DOMAIN}
SNIKKET_ADMIN_EMAIL=${SNIKKET_ADMIN_EMAIL}
SNIKKET_TWEAK_HTTP_PORT=${http_port}
SNIKKET_TWEAK_HTTPS_PORT=${https_port}
EOF

# --- Port sanity (only before first bring-up; a running stack holds these) ---
already_running="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -cx 'snikket-proxy')"
if (( already_running == 0 )); then
  for port in "${http_port}" "${https_port}" 5222 5269; do
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}$"; then
      fail "port ${port} is already in use; Snikket (host networking) cannot bind it"
    fi
  done
else
  log "snikket stack already running; skipping port conflict check"
fi

# --- Launch / converge containers (from /etc/snikket so env_file resolves) ---
log "pulling snikket images (first run may take a while)"
(
  cd "${conf_dir}"
  "${compose[@]}" up -d
)

# --- Wait until the web proxy answers on the tweak HTTP port ---
reachable=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${http_port}/" 2>/dev/null; then
    reachable=1
    break
  fi
  sleep 2
done
if (( reachable )); then
  log "snikket web proxy answering on http://127.0.0.1:${http_port}"
else
  warn "snikket web proxy not answering yet on :${http_port} (cert obtainment may be pending nginx)"
fi

log "ensure-snikket complete (tweak ports: http=${http_port} https=${https_port})"

