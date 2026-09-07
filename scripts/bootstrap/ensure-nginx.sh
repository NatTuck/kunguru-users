# ensure-nginx.sh  (run as root on the public gateway, via BOOTSTRAP_SSH_USER)
#
# Converges nginx to OWN ports 80/443 on this host and reverse-proxy Snikket
# (which runs on alternate ports). Steps, all idempotent:
#   1. install nginx + certbot tooling
#   2. remove the legacy wg DNAT of :80/:443 -> VPN peer (live iptables + strip
#      the PostUp/PostDown lines from the wg config) so nginx can bind them
#   3. write the Snikket vhost:
#        * :80  -> proxy to Snikket's HTTP tweak port (incl. /.well-known ACME,
#                  so Snikket's own cert manager can solve HTTP-01)
#        * :443 -> when Snikket's certs exist, terminate TLS with them and proxy
#                  to Snikket's HTTPS tweak port (verify-off upstream)
#   4. reject unknown HTTPS hostnames (ssl_reject_handshake default)
#   5. reload nginx
#
# TLS model: Snikket's cert-manager is the single ACME owner for the Snikket
# hostnames; nginx reuses those certs (no certbot for these names), so the two
# ACME clients can never fight over HTTP-01.
#
# Required env: SNIKKET_DOMAIN
#   SNIKKET_TWEAK_HTTP_PORT (5080) SNIKKET_TWEAK_HTTPS_PORT (5443)
#   WG_IFACE (for DNAT strip)      DNAT_TARGETS (default 10.0.1.2)
#   SNIKKET_SERVER_CONTAINER (snikket)

need SNIKKET_DOMAIN

http_port="${SNIKKET_TWEAK_HTTP_PORT:-5080}"
https_port="${SNIKKET_TWEAK_HTTPS_PORT:-5443}"
wg_iface="${WG_IFACE:-wg0}"
container="${SNIKKET_SERVER_CONTAINER:-snikket}"
bifrost_domain="${BIFROST_DOMAIN:-}"
bifrost_port="${BIFROST_PORT:-8181}"
wg_conf="/etc/wireguard/${wg_iface}.conf"

apt_ensure nginx certbot python3-certbot-nginx

# --- Default Debian vhost: ensure present & enabled ---
if [[ ! -e /etc/nginx/sites-enabled/default ]] && [[ -f /etc/nginx/sites-available/default ]]; then
  ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
  log "enabled default vhost"
fi
svc_ensure nginx

# ---------------------------------------------------------------------------
# Remove legacy DNAT of public :80/:443 into the VPN peer LAN.
# ---------------------------------------------------------------------------
log "removing legacy DNAT of :80/:443 (so nginx can own them)"
wan_ifaces=()
default_dev="$(ip route show default 2>/dev/null | awk '/default/{print $5; exit}')"
[[ -n "${default_dev}" ]] && wan_ifaces+=("${default_dev}")
for d in eth0 ens3 enp1s0; do [[ " ${wan_ifaces[*]} " != *" $d "* ]] && wan_ifaces+=("$d"); done
for dport in 80 443; do
  for target in ${DNAT_TARGETS:-10.0.1.2}; do
    for dev in "${wan_ifaces[@]}"; do
      rule=(-t nat -C PREROUTING -i "$dev" -p tcp --dport "$dport" -j DNAT --to-destination "${target}:${dport}")
      if iptables "${rule[@]}" 2>/dev/null; then
        iptables -t nat -D PREROUTING -i "$dev" -p tcp --dport "$dport" -j DNAT --to-destination "${target}:${dport}"
        log "deleted live DNAT rule: -i $dev dport $dport -> $target:$dport"
      fi
    done
  done
done

# Strip the same DNAT commands from the wg config so they don't return on boot.
if [[ -f "$wg_conf" ]] && grep -q 'PREROUTING.*dport \(80\|443\)' "$wg_conf"; then
  if ! cmd_exists python3; then apt_ensure python3; fi
  cp -a "$wg_conf" "${wg_conf}.bootstrap.bak"
  python3 - "$wg_conf" <<'PYEOF'
