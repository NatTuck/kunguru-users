#!/usr/bin/env bash
# apply-routing-rules.sh
#
# Converges a Bifrost gateway's routing rules (model aliases) to the secret-free
# desired state tracked under bifrost/<instance>/routing-rules.json.
#
# A provider-independent alias (e.g. the literal name "default-model" that maps
# to a chosen provider/model) can only be a global Bifrost *routing rule*:
# static aliases are attached to a provider key and are therefore provider
# scoped. This script keeps those rules in a tracked file and converges them.
#
# Runs from ANY machine that can ssh to the gateway (the admin API is bound to
# loopback on the gateway host). Idempotent: rules are matched by (name, scope)
# and updated in place, or created when absent. No secrets are read from or
# written to the repo -- admin credentials stay on the gateway in
# /etc/bifrost/env, and the rules file contains only endpoints/model names.
#
# Usage:
#   scripts/bifrost/apply-routing-rules.sh --ssh kunguru@drongo.kunguru.net [--instance kunguru.net] [--check]
#
# Env:
#   BIFROST_INSTANCE   instance dir under bifrost/ (default: kunguru.net)
#   BIFROST_SSH        default ssh target (or pass --ssh)
#   BIFROST_API_URL    admin API on the gateway (default: http://127.0.0.1:8181)

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

INSTANCE="${BIFROST_INSTANCE:-kunguru.net}"
SSH_TARGET="${BIFROST_SSH:-}"
API_URL="${BIFROST_API_URL:-http://127.0.0.1:8181}"
MODE="--apply"

while (($#)); do
  case "$1" in
    --instance) INSTANCE="${2:?--instance requires a name}"; shift 2 ;;
    --ssh) SSH_TARGET="${2:?--ssh requires user@host}"; shift 2 ;;
    --api-url) API_URL="${2:?--api-url requires a URL}"; shift 2 ;;
    --check) MODE="--check"; shift ;;
    --apply) MODE="--apply"; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "usage: apply-routing-rules.sh --ssh user@host [--instance NAME] [--api-url URL] [--check|--apply]" >&2; exit 1 ;;
  esac
done

RULES_FILE="$DIR/bifrost/$INSTANCE/routing-rules.json"
[[ -f "$RULES_FILE" ]] || { echo "missing rules file: $RULES_FILE" >&2; exit 1; }
[[ -n "$SSH_TARGET" ]] || { echo "missing --ssh user@host (or set BIFROST_SSH)" >&2; exit 1; }

# Validate the JSON and compact it into a single base64 blob shipped in the
# remote environment (avoids embedding quoting-sensitive JSON in the script).
RULES_B64="$(python3 -c '
import base64, json, sys
with open(sys.argv[1]) as f:
    rules = json.load(f)
assert isinstance(rules, list), "routing-rules.json must be a JSON array"
print(base64.b64encode(json.dumps(rules).encode()).decode())
' "$RULES_FILE")"

{
  printf 'export API_URL=%q\n' "$API_URL"
  printf 'export RULES_B64=%q\n' "$RULES_B64"
  printf 'export MODE=%q\n' "$MODE"
  cat <<'RSH'
set -euo pipefail
set -a; . /etc/bifrost/env; set +a
python3 - <<'PY'
import base64, json, os, urllib.request

api = os.environ["API_URL"].rstrip("/")
mode = os.environ["MODE"]
rules = json.loads(base64.b64decode(os.environ["RULES_B64"]))
auth = base64.b64encode(
    f'{os.environ["BIFROST_ADMIN_USERNAME"]}:{os.environ["BIFROST_ADMIN_PASSWORD"]}'.encode()
).decode()


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(api + path, data=data, method=method)
    r.add_header("Authorization", "Basic " + auth)
    r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, timeout=30) as resp:
        text = resp.read().decode()
    return json.loads(text) if text else {}


existing = {}
for r in req("GET", "/api/routing/rules").get("rules", []):
    existing[(r.get("name"), r.get("scope", "global"))] = r

FIELDS = ("cel_expression", "targets", "scope", "priority", "enabled")
drift = False
for rule in rules:
    key = (rule.get("name"), rule.get("scope", "global"))
    cur = existing.get(key)
    if cur is None:
        print(f"[create] {key[0]} (scope={key[1]})")
        if mode == "--apply":
            req("POST", "/api/routing/rules", rule)
        drift = True
    elif all(cur.get(f) == rule.get(f) for f in FIELDS):
        print(f"[ok]     {key[0]} (scope={key[1]}) already converged")
    else:
        print(f"[update] {key[0]} (scope={key[1]})")
        if mode == "--apply":
            req("PUT", f"/api/routing/rules/{cur['id']}", rule)
        drift = True

if mode == "--check":
    print("[check]  no changes applied" + (" (drift detected)" if drift else ""))
else:
    print("[apply]  done")
PY
RSH
} | ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" 'sudo -n bash -s'
