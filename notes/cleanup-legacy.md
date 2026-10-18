# Cleanup: standardize on stable + PM, retire the legacy venv

Status: PLAN (not yet implemented). Scope: the kunguru.net deployment
(swan tenants), but the changes belong in this repo so any deployment can
converge.

## Goal

1. Force every tenant's Hermes agent onto the `stable` update channel.
2. Stop using the pre-PM in-tree venv and move every tenant fully onto the
   PM-managed environment.
3. Route all of this through the app's provision / reprovision path (not
   ad-hoc scripts), and make that path **not destroy intentional tenant
   config**.

## Current state (observed 2026-10-11)

Agents (all on the `stable` *channel*, but different commits because a
default-channel install is forward-only):

| commit | agent | tenants |
| --- | --- | --- |
| `e4d8642` (+768) | stable release `v0.21.6` | jeff |
| `a0a4992` (+771) | pre-release main tip | nica |
| `835c3dd` (+774) | pre-release main tip | ndinda, gmhart, nerdscripts, wangu, nat |

WebUI: all tenants on `master` `81e1e7f`.

Venvs:
- The launcher (`~/.local/bin/hermes` -> `hermes-agent/.hermes/bin/hermes`)
  and every `hermes-gateway` unit already run on **PM**.
- jeff has **only** PM; his WebUI unit points at the PM interpreter.
- The other 6 still have the pre-PM in-tree venv
  (`~/.hermes/hermes-agent/venv`, a real dir from the Sep-15/Aug installs),
  and their **WebUI units point at it**. The updater never removes it.

## Mechanics that matter

- **Channel storage** is per install, in `config.yaml` under
  `update.installs.<sha16>.channel` (`hermes_cli/update_channel.py`).
- Unconfigured official checkouts default to `stable` and are
  **forward-only**: a checkout newer than the latest release waits for the
  next release instead of moving.
- `hermes update --set-channel <x>` is **metadata-only** (returns before any
  side effects). Forcing stable is therefore two steps: record the channel,
  then a separate `hermes update --yes` (which, once a record exists, is no
  longer forward-only and *will* move a newer checkout back to the stable
  release).
- `scripts/webui/ensure.sh` already prefers PM via `hermes_python()`, so any
  reprovision repoints the WebUI unit to PM.
- `startStandardAccountProvision` (Provision + Repair) runs
  `account -> snikket -> snikket-agent -> hermes -> webui` and never passes
  `HERMES_UPDATE`, so no agent update happens today.

## Intentional-config hazards found

These are places the converge path currently clobbers tenant state:

1. **`plugins.enabled` is replaced wholesale** — `scripts/hermes/ensure.sh`
   sets it to exactly `["hermes-xmpp-plugin"]`. Any plugin a tenant enabled
   is dropped. Fix: merge (read existing list, ensure the XMPP plugin is
   present, write back).
2. **`kunguru-sites` skill is overwritten every converge** — `SKILL.md` and
   `references/local.md` are written unconditionally. Tenant edits are lost.
   Fix: hash-guard — only rewrite when the on-disk file matches the last
   app-written content (sidecar hash) or is absent; otherwise back up and
   warn.
3. **`model.default` resets to the app DB value** — a model the user changed
   in the WebUI (which writes `config.yaml`) is reverted. Decide: app-as-
   authority (revert + warn) or reconcile the DB from `config.yaml`.
4. **`providers.only_configured true`** is applied every run and hides
   providers a user configured intentionally. Keep as fleet policy or
   reconcile.
5. `.env` (XMPP keys) and `hermes config set` of discrete keys are already
   merge-safe.
6. **Removing the legacy venv** could break user-owned scripts/cron that
   reference the path. Guard by checking references, then **hard-delete**
   (decided: the legacy venv is obsolete; we have been running without it).

## Plan

### 1. `scripts/hermes/ensure.sh` hardening

- On the `HERMES_UPDATE` path, record the channel before updating:
  `hermes update --set-channel stable` (idempotent), then
  `hermes update --yes`.
- Keep the current update -> WebUI repo/deps/unit-repoint/restart sequence.
- After update + WebUI repoint + services verified active, **retire the
  legacy venv**:
  - Check the user's `systemd --user` units, crontab, and obvious user files
    for references to `~/.hermes/hermes-agent/venv`.
  - If clear, **hard-delete** it (the legacy venv is obsolete); else skip with
    a warning.
- Preservation fixes: merge `plugins.enabled`; hash-guard the
  `kunguru-sites` writes.

### 2. App: first-class update/standardize action

- Thread an `update` flag through `startStandardAccountProvision` -> `runJob`
  that exports `HERMES_UPDATE=1` for the `hermes` step, or add a dedicated
  lean `agent-update` profile (`hermes` + `webui` steps only).
- New admin endpoints: `POST /api/users/:id/update` and a fleet-wide
  `POST /api/users/update` (job-tracked like provisioning), plus UI buttons
  ("Update" per user and/or "Update & standardize" fleet-wide).
- Pass per-user `HERMES_MODEL` (from the DB) and `KUNGURU_*` (to keep
  `references/local.md` current); omit `XMPP_*` / `HERMES_LLM_API_KEY` so
  credentials and XMPP are untouched.
- Serialize fleet runs (one tenant at a time; ~10 min each).

### 3. Config reconciliation

Per the decisions below (model authority, `only_configured`, skill
preservation).

### 4. Execute (after implementation)

- Deploy the app to drongo.
- Run the standardize action for all tenants, sequentially.

Verification per tenant:
- `config.yaml` has `update.installs.<sha16>.channel = stable`.
- Agent at the stable release (`v0.21.6`, `e4d8642`).
- WebUI unit `ExecStart` / `HERMES_WEBUI_PYTHON` -> PM interpreter.
- Legacy `~/.hermes/hermes-agent/venv` retired.
- `hermes-gateway` + `hermes-webui` active, `NRestarts=0`.
- Tenant config preserved (plugins list, skill edits, model choice).

## Decisions (2026-10-17)

- **Legacy venv: hard-delete** after the reference check. It is obsolete and we
  have been running without it.
- **`model.default`: the app/DB wins whenever the app writes the config**
  (revert + warn). Do **not** rewrite the config on extra runs just to enforce
  consistency — converge writes config only when it is actually doing work.

## Already implemented (verify before relying on the plan)

- Per-user **Update** + fleet **Update all agents** actions.
- `kunguru-sites` hash-guard (`write_guarded` + sidecar hashes).
- `accounts.agent_channel` / `agent_version` / `venv_kind` + user-list display.

## Open questions

1. `plugins.enabled`: merge to preserve tenant plugins — confirm.
2. **Channel assertion**: record `stable` on every converge, or only on the
   explicit update action? Tradeoff: recording it on every converge guarantees
   the fleet standardises on the next update, but silently overrides a tenant's
   deliberate channel choice on every repair/provision and flips their own
   `hermes update` from forward-only to "move back to stable". Recording it only
   on the explicit update action keeps converges non-destructive and respects
   tenant choice, at the cost of drift between standardisations. Given the
   `model.default` principle (don't rewrite config just to enforce consistency),
   the consistent choice is **only on the explicit update action** — or a middle
   ground: record only when no channel record exists (default the unconfigured,
   never override an existing choice).
