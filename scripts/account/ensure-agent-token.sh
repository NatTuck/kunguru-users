#!/usr/bin/env bash
# ensure-agent-token.sh  (run as root on the account's host, via the app transport)
#
# Writes the per-account app-ops token that the account's agents present to the
# control API as `Authorization: Bearer <token>`:
#
#   ~/.config/kunguru-agent.env
#     KUNGURU_AGENT_TOKEN=...
#     KUNGURU_API_URL=https://users.<base>
#
# The file is 0640 owner:group. For a group account the group is the group's
# Linux group, whose members include the owner, so the owner's *personal* agent
# can read it and operate the group's app slots while the group's own agent is
# off. For a user account only the user's own group can read it.
#
# Env: USERNAME, AGENT_TOKEN, AGENT_API_URL (all required).
set -euo pipefail

: "${USERNAME:?missing USERNAME}"
: "${AGENT_TOKEN:?missing AGENT_TOKEN}"
: "${AGENT_API_URL:?missing AGENT_API_URL}"

if ! id "$USERNAME" >/dev/null 2>&1; then
  echo "error: account '${USERNAME}' does not exist" >&2
  exit 1
fi

home="$(getent passwd "$USERNAME" | cut -d: -f6)"
group="$(id -gn "$USERNAME")"
config="${home}/.config"

# `install -d` creates missing parents as root; create the config dir as the
# account and repair one that predates this (the home-ownership invariant).
if [[ ! -d "$config" ]]; then
  install -d -m 2770 -o "$USERNAME" -g "$group" "$config"
elif [[ "$(stat -c %u "$config")" == "0" ]]; then
  chown "$USERNAME:$group" "$config"
fi

umask 027
printf 'KUNGURU_AGENT_TOKEN=%s\nKUNGURU_API_URL=%s\n' \
  "$AGENT_TOKEN" "$AGENT_API_URL" >"${config}/kunguru-agent.env"
chown "$USERNAME:$group" "${config}/kunguru-agent.env"
chmod 0640 "${config}/kunguru-agent.env"

echo "[ok] agent token written for ${USERNAME}"
