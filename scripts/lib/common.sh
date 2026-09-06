# Kunguru bootstrap shared helpers.
# These are sourced by the ensure-* scripts, which run as ROOT on a target host:
#   ssh <user>@<host> 'sudo -n bash -s'  <  (this file + the ensure script)
#
# Conventions (see notes/expanded-design.md):
#   * Every ensure-* script is idempotent: it detects current state, converges
#     toward the desired state, repairs only what differs, and no-ops (reporting
#     "already-ok") when nothing needs to change.
#   * Scripts never tear down unrelated state and are safe to re-run.

set -euo pipefail

log()  { printf '[bootstrap] %s\n' "$*"; }
warn() { printf '[bootstrap][warn] %s\n' "$*" >&2; }
fail() { printf '[bootstrap][error] %s\n' "$*" >&2; exit 1; }

# need NAME: fail unless the env var NAME is non-empty.
need() {
  local v="$1"
  [[ -n "${!v:-}" ]] || fail "missing required env var: $v"
}

# cmd_exists CMD
cmd_exists() { command -v "$1" >/dev/null 2>&1; }

# apt_ensure PKG...: install any listed package that is not already installed.
apt_ensure() {
  local missing=() p
  for p in "$@"; do
    if dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed'; then
      log "apt already present: $p"
    else
      missing+=("$p")
    fi
  done
  if ((${#missing[@]} > 0)); then
    log "apt installing: ${missing[*]}"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq "${missing[@]}"
  fi
}

# write_file PATH: idempotently installs the heredoc/stdin content at PATH.
# Usage:
#   write_file /etc/foo <<'EOF'
#   ...content...
#   EOF
write_file() {
  local path="$1" tmp mode="${2:-0644}"
  tmp="$(mktemp)"
  cat >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$path" "$tmp"; then
    rm -f "$tmp"
    log "unchanged: $path"
    return 0
  fi
  install -m "$mode" -o root -g root "$tmp" "$path"
  rm -f "$tmp"
  log "wrote: $path"
}

# svc_ensure UNIT: daemon-reload, enable, and ensure the unit is active.
svc_ensure() {
  local unit="$1"
  systemctl daemon-reload 2>/dev/null || true
  if systemctl is-active --quiet "$unit"; then
    log "service active: $unit"
    return 0
  fi
  systemctl enable "$unit" 2>/dev/null || true
  systemctl start "$unit"
  log "service started: $unit"
}

# svc_reload_if_any UNIT...: reload the listed units only if they are active.
svc_reload_if_any() {
  local u
  for u in "$@"; do
    if systemctl is-active --quiet "$u"; then
      systemctl reload "$u" 2>/dev/null || systemctl restart "$u"
      log "reloaded: $u"
    fi
  done
}

# ping_ok HOST: succeeds when the host answers a single ping.
ping_ok() { ping -c1 -W2 "$1" >/dev/null 2>&1; }

# is_domain_pointing_here NAME: true when DNS for NAME resolves to this host.
is_domain_pointing_here() {
  local name="$1" want_ip="${2:-}"
  local got
  got="$(getent ahostsv4 "$name" 2>/dev/null | awk 'NR==1{print $1}')"
  [[ -n "$got" ]] || return 1
  if [[ -n "$want_ip" ]]; then
    [[ "$got" == "$want_ip" ]]
  else
    return 0
  fi
}
