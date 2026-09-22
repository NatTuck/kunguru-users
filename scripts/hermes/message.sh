# hermes/message.sh  (run as root on the user's host over `sudo bash -s`)
#
# Pushes a literal XMPP message from a tenant's Hermes agent account
# (<user>-agent@<domain>) to the tenant, using the agent's already-configured
# XMPP credentials in ~/.hermes/.env. This is a plain `hermes send`: the XMPP
# plugin's one-shot standalone sender logs in as the agent account and attaches
# as a short-lived second resource, so NO LLM turn and NO running gateway are
# involved.
#
# Idempotent and side-effect free beyond the one message: it never touches
# tenant state. The message body is staged in a user-owned temp file so
# arbitrary characters (quotes, newlines, $(...), backticks) never pass through
# a shell command line.
#
# Env:
#   USERNAME (required)      Linux account / tenant username
#   XMPP_MESSAGE (required)  literal message body
#   XMPP_TARGET (optional)   recipient bare JID; when omitted, the agent's
#                            configured XMPP_HOME_CHANNEL is used (normally the
#                            tenant's own JID)

set -euo pipefail

: "${USERNAME:?missing required env: USERNAME}"
: "${XMPP_MESSAGE:?missing required env: XMPP_MESSAGE}"

if [[ ! "$USERNAME" =~ ^[a-z][a-z0-9._-]{0,31}$ ]]; then
  echo "error: invalid linux username '$USERNAME'" >&2
  exit 1
fi
if ! id "$USERNAME" >/dev/null 2>&1; then
  echo "error: linux account '$USERNAME' does not exist" >&2
  exit 1
fi

home="$(getent passwd "$USERNAME" | cut -d: -f6)"
uid="$(id -u "$USERNAME")"
hermes_bin="${home}/.local/bin/hermes"

if [[ ! -x "$hermes_bin" ]]; then
  echo "error: hermes launcher missing at ${hermes_bin}" >&2
  exit 1
fi

# run_as_user CMD: run as USERNAME with a clean but functional env, the per-user
# systemd manager socket (XDG_RUNTIME_DIR), and cwd in the user's home.
run_as_user() {
  runuser -u "$USERNAME" -- env -i \
    HOME="$home" \
    USER="$USERNAME" LOGNAME="$USERNAME" SHELL=/bin/bash \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    PATH="${home}/.local/bin:${home}/.hermes/hermes-agent/venv/bin:${home}/.hermes/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash -c "cd '${home}' && $1"
}

# Stage the message in a user-owned file; `hermes send` reads the body from it.
msg_file="$(mktemp)"
chmod 0600 "$msg_file"
printf '%s' "$XMPP_MESSAGE" > "$msg_file"
chown "$USERNAME" "$msg_file"
trap 'rm -f "$msg_file"' EXIT

if [[ -n "${XMPP_TARGET:-}" ]]; then
  target="xmpp:${XMPP_TARGET}"
else
  target="xmpp"
fi

echo "[..] sending XMPP message as ${USERNAME}-agent (target: ${target})"
if run_as_user "hermes send --to '${target}' --file '${msg_file}'"; then
  echo "[ok] message sent for ${USERNAME}"
else
  echo "error: 'hermes send' failed for ${USERNAME}" >&2
  exit 1
fi
