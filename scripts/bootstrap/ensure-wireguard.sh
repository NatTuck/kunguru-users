# ensure-wireguard.sh  (run as root on the hub, via BOOTSTRAP_SSH_USER)
#
# ADOPTS and VERIFIES an existing WireGuard hub; it never regenerates keys,
# never rewrites addresses/subnet, and never bounces a running tunnel.
#
#   * installs wireguard-tools if missing
#   * ensures the hub interface is up + enabled on boot
#   * ensures ip_forward is on (persisted)
#   * sanity-checks Address/ListenPort against inventory
#   * pings every REACH_HOSTS peer/LAN target from the hub
#
# For a *clean* host (role=hub with no existing config) it creates a minimal
# hub config from inventory facts -- but only when no config already exists.
#
# Required env: WG_IFACE WG_HUB_IP WG_SUBNET WG_PORT REACH_HOSTS
#   REACH_HOSTS  space-separated IPs to ping from the hub (optional)

need WG_IFACE
need WG_HUB_IP
need WG_SUBNET
need WG_PORT
need HOSTNAME_BOOTSTRAP  # logical host name for logging

if ! cmd_exists wg; then
  log "installing wireguard-tools"
  apt_ensure wireguard-tools
fi

conf="/etc/wireguard/${WG_IFACE}.conf"
want_addr="${WG_HUB_IP}/${WG_SUBNET##*/}"

if [[ ! -f "$conf" ]] && ! ip link show "${WG_IFACE}" >/dev/null 2>&1; then
  log "no existing ${WG_IFACE} config; creating hub from inventory facts"
  umask 077
  mkdir -p /etc/wireguard
  chmod 0700 /etc/wireguard
  wg genkey | tee /etc/wireguard/privatekey >/dev/null
  chmod 0600 /etc/wireguard/privatekey
  wg pubkey </etc/wireguard/privatekey >/etc/wireguard/publickey
  iface_cfg="$(mktemp)"
  {
    printf '[Interface]\n'
    printf 'Address = %s\n' "${want_addr}"
    printf 'ListenPort = %s\n' "${WG_PORT}"
    printf 'PrivateKey = %s\n' "$(cat /etc/wireguard/privatekey)"
    if [[ -n "${WG_NAT_IFACE:-}" ]]; then
      # Peers that use the hub as their default gateway need NAT on the hub.
      printf 'PostUp = sysctl -w net.ipv4.ip_forward=1; iptables -A FORWARD -i %%i -j ACCEPT; iptables -A FORWARD -o %%i -j ACCEPT; iptables -t nat -A POSTROUTING -s %s -o %s -j MASQUERADE\n' "${WG_SUBNET}" "${WG_NAT_IFACE}"
      printf 'PostDown = iptables -D FORWARD -i %%i -j ACCEPT; iptables -D FORWARD -o %%i -j ACCEPT; iptables -t nat -D POSTROUTING -s %s -o %s -j MASQUERADE\n' "${WG_SUBNET}" "${WG_NAT_IFACE}"
    fi
  } >"${iface_cfg}"
  install -m 0600 -o root -g root "${iface_cfg}" "${conf}"
  rm -f "${iface_cfg}"
  log "wrote new hub config ${conf}"
fi

# If config exists but interface is down, bring it up.
if ip link show "${WG_IFACE}" >/dev/null 2>&1; then
  log "${WG_IFACE} interface is up"
else
  log "starting ${WG_IFACE}"
  svc_ensure "wg-quick@${WG_IFACE}"
fi
systemctl enable "wg-quick@${WG_IFACE}" >/dev/null 2>&1 || true

# ip_forward on (needed so the hub routes between spokes / to the peer LAN).
if [[ "$(sysctl -n net.ipv4.ip_forward)" != "1" ]]; then
  sysctl -w net.ipv4.ip_forward=1 >/dev/null
  printf 'net.ipv4.ip_forward = 1\n' >/etc/sysctl.d/99-kunguru.conf
  log "enabled ip_forward"
else
  log "ip_forward already enabled"
fi

# Adopt/verify config sanity (report only; never silently rewrite a live hub).
log "current ${WG_IFACE} Address/ListenPort:"
ip -brief addr show "${WG_IFACE}" 2>/dev/null | sed 's/^/  /' || true
grep -E "^(Address|ListenPort)" "${conf}" 2>/dev/null | sed 's/^/  /' || true
if ! grep -q "ListenPort *= *${WG_PORT}" "${conf}"; then
  warn "${conf} ListenPort != ${WG_PORT} (adopting as-is)"
fi

# Reachability from hub to every peer/LAN target.
ok=1
for ip in ${REACH_HOSTS:-}; do
  if ping_ok "$ip"; then
    log "reachable from hub: ${ip}"
  else
    warn "NOT reachable from hub: ${ip}"
    ok=0
  fi
done
(( ok )) || fail "one or more hub reachability checks failed"

# Add/adopt peers (WG_PEERS: whitespace-separated name=pubkey=ip). Peers that
# dial the hub and use it as their default gateway need the hub's NAT PostUp
# (WG_NAT_IFACE) to reach the internet.
for spec in ${WG_PEERS:-}; do
  pname="${spec%%=*}"
  rest="${spec#*=}"
  ppub="${rest%%=*}"
  pip="${rest#*=}"
  if [[ -z "$pname" || -z "$ppub" || -z "$pip" ]]; then
    warn "skipping malformed WG_PEERS entry: ${spec}"
    continue
  fi
  if grep -qF "$ppub" "$conf" 2>/dev/null; then
    log "peer ${pname} already present"
    continue
  fi
  {
    printf '\n[Peer]\n# %s\n' "$pname"
    printf 'PublicKey = %s\n' "$ppub"
    printf 'AllowedIPs = %s/32\n' "$pip"
  } >>"$conf"
  log "added peer ${pname} (${pip})"
done
if [[ -n "${WG_PEERS:-}" ]] && ip link show "${WG_IFACE}" >/dev/null 2>&1; then
  wg syncconf "${WG_IFACE}" <(wg-quick strip "${WG_IFACE}") 2>/dev/null || \
    svc_reload_if_any "wg-quick@${WG_IFACE}"
fi

# Register the group's WG hostnames in /etc/hosts so hub and peers resolve each
# other by name in both directions. WG_HOSTS: whitespace-separated name=ip.
for kv in ${WG_HOSTS:-}; do
  hosts_ensure "${kv#*=}" "${kv%%=*}"
done

log "ensure-wireguard complete on ${HOSTNAME_BOOTSTRAP}"
