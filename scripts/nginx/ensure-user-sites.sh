#!/usr/bin/env bash
# ensure-user-sites.sh  (run as root on the gateway, via the app transport)
#
# Renders the per-user nginx reverse-proxy routes plus a single combined
# Let's Encrypt certificate, then reloads nginx. Driven by the app:
#
#   KUNGURU_BASE_DOMAIN  e.g. ironbeard.com
#   KUNGURU_ROUTES       JSON array of {hostname, port, access, upstream, service}
#   KUNGURU_ACME_EMAIL   certbot contact (required to issue/renew)
#   KUNGURU_SITES_CERT   certbot --cert-name (default kunguru-sites)
#   KUNGURU_AUTH_TARGET  host:port of the app's /internal/auth (127.0.0.1:3030)
#
# Slots (see server/sites.ts):
#   <user>-hermes.users.<base>  -> private (auth_request -> Remote-User)
#   <user>.users.<base>         -> private (auth_request -> Remote-User)
#   <user>.<base>               -> public
#
# Idempotent: rewrites the map + vhosts and (re)issues the combined cert with
# every current hostname as a SAN.
set -euo pipefail

: "${KUNGURU_BASE_DOMAIN:?missing KUNGURU_BASE_DOMAIN}"
routes_json="${KUNGURU_ROUTES:-[]}"
acme_email="${KUNGURU_ACME_EMAIL:-}"
cert_name="${KUNGURU_SITES_CERT:-kunguru-sites}"
auth_target="${KUNGURU_AUTH_TARGET:-127.0.0.1:3030}"
extra_hosts="${KUNGURU_EXTRA_HOSTS:-}"

base="$KUNGURU_BASE_DOMAIN"
private="users.${base}"
webroot="/var/www/certbot"
map_conf="/etc/nginx/conf.d/kunguru-user-sites-map.conf"
site_name="kunguru-user-sites"
site="/etc/nginx/sites-available/${site_name}"
site_link="/etc/nginx/sites-enabled/${site_name}"
cert_dir="/etc/letsencrypt/live/${cert_name}"

command -v nginx >/dev/null || { echo "nginx not installed" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }
mkdir -p "$webroot"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

python3 - "$routes_json" "$base" "$private" "$cert_name" "$auth_target" "$tmp" "$extra_hosts" <<'PY'
import json, os, sys
routes_json, base, private, cert_name, auth_target, tmp = sys.argv[1:7]
extra_hosts = sys.argv[7] if len(sys.argv) > 7 else ""
webroot = "/var/www/certbot"
cert_dir = "/etc/letsencrypt/live/" + cert_name
try:
    routes = json.loads(routes_json)
except json.JSONDecodeError:
    routes = []
hosts = sorted({r["hostname"] for r in routes if r.get("hostname")} | set(extra_hosts.split()))

map_lines = [
    "# Managed by kunguru-users (scripts/nginx/ensure-user-sites.sh).",
    "map $host $kunguru_upstream {",
    "    hostnames;",
    '    default "";',
]
for r in routes:
    if r.get("hostname") and r.get("upstream"):
        map_lines.append("    {} {};".format(r["hostname"], r["upstream"]))
map_lines.append("}")
open(os.path.join(tmp, "map.conf"), "w").write("\n".join(map_lines) + "\n")
open(os.path.join(tmp, "hosts.txt"), "w").write("\n".join(hosts) + ("\n" if hosts else ""))

header = "# Managed by kunguru-users (scripts/nginx/ensure-user-sites.sh).\n"

http_server = """server {{
    listen 80;
    listen [::]:80;
    server_name *.{private} *.{base};

    location /.well-known/acme-challenge/ {{ root {webroot}; }}
    location / {{ return 301 https://$host$request_uri; }}
}}
""".format(private=private, base=base, webroot=webroot)

