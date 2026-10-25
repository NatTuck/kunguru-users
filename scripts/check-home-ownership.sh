#!/usr/bin/env bash
# check-home-ownership.sh  (run as root on a host)
#
# Fails if any non-root user's home contains a root-owned file or directory.
# Provisioning runs as root, so this is the guard that nothing we do leaves
# root-owned state behind in a tenant/group home.
#
#   sudo bash scripts/check-home-ownership.sh        # report, exit 1 on any
#   sudo bash scripts/check-home-ownership.sh --fix  # chown to the home owner
#
# The provisioning scripts also repair the paths they manage; this scans the
# whole home (including files a Hermes/WebUI installer created).
set -euo pipefail

fix=0
if [[ "${1:-}" == "--fix" ]]; then
  fix=1
elif [[ -n "${1:-}" ]]; then
  echo "usage: $0 [--fix]" >&2
  exit 2
fi

found=0
while IFS= read -r -d '' home; do
  owner="$(stat -c %U "$home")"
  [[ "$owner" == "root" ]] && continue
  while IFS= read -r -d '' path; do
    found=1
    if (( fix )); then
      chown "$owner:$owner" "$path"
      printf 'fixed %s -> %s:%s\n' "$path" "$owner" "$owner"
    else
      printf '%s\t%s\n' "$path" "$owner"
    fi
  done < <(find "$home" -xdev -mindepth 1 -user root -print0 2>/dev/null)
done < <(find /home -xdev -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

if (( found )) && (( ! fix )); then
  echo "error: root-owned entries found in non-root homes" >&2
  exit 1
fi

echo "home ownership ok"
