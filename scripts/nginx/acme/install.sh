#!/usr/bin/env bash
# Install the ACME helpers to a fixed system location (run as root on the
# gateway). ensure-user-sites.sh is piped over stdin, so it cannot reference
# these by relative path -- they must live at a known absolute location.
#
#   /usr/local/lib/kunguru/acme/joker-hook.sh
#   /usr/local/lib/kunguru/acme/ensure-sites-cert.sh
set -euo pipefail

dir="/usr/local/lib/kunguru/acme"
here="$(cd "$(dirname "$0")" && pwd)"

install -d -m 0755 "$dir"
install -m 0755 "${here}/joker-hook.sh" "${dir}/joker-hook.sh"
install -m 0755 "${here}/ensure-sites-cert.sh" "${dir}/ensure-sites-cert.sh"
echo "[ok] installed ACME helpers to ${dir}"
