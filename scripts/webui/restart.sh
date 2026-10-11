#!/usr/bin/env bash
# webui/restart.sh  (run as root on the user's host over `sudo bash -s`)
#
# Restarts the per-tenant Hermes WebUI so it drops its persisted model catalog
# and re-fetches `/v1/models` through the tenant's LLM gateway. The admin
# "Refresh models & WebUIs" action runs this for every active tenant after
# refreshing the gateway's upstream provider models. The on-disk catalog is
# always deleted first: a plain restart does NOT re-fetch, because a fresh
# process serves the disk snapshot whenever its schema/version/source
# fingerprint still match.
#
# When WEBUI_DEFAULT_MODEL is also given (the per-user model switch), it first
# persists that model into the unit's HERMES_WEBUI_DEFAULT_MODEL, repoints
# existing sessions at it, and clears a stale persisted default provider. The
# WebUI stores the model per session and prefers a browser-persisted pick over
# the configured default, so without this a model change stays invisible to
# conversations that already exist.
#
# Lightweight on purpose: unlike webui/ensure.sh it does NOT re-clone/update the
# WebUI. Idempotent.
#
# Env:
#   USERNAME (required)      WEBUI_DEFAULT_MODEL (optional)
set -euo pipefail

: "${USERNAME:?missing required env: USERNAME}"

if [[ ! "$USERNAME" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
  echo "error: invalid linux username '$USERNAME'" >&2
  exit 1
fi
if ! id "$USERNAME" >/dev/null 2>&1; then
  echo "error: linux account '$USERNAME' does not exist" >&2
  exit 1
fi

home="$(getent passwd "$USERNAME" | cut -d: -f6)"
uid="$(id -u "$USERNAME")"

# run_as_user CMD...: run as USERNAME with a clean env and the per-user systemd
# manager socket so `systemctl --user` works.
run_as_user() {
  runuser -u "$USERNAME" -- env -i \
    HOME="$home" \
    USER="$USERNAME" LOGNAME="$USERNAME" SHELL=/bin/bash \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    PATH="${home}/.local/bin:${home}/.hermes/hermes-agent/venv/bin:${home}/.hermes/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash -c "cd '${home}' && $1"
}

unit="${home}/.config/systemd/user/hermes-webui.service"
if ! run_as_user 'systemctl --user cat hermes-webui.service' >/dev/null 2>&1; then
  echo "error: hermes-webui.service not installed for ${USERNAME} (run webui/ensure.sh first)" >&2
  exit 1
fi

# Stop first so the running server cannot rewrite the files touched below on
# the way down; start again at the end (or on any error, via the trap).
run_as_user 'systemctl --user stop hermes-webui' >/dev/null 2>&1 || true
trap 'run_as_user "systemctl --user start hermes-webui" >/dev/null 2>&1 || true' EXIT

# Drop the persisted model catalog so the next start re-fetches /v1/models. A
# restart alone does NOT: a fresh process serves the on-disk catalog whenever
# its schema/version/source fingerprint still match, so a provider-catalog or
# env-only default change would stay invisible until the cache expires.
state_dir="$(sed -n 's/^Environment=HERMES_WEBUI_STATE_DIR=//p' "$unit" | tail -1)"
state_dir="${state_dir:-${home}/.hermes/webui}"
rm -f "${state_dir}"/models_cache*.json

if [[ -n "${WEBUI_DEFAULT_MODEL:-}" ]]; then
  echo "[changed] setting webui default model to '${WEBUI_DEFAULT_MODEL}' for ${USERNAME}"

  # 1) Persist the default in the unit so a fresh browser (and any session with
  #    no pinned model) resolves to the configured model.
  python3 - "$unit" "$WEBUI_DEFAULT_MODEL" <<'PY'
import sys
path, model = sys.argv[1], sys.argv[2]
with open(path) as f:
    lines = f.read().splitlines()
key = "Environment=HERMES_WEBUI_DEFAULT_MODEL="
for i, ln in enumerate(lines):
    if ln.startswith(key):
        lines[i] = key + model
        break
else:
    try:
        idx = lines.index("[Service]") + 1
    except ValueError:
        idx = len(lines)
    lines.insert(idx, key + model)
with open(path, "w") as f:
    f.write("\n".join(lines) + "\n")
PY
  chown "$USERNAME" "$unit"
  run_as_user 'systemctl --user daemon-reload'

  # 2) Repoint existing sessions at the new model. The WebUI persists the model
  #    per session and resolves it ahead of the configured default, so leftover
  #    sessions would otherwise keep calling the old model.
  sessions_dir="${state_dir}/sessions"
  if [[ -d "$sessions_dir" ]]; then
    python3 - "$sessions_dir" "$WEBUI_DEFAULT_MODEL" <<'PY'
import glob, json, os, sys
dir_, model = sys.argv[1], sys.argv[2]
changed = 0
for path in glob.glob(os.path.join(dir_, "*.json")):
    if os.path.basename(path).startswith("_"):
        continue
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        continue
    if not isinstance(data, dict):
        continue
    dirty = False
    if data.get("model") != model:
        data["model"] = model
        dirty = True
    if data.get("model_provider") != "custom":
        data["model_provider"] = "custom"
        dirty = True
    if data.get("model_explicit_pick_signature") is not None:
        data["model_explicit_pick_signature"] = None
        dirty = True
    if dirty:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        st = os.stat(path)
        os.chown(tmp, st.st_uid, st.st_gid)
        os.replace(tmp, path)
        changed += 1
print(f"[ok] repointed {changed} webui session(s) to '{model}'")
PY
  fi

  # 3) Clear a stale persisted provider (e.g. an ambient provider the WebUI
  #    auto-detected once and stored as the default) so new chats resolve to
  #    the configured route instead of it.
  settings_path="${state_dir}/settings.json"
  if [[ -f "$settings_path" ]]; then
    python3 - "$settings_path" <<'PY'
import json, os, sys
p = sys.argv[1]
try:
    with open(p) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
if not isinstance(data, dict) or data.get("default_model_provider") == "custom":
    sys.exit(0)
data["default_model_provider"] = "custom"
tmp = p + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
st = os.stat(p)
os.chown(tmp, st.st_uid, st.st_gid)
os.replace(tmp, p)
print("[ok] reset webui default_model_provider to 'custom'")
PY
  fi
fi

echo "[changed] restarting hermes webui for ${USERNAME}"
if ! out="$(run_as_user 'systemctl --user restart hermes-webui' 2>&1)"; then
  echo "error: failed to restart hermes webui for ${USERNAME}" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

sleep 1
if run_as_user 'systemctl --user is-active hermes-webui' >/dev/null 2>&1; then
  echo "[ok] hermes webui active for ${USERNAME}"
else
  echo "error: hermes webui for ${USERNAME} not active after restart" >&2
  exit 1
fi