import re, sys
path = sys.argv[1]
text = open(path).read()
dnat = re.compile(
    r'iptables\s+-t\s+nat\s+-[AD]\s+PREROUTING\s+'
    r'(-i\s+\S+\s+)?.*?--dport\s+(80|443)\b.*?--to-destination\s+\S+'
)
def strip(line):
    parts = line.split(';')
    keep = [p for p in parts if not dnat.search(p.strip())]
    out = ';'.join(keep)
    out = re.sub(r'\s{2,}', ' ', out).strip().rstrip(';').strip()
    return out
lines = []
for line in text.splitlines():
    m = re.match(r'^(Post(?:Up|Down))\s*=\s*(.*)$', line)
    if m:
        val = strip(m.group(2))
        if val:
            lines.append(f"{m.group(1)} = {val}")
        continue
    lines.append(line)
open(path, 'w').write('\n'.join(lines) + '\n')
PYEOF
  chmod 0600 "$wg_conf"
  log "stripped DNAT from ${wg_conf} (backup: ${wg_conf}.bootstrap.bak)"
fi

# ---------------------------------------------------------------------------
# Snikket vhost
# ---------------------------------------------------------------------------
# Snikket cert-manager certs live in the snikket data volume on the host.
cert_dir=""
if cmd_exists docker && docker inspect "$container" >/dev/null 2>&1; then
  data_dir="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/snikket"}}{{.Source}}{{end}}{{end}}' "$container" 2>/dev/null)"
  [[ -n "$data_dir" ]] && cert_dir="${data_dir}/letsencrypt/live/${SNIKKET_DOMAIN}"
fi

site="snikket-${SNIKKET_DOMAIN%%.*}"
vhost="/etc/nginx/sites-available/${site}"
tmp="$(mktemp)"
has_cert=0
[[ -n "$cert_dir" && -f "$cert_dir/fullchain.pem" && -f "$cert_dir/privkey.pem" ]] && has_cert=1

{
  cat <<EOF
# Snikket ($SNIKKET_DOMAIN) behind nginx -- managed by kunguru bootstrap.
# Plain HTTP: proxy to Snikket's tweak port (acme-challenge included) so the
# Snikket cert manager can obtain/renew certificates.
server {
    listen 80;
    listen [::]:80;
    server_name ${SNIKKET_DOMAIN} groups.${SNIKKET_DOMAIN} share.${SNIKKET_DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${http_port}/;
        proxy_set_header Host              \$host;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto http;
        client_max_body_size 104857616;
        proxy_set_header Connection \$http_connection;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_read_timeout 900s;
    }
}
EOF
  if (( has_cert )); then
    cat <<EOF

# HTTPS: terminate TLS using Snikket's own certificates, then proxy to its
# HTTPS tweak port (upstream identity checked via SNI, cert verify off).
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${SNIKKET_DOMAIN} groups.${SNIKKET_DOMAIN} share.${SNIKKET_DOMAIN};

    ssl_certificate     ${cert_dir}/fullchain.pem;
    ssl_certificate_key ${cert_dir}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass https://127.0.0.1:${https_port}/;
        proxy_set_header Host              \$host;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_ssl_server_name on;
        proxy_ssl_verify off;
        proxy_ssl_name \$host;
        client_max_body_size 104857616;
        proxy_set_header Connection \$http_connection;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_read_timeout 900s;
    }
}
EOF
  fi
} >"$tmp"

changed=0
if [[ -f "$vhost" ]] && cmp -s "$vhost" "$tmp"; then
  log "nginx snikket vhost unchanged"
else
  install -m 0644 -o root -g root "$tmp" "$vhost"
  changed=1
  log "wrote nginx snikket vhost: ${vhost}"
fi
rm -f "$tmp"
[[ -e "/etc/nginx/sites-enabled/${site}" ]] || ln -s "$vhost" "/etc/nginx/sites-enabled/${site}"

