#!/usr/bin/env bash
# ensure-wireguard-peer.sh  (run as root on a peer host, via BOOTSTRAP_SSH_USER)
#
# Converges a WireGuard peer that dials the hub:
#   * installs wireguard-tools
#   * generates a keypair on first run (never overwrites an existing key)
#   * writes /etc/wireguard/<iface>.conf (Address = WG_PEER_IP; Peer = the hub)
#   * optionally routes ALL egress via the hub (WG_PEER_DEFAULT_GATEWAY=1)
#   * registers the group's WG hostnames in /etc/hosts
#   * enables + starts wg-quick@<iface>
#
# Prints the peer public key so the operator/controller can add it to the hub.
#
# Env: WG_IFACE WG_PEER_IP WG_SUBNET WG_HUB_PUBKEY WG_HUB_ENDPOINT
#      WG_PEER_DEFAULT_GATEWAY (0|1, default 0)   WG_HOSTS (name=ip ...)
need WG_IFACE WG_PEER_IP WG_SUBNET WG_HUB_PUBKEY WG_HUB_ENDPOINT

iface="${WG_IFACE}"
default_gw="${WG_PEER_DEFAULT_GATEWAY:-0}"
conf="/etc/wireguard/${iface}.conf"
key="/etc/wireguard/${iface}.key"

if ! cmd_exists wg; then
  log "installing wireguard-tools"
  apt_ensure wireguard-tools
fi

umask 077
mkdir -p /etc/wireguard
chmod 0700 /etc/wireguard
if [[ ! -f "$key" ]]; then
  wg genkey >"$key"
  chmod 0600 "$key"
  log "generated peer key ${key}"
fi
pub="$(wg pubkey <"$key")"

if [[ ! -f "$conf" ]]; then
  if [[ "$default_gw" == "1" ]]; then
    allowed="0.0.0.0/0"
  else
    allowed="${WG_SUBNET}"
  fi
  {
    printf '[Interface]\n'
    printf 'Address = %s/%s\n' "$WG_PEER_IP" "${WG_SUBNET##*/}"
    printf 'PrivateKey = %s\n\n' "$(cat "$key")"
    printf '[Peer]\n# hub\n'
    printf 'PublicKey = %s\n' "$WG_HUB_PUBKEY"
    printf 'Endpoint = %s\n' "$WG_HUB_ENDPOINT"
    printf 'AllowedIPs = %s\n' "$allowed"
    printf 'PersistentKeepalive = 25\n'
  } >"$conf"
  chmod 0600 "$conf"
  log "wrote ${conf}"
else
  log "${conf} already exists (adopting as-is)"
fi

svc_ensure "wg-quick@${iface}"
systemctl enable "wg-quick@${iface}" >/dev/null 2>&1 || true

# Register group WG hostnames in /etc/hosts (both directions).
for kv in ${WG_HOSTS:-}; do
  hosts_ensure "${kv#*=}" "${kv%%=*}"
done

log "peer public key: ${pub}"
log "ensure-wireguard-peer complete on $(hostname)"