private_server = """server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name *.{private};

    ssl_certificate     {cert_dir}/fullchain.pem;
    ssl_certificate_key {cert_dir}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # nginx validates the app session here and forwards the owning username as
    # the trusted Remote-User header the upstream consumes.
    location = /__auth {{
        internal;
        proxy_pass http://{auth_target}/internal/auth;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-Host $host;
    }}

    location / {{
        auth_request /__auth;
        auth_request_set $auth_user $upstream_http_x_auth_user;
        proxy_set_header Remote-User $auth_user;
        proxy_set_header Remote-Groups "";

        if ($kunguru_upstream = "") {{ return 404; }}
        proxy_pass http://$kunguru_upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_max_body_size 64m;
    }}

    error_page 401 = @login;
    location @login {{
        return 302 https://{private}/login?next=$scheme://$host$request_uri;
    }}
}}
""".format(private=private, cert_dir=cert_dir, auth_target=auth_target)

public_server = """server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name *.{base};

    ssl_certificate     {cert_dir}/fullchain.pem;
    ssl_certificate_key {cert_dir}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {{
        if ($kunguru_upstream = "") {{ return 404; }}
        proxy_pass http://$kunguru_upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Remote-User "";
        proxy_set_header Remote-Groups "";
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_max_body_size 64m;
    }}
}}
""".format(base=base, cert_dir=cert_dir)

open(os.path.join(tmp, "sites-http.conf"), "w").write(header + http_server)

# Static aliases: a dedicated vhost per host serving a docroot.
static_servers = ""
for r in routes:
    if r.get("kind") == "static" and r.get("hostname") and r.get("root"):
        static_servers += """
server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {host};

    ssl_certificate     {cert_dir}/fullchain.pem;
    ssl_certificate_key {cert_dir}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    root {root};
    index index.html;
    location / {{ try_files $uri $uri/ =404; }}
}}
""".format(host=r["hostname"], root=r["root"], cert_dir=cert_dir)

open(os.path.join(tmp, "sites-full.conf"), "w").write(
    header + http_server + "\n" + private_server + "\n" + public_server + static_servers
)
PY

install -m 0644 "$tmp/map.conf" "$map_conf"

hosts_count="$(wc -l < "$tmp/hosts.txt" | tr -d ' ')"
if [[ "$hosts_count" -eq 0 ]]; then
  # No enabled users with accounts: drop the site vhost entirely.
  rm -f "$site_link"
  nginx -t && systemctl reload nginx
  echo "[ok] no user routes; removed ${site_name}"
  exit 0
fi

# 1) HTTP-only config so certbot can solve HTTP-01 for the new hostnames.
install -m 0644 "$tmp/sites-http.conf" "$site"
[[ -e "$site_link" ]] || ln -s "$site" "$site_link"
nginx -t
systemctl reload nginx

# 2) One combined certificate covering every current hostname.
if [[ -z "$acme_email" ]]; then
  echo "warning: KUNGURU_ACME_EMAIL unset; skipping certbot (HTTP only)" >&2
elif ! command -v certbot >/dev/null; then
  echo "warning: certbot not installed; serving HTTP only" >&2
else
  cert_args=()
  while IFS= read -r h; do [[ -n "$h" ]] && cert_args+=(-d "$h"); done < "$tmp/hosts.txt"
  certbot certonly --webroot -w "$webroot" --cert-name "$cert_name" --expand \
    --keep-until-expiring -n --agree-tos -m "$acme_email" "${cert_args[@]}" || \
    echo "warning: certbot failed; serving HTTP only" >&2
fi

# 3) Full vhost once the certificate exists.
if [[ -f "${cert_dir}/fullchain.pem" && -f "${cert_dir}/privkey.pem" ]]; then
  install -m 0644 "$tmp/sites-full.conf" "$site"
  nginx -t
  systemctl reload nginx
  echo "[ok] per-user sites reconciled (${hosts_count} hostnames, cert ${cert_name})"
else
  echo "warning: no certificate at ${cert_dir}; HTTPS vhost not enabled" >&2
fi
