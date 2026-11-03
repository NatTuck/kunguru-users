#!/usr/bin/env bash
# hermes/ensure-soul-prefix.sh  (run as root on the account's host, via the app)
#
# Maintains a platform-managed block at the top of the account's
# $HERMES_HOME/SOUL.md:
#
#   <!-- kunguru:platform:begin -->
#   ...platform context + the platform-managed skills...
#   <!-- kunguru:platform:end -->
#
# The block is regenerated on every converge from the instance facts (base
# domain, auth host, docs URL); the tenant's own SOUL content below it is
# preserved. Group SOULs (ensure-soul.sh) embed the same block so a roster
# rewrite cannot drop it.
#
# Env: USERNAME (required), KUNGURU_BASE_DOMAIN, KUNGURU_AUTH_HOST,
#      KUNGURU_DOCS_URL, KUNGURU_ACCOUNT_KIND.
set -euo pipefail

: "${USERNAME:?missing USERNAME}"
if ! id "$USERNAME" >/dev/null 2>&1; then
  echo "error: account '${USERNAME}' does not exist" >&2
  exit 1
fi

home="$(getent passwd "$USERNAME" | cut -d: -f6)"
group="$(id -gn "$USERNAME")"
hermes_home="${home}/.hermes"
soul="${hermes_home}/SOUL.md"

base="${KUNGURU_BASE_DOMAIN:-}"
auth="${KUNGURU_AUTH_HOST:-}"
if [[ -z "$auth" && -n "$base" ]]; then
  auth="users.${base}"
fi
docs="${KUNGURU_DOCS_URL:-}"
kind="${KUNGURU_ACCOUNT_KIND:-user}"

# The account's group is its own for users, the shared group for groups.
account_line="This account runs on the Kunguru platform."
if [[ "$kind" == "group" ]]; then
  account_line="This is a shared group account on the Kunguru platform."
fi

block="# kunguru platform"
if [[ -n "$base" ]]; then
  block="# Kunguru platform (${base})"
else
  block="# Kunguru platform"
fi
block+=$'\n\n'
block+="${account_line} Platform-managed skills:"$'\n'
block+="- \`kunguru-sites\` — hosting/deployment and the"
if [[ -n "$auth" ]]; then
  block+=" \`${auth}\`"
fi
block+=" agent API (token in \`~/.config/kunguru-agent.env\`)."$'\n'
if [[ -n "$docs" ]]; then
  block+=$'\n'
  block+="Instance docs: ${docs} (login required; agents can read it with the app-ops token)."$'\n'
fi
block+=$'\n'
block+="Tenant-specific skills and notes may follow; the platform-managed skill is"$'\n'
block+="authoritative for hosting and the API."

managed="<!-- kunguru:platform:begin -->
${block}
<!-- kunguru:platform:end -->"

if [[ ! -d "$hermes_home" ]]; then
  install -d -m 2770 -o "$USERNAME" -g "$group" "$hermes_home"
fi

tmp_block="$(mktemp)"
trap 'rm -f "$tmp_block"' EXIT
printf '%s\n' "$managed" >"$tmp_block"

python3 - "$soul" "$tmp_block" <<'PY'
import pathlib
import sys

soul, block_path = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
block = block_path.read_text()
begin = "<!-- kunguru:platform:begin -->"
end = "<!-- kunguru:platform:end -->"
text = soul.read_text() if soul.exists() else ""
b = text.find(begin)
e = text.find(end)
if b != -1 and e != -1 and e > b:
    rest = text[e + len(end):].lstrip("\n")
else:
    rest = text.lstrip("\n")
new = block.rstrip("\n")
if rest.strip():
    new += "\n\n" + rest
else:
    new += "\n"
soul.write_text(new)
PY

chown "$USERNAME:$group" "$hermes_home" "$soul"
chmod 0644 "$soul" 2>/dev/null || true
echo "[ok] SOUL platform prefix converged for ${USERNAME}"
