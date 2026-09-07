# ensure-bifrost.sh  (run as root on the gateway, via BOOTSTRAP_SSH_USER)
#
# Converges a Bifrost LLM gateway (https://github.com/maximhq/bifrost) running
# in Docker on the public hub, data/config under /etc/bifrost, HTTP API bound to
# 127.0.0.1:BIFROST_PORT and served publicly by nginx (see ensure-nginx.sh):
#   * /etc/bifrost exists (owner 1000:1000 so the container uid can write SQLite)
#   * an env file holds BIFROST_ENCRYPTION_KEY + dashboard admin credentials
#     (0600; generated once on first converge and printed to the operator)
#   * config.json seeds dashboard admin auth (via env refs) and requires a
#     virtual key on inference; providers / virtual keys / budgets are added
#     later by the operator through the dashboard or API -- upstream keys are
#     secrets and are not managed by the bootstrap
#   * the container (pinned image, restart=unless-stopped) is up and /health
#     answers on the local port
#
# Idempotent: existing config/containers are adopted, never clobbered.
#
# Env: BIFROST_PORT (default 8181)  BIFROST_IMAGE (default maximhq/bifrost:v2.0.0)
#      BIFROST_BIND (default 127.0.0.1)  BIFROST_DOMAIN (informational, for the
#      one-time credential banner)  BIFROST_ADMIN_USERNAME (default admin)
#      BIFROST_CORS_ORIGINS (whitespace-separated origins, default "*")
#
# The `client` config section (CORS origins, enforce_auth_on_inference, ...) is
# owned by this config.json: Bifrost re-applies it on startup, so UI edits to
# fields in that section do NOT survive a restart. Change them here (group.conf
# -> BIFROST_CORS_ORIGINS) and re-run this step, which restarts the container.

port="${BIFROST_PORT:-8181}"
bind="${BIFROST_BIND:-127.0.0.1}"
image="${BIFROST_IMAGE:-maximhq/bifrost:v2.0.0}"
domain="${BIFROST_DOMAIN:-}"
admin_user="${BIFROST_ADMIN_USERNAME:-admin}"
cors_origins="${BIFROST_CORS_ORIGINS:-*}"
dir="/etc/bifrost"
env_file="${dir}/env"
conf="${dir}/config.json"
container="bifrost"

umask 077

# --- Docker + compose (mirrors ensure-snikket.sh) ---
if ! cmd_exists docker; then
  log "installing docker"
  apt_ensure docker.io docker-compose-v2 || apt_ensure docker.io
fi
if ! systemctl is-active --quiet docker; then
  log "starting docker daemon"
  svc_ensure docker
fi

# --- /etc/bifrost (writable by the container's uid 1000) ---
mkdir -p "${dir}"
chown 1000:1000 "${dir}" 2>/dev/null || warn "could not chown ${dir} to 1000:1000"
chmod 0750 "${dir}" 2>/dev/null || warn "could not chmod ${dir} to 0750"

# --- env file (encryption key + admin credentials, generated once) ---
if [[ ! -f "${env_file}" ]]; then
  apt_ensure openssl
  enc="$(openssl rand -hex 32)"
  pass="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)"
  {
    printf 'BIFROST_ENCRYPTION_KEY=%s\n' "${enc}"
    printf 'BIFROST_ADMIN_USERNAME=%s\n' "${admin_user}"
    printf 'BIFROST_ADMIN_PASSWORD=%s\n' "${pass}"
  } > "${env_file}"
  chown root:root "${env_file}"
  chmod 0600 "${env_file}"
  log "generated ${env_file} (fresh encryption key + admin password)"
  printf '\n===== Bifrost dashboard admin (generated once -- save it) =====\n'
  printf 'url:      https://%s/\n' "${domain:-<BIFROST_DOMAIN unset; add DNS + nginx vhost>}"
  printf 'username: %s\n' "${admin_user}"
  printf 'password: %s\n' "${pass}"
  printf '================================================================\n'
else
  log "${env_file} present (adopting existing credentials)"
fi

# --- config.json (seeds admin auth + inference key enforcement; no secrets) ---
# Client-section fields (CORS origins, enforce_auth_on_inference) are owned by
# this file -- Bifrost re-applies them on startup, so do not set them in the UI.
apt_ensure python3
old_hash=""
[[ -f "${conf}" ]] && old_hash="$(sha256sum "${conf}" | cut -d' ' -f1)"
BIFROST_CORS_ORIGINS="${cors_origins}" python3 - <<'PY' | write_file "${conf}"
import json, os
origins = [o.strip() for o in os.environ["BIFROST_CORS_ORIGINS"].split() if o.strip()]
conf = {
    "$schema": "https://www.getbifrost.ai/schema",
    "encryption_key": "env.BIFROST_ENCRYPTION_KEY",
    "client": {
        "enforce_auth_on_inference": True,
        "allowed_origins": origins or ["*"],
    },
    "governance": {
        "auth_config": {
            "is_enabled": True,
            "admin_username": "env.BIFROST_ADMIN_USERNAME",
            "admin_password": "env.BIFROST_ADMIN_PASSWORD",
        }
    },
}
print(json.dumps(conf, indent=2))
PY
new_hash="$(sha256sum "${conf}" | cut -d' ' -f1)"
if [[ "${old_hash}" != "${new_hash}" ]] && \
   docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null | grep -q true; then
  docker restart "${container}" >/dev/null
  log "restarted ${container} to apply config.json"
fi

# --- Container converge (recreate only when image/port drifted) ---
if docker inspect "${container}" >/dev/null 2>&1; then
  cur_image="$(docker inspect -f '{{.Config.Image}}' "${container}" 2>/dev/null || true)"
  cur_port="$(docker port "${container}" 8080/tcp 2>/dev/null | head -1 | sed 's/.*://' || true)"
  if [[ "${cur_image}" == "${image}" && "${cur_port}" == "${port}" ]]; then
    log "bifrost container present with matching image/port (adopting)"
  else
    log "bifrost image/port drifted (${cur_image:-none}:${cur_port:-?} -> ${image}:${port}); recreating"
    docker rm -f "${container}" >/dev/null
  fi
fi

if ! docker inspect "${container}" >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}$"; then
    fail "port ${port} is already in use; Bifrost cannot bind it (set BIFROST_PORT)"
  fi
  log "starting ${container} (${image}) on ${bind}:${port}"
  docker run -d --name "${container}" --restart unless-stopped \
    --env-file "${env_file}" \
    -e APP_HOST=0.0.0.0 \
    -e APP_PORT=8080 \
    -e APP_DIR=/app/data \
    -p "${bind}:${port}:8080" \
    -v "${dir}:/app/data" \
    "${image}" >/dev/null
fi

if ! docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null | grep -q true; then
  docker start "${container}" >/dev/null
  log "started existing ${container}"
fi

# --- Wait until /health answers on the bound port ---
reachable=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://${bind}:${port}/health" 2>/dev/null; then
    reachable=1
    break
  fi
  sleep 2
done
if (( reachable )); then
  log "bifrost /health answering on ${bind}:${port}"
else
  warn "bifrost not answering /health yet (docker logs ${container})"
fi

log "ensure-bifrost complete (dashboard/API: http://${bind}:${port}; served publicly via nginx)"
