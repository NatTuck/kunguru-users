#!/usr/bin/env bash
# ensure-user-sites.sh  (run as root on the gateway, via the app transport)
#
# Renders the gateway's nginx routes for account apps and static sites, then
# reloads nginx. Driven by the app:
#
#   KUNGURU_BASE_DOMAIN  e.g. example.com
#   KUNGURU_ROUTES       JSON array of {hostname, upstream, slot}
#   KUNGURU_SITES_CERT   cert name (default kunguru-sites)
#   KUNGURU_AUTH_TARGET  host:port of the app's /internal/auth (127.0.0.1:3030)
#   KUNGURU_AUTH_HOST    login app host (default users.<base>)
#
# Hosts (see server/sites.ts):
#   <account>.<base>          app         12000+id
#   <account>-dev.<base>      app-dev     13000+id
#   <account>-agent.<base>    webui       11000+id  (always requires auth)
#   <label>.<base>            static      -> <owner-host>:14000
#
# Every routed host goes through the same vhost: the app's /internal/auth
# subrequest decides whether the host is optional-auth or require_auth (and
# whether the session user may use it), and nginx injects the verified
# Remote-User / Remote-Groups headers. The session cookie is stripped before
# proxying. Static sites are forwarded to the nginx on the owner's host; the
# gateway never serves a tenant docroot itself.
#
# The certificate is NOT managed here. It is the fixed wildcard pair
# (*.<base>) issued once and renewed by certbot.timer -- see scripts/nginx/acme/.
# This script only renders vhosts, so adding accounts or sites never re-issues a
# certificate.
set -euo pipefail

: "${KUNGURU_BASE_DOMAIN:?missing KUNGURU_BASE_DOMAIN}"
routes_json="${KUNGURU_ROUTES:-[]}"
cert_name="${KUNGURU_SITES_CERT:-kunguru-sites}"
auth_target="${KUNGURU_AUTH_TARGET:-127.0.0.1:3030}"

base="$KUNGURU_BASE_DOMAIN"
webroot="/var/www/certbot"
map_conf="/etc/nginx/conf.d/kunguru-user-sites-map.conf"
site_name="kunguru-user-sites"
site="/etc/nginx/sites-available/${site_name}"
site_link="/etc/nginx/sites-enabled/${site_name}"
cert_dir="/etc/letsencrypt/live/${cert_name}"

command -v nginx >/dev/null || { echo "nginx not installed" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }
mkdir -p "$webroot"

# Strip the session cookie before proxying to tenant apps; the gateway injects
# Remote-User/Remote-Groups instead. Reference copy:
# scripts/nginx/session-cookie-map.conf (also embedded by ensure-nginx.sh).
cat > /etc/nginx/conf.d/kunguru-session-cookie.conf <<'SESSION_MAP'
map $http_cookie $kunguru_cookie_1 {
    default $http_cookie;
    "~^(?<kunguru_pre>.*?)(?:;\s*)?kunguru_sid=[^;]*(?<kunguru_post>;.*)?$" "$kunguru_pre$kunguru_post";
}
map $kunguru_cookie_1 $kunguru_cookie {
    "~^;\s*(?<kunguru_rest>.*)$" $kunguru_rest;
    default $kunguru_cookie_1;
}
SESSION_MAP

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

auth_host="${KUNGURU_AUTH_HOST:-users.${base}}"

python3 - "$routes_json" "$base" "$cert_name" "$auth_target" "$auth_host" "$tmp" <<'PY'
import json, os, sys
routes_json, base, cert_name, auth_target, auth_host, tmp = sys.argv[1:7]
webroot = "/var/www/certbot"
cert_dir = "/etc/letsencrypt/live/" + cert_name
try:
    routes = json.loads(routes_json)
except json.JSONDecodeError:
    routes = []
routes = [r for r in routes if r.get("hostname") and r.get("upstream")]
hosts = sorted({r["hostname"] for r in routes})

map_lines = [
    "# Managed by kunguru-users (scripts/nginx/ensure-user-sites.sh).",
    "map $host $kunguru_upstream {",
    "    hostnames;",
    '    default "";',
]
for r in routes:
    map_lines.append("    {} {};".format(r["hostname"], r["upstream"]))
map_lines.append("}")
open(os.path.join(tmp, "map.conf"), "w").write("\n".join(map_lines) + "\n")
open(os.path.join(tmp, "hosts.txt"), "w").write("\n".join(hosts) + ("\n" if hosts else ""))

header = "# Managed by kunguru-users (scripts/nginx/ensure-user-sites.sh).\n"

http_server = """server {{
    listen 80;
    listen [::]:80;
    server_name *.{base};

    location /.well-known/acme-challenge/ {{ root {webroot}; }}
    location / {{ return 301 https://$host$request_uri; }}
}}
""".format(base=base, webroot=webroot)

https_server = """server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name *.{base};

    ssl_certificate     {cert_dir}/fullchain.pem;
    ssl_certificate_key {cert_dir}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # The gateway authenticates every routed host (optionally), injects the
    # verified identity, and strips the session cookie. Hosts marked
    # require_auth get a 401 here and are redirected to the login page.
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
        auth_request_set $auth_groups $upstream_http_x_auth_groups;
        if ($kunguru_upstream = "") {{ return 404; }}
        proxy_pass http://$kunguru_upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Remote-User $auth_user;
        proxy_set_header Remote-Groups $auth_groups;
        proxy_set_header Cookie $kunguru_cookie;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_max_body_size 64m;
    }}

    error_page 401 = @login;
    location @login {{
        return 302 https://{auth_host}/login?next=$scheme://$host$request_uri;
    }}
}}
""".format(base=base, cert_dir=cert_dir, auth_target=auth_target, auth_host=auth_host)

open(os.path.join(tmp, "sites-http.conf"), "w").write(header + http_server)
open(os.path.join(tmp, "sites-full.conf"), "w").write(
    header + http_server + "\n" + https_server
)
PY

install -m 0644 "$tmp/map.conf" "$map_conf"

hosts_count="$(wc -l < "$tmp/hosts.txt" | tr -d ' ')"
if [[ "$hosts_count" -eq 0 ]]; then
  # No enabled accounts with hosts and no static sites: drop the vhost entirely.
  rm -f "$site_link"
  nginx -t && systemctl reload nginx
  echo "[ok] no account or static-site routes; removed ${site_name}"
  exit 0
fi

# The certificate is the fixed wildcard pair (*.<base>) issued once and renewed
# by certbot.timer (see scripts/nginx/acme/). Render the HTTPS vhost when it is
# present; otherwise fall back to HTTP-only so the app stays reachable while the
# operator issues it.
if [[ -f "${cert_dir}/fullchain.pem" && -f "${cert_dir}/privkey.pem" ]]; then
  install -m 0644 "$tmp/sites-full.conf" "$site"
  [[ -e "$site_link" ]] || ln -s "$site" "$site_link"
  nginx -t
  systemctl reload nginx
  echo "[ok] gateway routes reconciled (${hosts_count} hostnames, cert ${cert_name})"
else
  install -m 0644 "$tmp/sites-http.conf" "$site"
  [[ -e "$site_link" ]] || ln -s "$site" "$site_link"
  nginx -t
  systemctl reload nginx
  echo "warning: no certificate at ${cert_dir}; serving HTTP only -- run scripts/nginx/acme/ensure-sites-cert.sh" >&2
fi
