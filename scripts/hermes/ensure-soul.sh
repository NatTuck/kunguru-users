#!/usr/bin/env bash
# hermes/ensure-soul.sh  (run as root on the account's host, via the app)
#
# Converges a group agent's identity and allowlist:
#   * $HERMES_HOME/SOUL.md — the group roster and how the agent should behave
#     (Hermes reads SOUL.md as its identity document);
#   * XMPP_ALLOWED_USERS in $HERMES_HOME/.env — the members the agent answers;
#   * restarts the gateway (when it is running) so both take effect.
#
# Run after group Hermes provisioning and after every membership change. Safe
# when the agent is not installed yet: it still writes SOUL.md, and skips the
# allowlist/restart with a warning.
#
# Env:
#   USERNAME                group account                              (required)
#   KUNGURU_GROUP_MEMBERS   space-separated member usernames
#   KUNGURU_XMPP_DOMAIN     e.g. chat.example.com
#   KUNGURU_SOUL_DRY_RUN=1  print SOUL.md and change nothing
set -euo pipefail

log()  { printf '[soul] %s\n' "$*"; }
warn() { printf '[soul][warn] %s\n' "$*" >&2; }

: "${USERNAME:?missing required env: USERNAME}"
members="${KUNGURU_GROUP_MEMBERS:-}"
domain="${KUNGURU_XMPP_DOMAIN:-}"

if [[ ! "$USERNAME" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
  echo "error: invalid account name '$USERNAME'" >&2
  exit 1
fi
if ! id "$USERNAME" >/dev/null 2>&1; then
  echo "error: linux account '$USERNAME' does not exist" >&2
  exit 1
fi

home="$(getent passwd "$USERNAME" | cut -d: -f6)"
uid="$(id -u "$USERNAME")"
hermes_home="${home}/.hermes"

# Validate the roster once and build both the SOUL roster and the JID allowlist.
roster=""
allowed=""
for m in $members; do
  if [[ ! "$m" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
    echo "error: invalid member name '$m'" >&2
    exit 1
  fi
  if [[ -n "$domain" ]]; then
    roster+="- ${m} (${m}@${domain})"$'\n'
    allowed+="${m}@${domain} "
  else
    roster+="- ${m}"$'\n'
    allowed+="${m} "
  fi
done
allowed="${allowed% }"
roster="${roster%$'\n'}"
if [[ -z "$roster" ]]; then
  roster="- (no members yet)"
fi

soul="$(cat <<EOF
# ${USERNAME} — group agent

You are the shared Hermes agent for the \`${USERNAME}\` group. Several people use
you, each through their own XMPP account and through the group's web interface.
You are not any one member's personal assistant.

## Members

${roster}

## How to behave

- A message may come from any member. Treat the sender as the person you are
  talking to; never assume a single owner.
- If the sender is not identified, ask which member you are speaking with
  instead of guessing.
- Shared memory is visible to every member of the group: do not treat anything
  a member tells you as private from the rest of the group.
- When a member asks you to contact someone, send it to that member explicitly;
  do not broadcast to everyone unless asked.
EOF
)"

if [[ "${KUNGURU_SOUL_DRY_RUN:-0}" == "1" ]]; then
  log "dry run for ${USERNAME} (SOUL.md at ${hermes_home}/SOUL.md)"
  printf '%s\n' "$soul"
  log "allowlist: ${allowed:-<empty>}"
  exit 0
fi

run_as_user() {
  runuser -u "$USERNAME" -- env -i \
    HOME="$home" \
    USER="$USERNAME" LOGNAME="$USERNAME" SHELL=/bin/bash \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    PATH="${home}/.local/bin:${hermes_home}/hermes-agent/venv/bin:${hermes_home}/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash -c "cd '${home}' && $1"
}

install -d -m 0755 -o "$USERNAME" -g "$(id -gn "$USERNAME")" "$hermes_home"
changed=0
tmp="$(mktemp)"
printf '%s\n' "$soul" >"$tmp"
if [[ -f "${hermes_home}/SOUL.md" ]] && cmp -s "${hermes_home}/SOUL.md" "$tmp"; then
  rm -f "$tmp"
  log "unchanged: ${hermes_home}/SOUL.md"
else
  install -m 0644 -o "$USERNAME" -g "$(id -gn "$USERNAME")" "$tmp" "${hermes_home}/SOUL.md"
  rm -f "$tmp"
  changed=1
  log "wrote: ${hermes_home}/SOUL.md"
fi

if [[ -z "$allowed" ]]; then
  warn "no members; leaving XMPP_ALLOWED_USERS untouched"
elif [[ ! -f "${hermes_home}/.env" ]]; then
  warn "no ${hermes_home}/.env yet; skipping the XMPP allowlist (provision the agent first)"
elif [[ "$(grep -m1 '^XMPP_ALLOWED_USERS=' "${hermes_home}/.env" 2>/dev/null || true)" == "XMPP_ALLOWED_USERS=${allowed}" ]]; then
  log "XMPP allowlist unchanged"
else
  changed=1
  stage="$(mktemp)"
  chmod 0600 "$stage"
  printf 'XMPP_ALLOWED_USERS=%s\n' "$allowed" >"$stage"
  chown "$USERNAME" "$stage"
  run_as_user "python3 - '${hermes_home}/.env' '${stage}' <<'PY'
import os, sys
env_path, src = sys.argv[1], sys.argv[2]
updates = {}
for line in open(src):
    line = line.rstrip('\n')
    if '=' not in line or line.startswith('#'):
        continue
    k, v = line.split('=', 1)
    updates[k] = v
lines = []
if os.path.exists(env_path):
    with open(env_path) as f:
        lines = [ln.rstrip('\n') for ln in f]
kept = [ln for ln in lines if not (ln.split('=', 1)[0] in updates)]
for k, v in updates.items():
    kept.append('{}={}'.format(k, v))
with open(env_path, 'w') as f:
    f.write('\n'.join(kept) + '\n')
os.chmod(env_path, 0o600)
PY"
  rm -f "$stage"
  log "XMPP allowlist: ${allowed}"
fi

if (( changed )); then
  if run_as_user 'systemctl --user is-active hermes-gateway >/dev/null 2>&1'; then
    run_as_user 'systemctl --user restart hermes-gateway' || warn "could not restart the gateway"
    log "restarted hermes-gateway for ${USERNAME}"
  else
    log "hermes-gateway is not running for ${USERNAME}; SOUL.md applies on its next start"
  fi
else
  log "no roster/allowlist changes; gateway left running"
fi