# ---------------------------------------------------------------------------
# Bifrost LLM gateway vhost (optional; present only when BIFROST_DOMAIN is set)
# ---------------------------------------------------------------------------
# Serves https://<BIFROST_DOMAIN> -> the Bifrost container on 127.0.0.1:
#   * :80  -> ACME webroot (certbot certonly --webroot) + proxy
#   * :443 -> when a certbot cert exists for the name, terminate TLS with it and
#             proxy with streaming-safe settings (SSE / WebSocket)
# certbot is the ACME owner here (Snikket names are never touched by it).
if [[ -n "${bifrost_domain}" ]]; then
  mkdir -p /var/www/certbot
  bsite="bifrost-${bifrost_domain%%.*}"
  bvhost="/etc/nginx/sites-available/${bsite}"
  has_bcert=0
  if [[ -f "/etc/letsencrypt/live/${bifrost_domain}/fullchain.pem" && \
        -f "/etc/letsencrypt/live/${bifrost_domain}/privkey.pem" ]]; then
    has_bcert=1
  fi
  tmp="$(mktemp)"
  {
    cat <<EOF
# Bifrost gateway (${bifrost_domain}) behind nginx -- managed by kunguru bootstrap.
# HTTP: ACME webroot + proxy to the Bifrost container.
server {
    listen 80;
    listen [::]:80;
    server_name ${bifrost_domain};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://127.0.0.1:${bifrost_port}/;
        proxy_set_header Host              \$host;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 104857616;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_set_header Connection \$http_connection;
        proxy_set_header Upgrade \$http_upgrade;
    }
}
EOF
    if (( has_bcert )); then
      cat <<EOF

# HTTPS: terminate TLS with the certbot certificate; streaming-safe proxy.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${bifrost_domain};

    ssl_certificate     /etc/letsencrypt/live/${bifrost_domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${bifrost_domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:${bifrost_port}/;
        proxy_set_header Host              \$host;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        client_max_body_size 104857616;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_set_header Connection \$http_connection;
        proxy_set_header Upgrade \$http_upgrade;
    }
}
EOF
    fi
  } >"$tmp"
  changed=0
  if [[ -f "$bvhost" ]] && cmp -s "$bvhost" "$tmp"; then
    log "nginx bifrost vhost unchanged"
  else
    install -m 0644 -o root -g root "$tmp" "$bvhost"
    changed=1
    log "wrote nginx bifrost vhost: ${bvhost}"
  fi
  rm -f "$tmp"
  [[ -e "/etc/nginx/sites-enabled/${bsite}" ]] || ln -s "$bvhost" "/etc/nginx/sites-enabled/${bsite}"
fi

# ---------------------------------------------------------------------------
# Unknown-HTTPS-host rejection (avoids exposing Snikket certs to random SNI).
# ---------------------------------------------------------------------------
reject_site="/etc/nginx/sites-available/kunguru-reject-https"
tmp="$(mktemp)"
cat >"$tmp" <<'EOF'
# Reject HTTPS connections for hostnames nginx does not know.
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    ssl_reject_handshake on;
}
EOF
if [[ -f "$reject_site" ]] && cmp -s "$reject_site" "$tmp"; then
  log "nginx reject-https vhost unchanged"
else
  install -m 0644 -o root -g root "$tmp" "$reject_site"
  log "wrote nginx reject-https vhost"
fi
rm -f "$tmp"
[[ -e "/etc/nginx/sites-enabled/kunguru-reject-https" ]] || \
  ln -s "$reject_site" "/etc/nginx/sites-enabled/kunguru-reject-https"

# ---------------------------------------------------------------------------
nginx -t
systemctl reload nginx
log "nginx reloaded"

if (( has_cert )); then
  log "ensure-nginx complete: HTTPS enabled for ${SNIKKET_DOMAIN} (+groups./share.)"
else
  log "ensure-nginx complete: HTTP only (waiting on Snikket certs at ${cert_dir:-<unknown>}); rerun once they exist"
fi
