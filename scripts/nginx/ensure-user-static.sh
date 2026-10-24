#!/usr/bin/env bash
# ensure-user-static.sh  (run as root on a user server, via the app transport)
#
# Serves this host's static sites from one gateway-only HTTP listener and makes
# their docroots readable by nginx. Driven by the app:
#
#   KUNGURU_BASE_DOMAIN     e.g. example.com
#   KUNGURU_STATIC_PORT     14000
#   KUNGURU_STATIC_BIND     address to listen on: the host's VPN IP, or
#                           127.0.0.1 when the gateway is co-located
#   KUNGURU_STATIC_ALLOW    space-separated peers allowed to reach the listener
#                           (the gateway's VPN IP; 127.0.0.1 when co-located).
#                           Falls back to KUNGURU_GATEWAY_WG_IP.
#   KUNGURU_SITES           JSON array of
#                           {label, hostname, owner, source_root, served_root}
#
# The gateway terminates TLS and forwards `<label>.<base>` here, so this
# listener is plain HTTP, bound to the VPN address, and only accepts the
# gateway. Static sites are not units: nginx serves the owner's `~/www/<label>`
# directly. The script is also what creates those directories and grants
# www-data read access (homes are 2770, so an ACL is needed).
#
# Idempotent: it converges the listener config, the directories, and the ACLs,
# and no-ops when nothing differs.
set -euo pipefail

log()  { printf '[static] %s\n' "$*"; }
warn() { printf '[static][warn] %s\n' "$*" >&2; }

: "${KUNGURU_BASE_DOMAIN:?missing KUNGURU_BASE_DOMAIN}"
: "${KUNGURU_STATIC_BIND:?missing KUNGURU_STATIC_BIND}"
: "${KUNGURU_STATIC_ALLOW:-${KUNGURU_GATEWAY_WG_IP:-}}:?missing KUNGURU_STATIC_ALLOW}"

sites_json="${KUNGURU_SITES:-[]}"
port="${KUNGURU_STATIC_PORT:-14000}"
bind="${KUNGURU_STATIC_BIND}"
allow_list="${KUNGURU_STATIC_ALLOW:-${KUNGURU_GATEWAY_WG_IP:-}}"
conf_name="kunguru-user-static"
conf="/etc/nginx/sites-available/${conf_name}"
link="/etc/nginx/sites-enabled/${conf_name}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

python3 - "$sites_json" "$bind" "$port" "$allow_list" "$tmp" <<'PY'
import json, os, sys

sites_json, bind, port, allow_list, tmp = sys.argv[1:6]
allow = [a for a in allow_list.split() if a]
if not allow:
    sys.exit("missing allow list for the static listener")
allow_lines = "".join("    allow {};\n".format(a) for a in allow) + "    deny all;\n"
try:
    sites = json.loads(sites_json)
except json.JSONDecodeError:
    sites = []
sites = [
    s
    for s in sites
    if s.get("hostname") and s.get("served_root") and s.get("owner")
]

listen = "{}:{}".format(bind, port)
header = (
    "# Managed by kunguru-users (scripts/nginx/ensure-user-static.sh).\n"
    "# Plain HTTP, VPN-bound, gateway-only: the gateway terminates TLS and\n"
    "# forwards <label>.<base> here. Do not expose this port publicly.\n"
)

# Unknown hostnames (or a missing upstream) get a plain 404.
parts = [
    header,
    "server {{\n"
    "    listen {} default_server;\n"
    "    server_name _;\n"
    "    access_log off;\n"
    "    return 404;\n"
    "}}\n".format(listen),
]

for s in sites:
    parts.append(
        "server {{\n"
        "    listen {listen};\n"
        "    server_name {hostname};\n"
        "\n"
        "    root {served};\n"
        "    index index.html index.htm;\n"
        "    autoindex off;\n"
        "    disable_symlinks on;\n"
        "    access_log off;\n"
        "\n"
        "{allow}"
        "\n"
        "    location / {{ try_files $uri $uri/ =404; }}\n"
        "}}\n".format(
            listen=listen,
            hostname=s["hostname"],
            served=s["served_root"],
            allow=allow_lines,
        )
    )

open(os.path.join(tmp, "static.conf"), "w").write("\n".join(parts))
open(os.path.join(tmp, "count.txt"), "w").write(str(len(sites)))

with open(os.path.join(tmp, "dirs.tsv"), "w") as f:
    for s in sites:
        owner = s["owner"]
        source = s.get("source_root") or ""
        f.write("\t".join([owner, s["label"], source, s["served_root"]]) + "\n")
PY

count="$(cat "$tmp/count.txt")"

if [[ "$count" -eq 0 ]]; then
  # Nothing to serve on this host: drop the listener so no stale vhost survives
  # a deleted site. Leave nginx alone if it was never installed for us.
  if [[ -e "$link" ]]; then
    rm -f "$link"
    if command -v nginx >/dev/null 2>&1; then
      nginx -t && systemctl reload nginx
    fi
    log "removed ${conf_name} (no static sites on $(hostname))"
  else
    log "no static sites on $(hostname)"
  fi
  exit 0
fi

if ! command -v nginx >/dev/null 2>&1; then
  log "installing nginx"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx
fi
if ! command -v setfacl >/dev/null 2>&1; then
  log "installing acl"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq acl
fi

# Directories and permissions. The owner builds into ~/www/<label> (the served
# docroot) from the project in ~/sites/<label>; www-data must be able to
# traverse the home and read the docroot.
while IFS=$'\t' read -r owner label source served; do
  [[ -n "$owner" ]] || continue
  if ! id "$owner" >/dev/null 2>&1; then
    warn "account '${owner}' does not exist on $(hostname); skipping site '${label}'"
    continue
  fi
  for d in "$source" "$served"; do
    [[ -n "$d" ]] || continue
    if [[ ! -d "$d" ]]; then
      install -d -m 2750 -o "$owner" -g "$owner" "$d"
      log "created ${d}"
    fi
  done
  setfacl -m u:www-data:x "/home/${owner}"
  setfacl -R -m u:www-data:rX "$served"
  # New files a build drops in stay readable without another reconcile.
  setfacl -d -m u:www-data:rX "$served"
done <"$tmp/dirs.tsv"

had_conf=0
if [[ -f "$conf" ]] && cmp -s "$conf" "$tmp/static.conf"; then
  log "unchanged: ${conf}"
else
  if [[ -f "$conf" ]]; then
    cp -a "$conf" "$tmp/static.conf.bak"
    had_conf=1
  fi
  install -m 0644 -o root -g root "$tmp/static.conf" "$conf"
  log "wrote: ${conf}"
fi
[[ -e "$link" ]] || ln -s "$conf" "$link"

systemctl enable nginx >/dev/null 2>&1 || true
# Never leave a rejected config behind: restore the previous one and fail.
if ! nginx -t; then
  if (( had_conf )); then
    cp -a "$tmp/static.conf.bak" "$conf"
    warn "nginx rejected the rendered config; restored the previous ${conf}"
  else
    rm -f "$conf" "$link"
    warn "nginx rejected the rendered config; removed ${conf}"
  fi
  exit 1
fi
systemctl reload nginx 2>/dev/null || systemctl restart nginx
log "serving ${count} static site(s) on ${bind}:${port} for *.${KUNGURU_BASE_DOMAIN}"
