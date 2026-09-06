# ensure-ssh-access.sh  (run as root on a target host, via INIT_SSH_USER)
#
# Converges the host so that the controller can drive it as BOOTSTRAP_SSH_USER:
#   * BOOTSTRAP_SSH_USER account exists (passwordless sudo, per group premise)
#   * the controller's public key is authorized for that account
#   * passwordless sudo is configured for it
#
# Idempotent: re-running is a no-op once access is in place.
#
# Required env (injected by bootstrap.sh): BOOTSTRAP_SSH_USER, PUBKEY

need BOOTSTRAP_SSH_USER
need PUBKEY

log "ensure-ssh-access for user '${BOOTSTRAP_SSH_USER}'"

# 1. Account must exist; create it if missing (locked password; key-only login).
if ! getent passwd "${BOOTSTRAP_SSH_USER}" >/dev/null; then
  useradd -m -s /bin/bash -U "${BOOTSTRAP_SSH_USER}"
  passwd -l "${BOOTSTRAP_SSH_USER}" >/dev/null
  log "created account '${BOOTSTRAP_SSH_USER}' (password locked)"
fi

# 2. Authorize the controller key.
home="$(getent passwd "${BOOTSTRAP_SSH_USER}" | cut -d: -f6)"
ssh_dir="${home}/.ssh"
authkeys="${ssh_dir}/authorized_keys"
install -d -m 0700 -o "${BOOTSTRAP_SSH_USER}" -g "${BOOTSTRAP_SSH_USER}" "${ssh_dir}"
install -d -m 0700 -o "${BOOTSTRAP_SSH_USER}" -g "${BOOTSTRAP_SSH_USER}" "$(dirname "${authkeys}")"
touch "${authkeys}"
chown "${BOOTSTRAP_SSH_USER}:${BOOTSTRAP_SSH_USER}" "${authkeys}"
chmod 0600 "${authkeys}"
if grep -qF "${PUBKEY}" "${authkeys}"; then
  log "controller key already authorized for '${BOOTSTRAP_SSH_USER}'"
else
  printf '%s\n' "${PUBKEY}" >>"${authkeys}"
  log "authorized controller key for '${BOOTSTRAP_SSH_USER}'"
fi

# 3. Passwordless sudo.
if [[ -f /etc/sudoers.d/kunguru ]] && grep -q "${BOOTSTRAP_SSH_USER}.*NOPASSWD:ALL" /etc/sudoers.d/kunguru; then
  log "passwordless sudo already configured for '${BOOTSTRAP_SSH_USER}'"
else
  cat >/etc/sudoers.d/kunguru <<EOF
${BOOTSTRAP_SSH_USER} ALL=(ALL) NOPASSWD:ALL
EOF
  chmod 0440 /etc/sudoers.d/kunguru
  log "configured passwordless sudo for '${BOOTSTRAP_SSH_USER}'"
fi

log "ensure-ssh-access complete on $(hostname)"
