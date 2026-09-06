# kunguru-admin — Expanded Design

Consolidated decisions from design review. This is the working design document; `DESIGN.md`
remains the high-level problem statement. This doc records the concrete architecture,
data model, and milestone plan we've settled on.

## Goal

Host individualized AI agents for people. Each user gets:

- A real Linux system account on a shared server.
- A Hermes Agent instance running on that account
  (https://hermes-agent.nousresearch.com/).
- An XMPP account through a Snikket server.
- Interaction surfaces: Hermes WebUI, Hermes XMPP plugin, ntfy via ntfy.sh.

We build an admin app that provisions, tears down, exports, and imports the above,
across one or more servers with roles, over a WireGuard VPN.

## Scale and trust model

- Intended scale: < 100 users per instance; ~5 is common.
- Operators of the app are trusted admins (fully trusted; admins may also drive admin
  ops via an admin Hermes).
- Agents can curl anything. Native filesystem permissions are the boundary between
  tenant accounts. Outbound traffic is routed through the gateway, so a misbehaving
  agent externally becomes a misbehaving VPS.
- Consequently: shared-host isolation via real Linux accounts, no per-agent sandbox
  theater. Don't put anything you don't want agents curling on the public internet.
- Multi-tenant isolation between agents is via OS-native account permissions.

## Reference deployment (current test setup)

- **otter** (`otter.ferrus.net`): gateway. The web admin app runs here. This is also
  where XMPP (Snikket) likely runs in production.
- **goose**: private "user server". Residential link, NAT'd; it dials the public
  gateway and keeps the VPN up so the gateway/admin can reach it.
- Admin reaches `nat@` on either host over ssh.

### Future configs (not milestone 1)

- One public server (VPS / dedicated).
- Public gateway + one or more private servers (residential/business links, VPNed to
  the gateway).
- LLMs locally, from cloud providers, or a mix — through the Bifrost gateway
  (https://docs.getbifrost.ai/) which does model renaming, per-user usage/quota,
  and is the intended LLM chokepoint for hosted agents.

## Stack decision

- **Web admin app:** Vite + Express + TypeScript, with `better-sqlite3`
  (single-writer, fits scale).
- We chose Node/TS partly to gain fluency. Backend is structured to keep that cheap:
  **job orchestration behind a transport interface** so a later Phoenix/Elixir port
  reimplements one file, not the app.

### Why not Elixir/Phoenix

Our default stack (Phoenix/OTP) is genuinely well-suited to this job-running workload
(GenServer queue + Task supervision + `:timer` timeouts). But the web app itself is
otherwise small CRUD, and Node/TS fluency is a stated goal. "Overkill" was about the
standing stack weight, not Elixir's fit. Backend-agnostic design keeps the option open.

## Transport model — shell scripts over ssh (no daemon/broker)

Provisioning is NOT a resident agent/broker. It is a **directory of shell scripts in
the same repo as the admin app**, executed over ssh with `sudo`. Scripts are shipped
over ssh at execution time and are **never installed on hosts**, so execution always
uses the current code and there is no remote drift / version-sync problem.

```
ssh <host> 'sudo bash -s' < scripts/<profile>/<step>.sh --user=... [args]
```

Scripts `printf` JSON to stdout for structured results. ssh keys (no passwords) over
the existing WireGuard. The app's dedicated user is unprivileged; elevated action
happens on the remote side via the operator's ssh `sudo`.

### Correctness discipline for scripts

- **Idempotent / ensure semantics:** each step is check-before-act. Detect existing
  state, diff against desired, repair only what's missing, or report `already-ok` and
  no-op. Never tear down unrelated state. Safe to re-run; safe on a clean or a
  partially-configured host. This is the "converge toward standard without breaking
  anything" requirement.
- **Partial-failure safety:** cleanup via `trap`, so a failed script leaves the host
  consistent and re-runnable.

## Architecture (backend)

```
package.json          # vite + express + better-sqlite3
server/
  index.ts            # express bootstrap
  db.ts               # sqlite init
  transport/          # THE swap seam (Phoenix port reimplements this)
    run.ts            #   interface: runStep(host, script, args, opts)
    ssh.ts            #   impl: spawn `ssh host 'sudo bash -s'`, feed script,
                      #         stream output, per-step timeout + process-group kill
  jobs/
    runner.ts         # in-process sequential queue over transport seam
  auth/               # session auth + role checks
  routes/             # accounts, hosts, jobs, auth
scripts/              # sh, by profile, shipped over ssh at run time
  account/ensure.sh   #   create EMPTY Linux account (M1)
  ...                 #   future: hermes, webui, xmpp, gateway, server bootstrap
client/               # vite admin UI
```

## Job model (multi-step seed)

An operation = a **profile** expanded into an **ordered list of steps**, executed
sequentially by the job runner. Milestone 1 ships a single-step profile; adding steps
later (hermes, webui, snikket) is editing the profile, not re-architecting.

```
profile "standard-account"
  step 1: account/ensure.sh   # create EMPTY Linux account
  # future: install-hermes, install-webui (nginx+auth_request), xmpp-setup, ...
```

`POST /jobs` = `{host, profile}` (or explicit step list). Runner executes steps in
order; per-step stdout appended to a persisted log; `close` event chains the next
step; a step failure stops the job with a clear report.

- **In-process sequential queue** over the transport seam (sqlite is single-writer).
- **Persistence is the supervision substitute:** job + step state lives in sqlite, so a
  crash/restart mid-job leaves the job resumable/inspectable, not lost.
- Progress streamed to the client via SSE (or polling), never by holding one HTTP
  request open for a whole pipeline.

### Timeout handling

`spawn(..., { detached: true })`. On timeout, `process.kill(-child.pid)` to kill the
whole **process group** — killing only ssh would orphan the remote command/grandchildren
and let it keep mutating the host.

## Data model (sqlite, better-sqlite3)

- `app_users` — `id, email/username, password_hash, role ∈ {admin, user}`. Roles now so
  tenant self-service is a later feature, not a schema change. Seed one admin on first
  boot.
- `hosts` — `name, role, ssh_target` (otter → `localhost`; goose → over VPN). Pre-seeded
  for the test pair. Keeps "where the app runs" distinct from "hosts you provision onto."
- `accounts` — managed tenant accounts: `id, host, username, status ∈ {active,inactive}`,
  plus a column reserved for the later password credential. Row = active/inactive makes
  reconcile binary and trivial.
- `jobs` + `job_steps` — `job {id, host, profile, created_by, status}`,
  `job_steps {id, job_id, seq, script, status, exit_code, output_log, started, finished}`.
- `profiles` — mapping profile name → ordered script steps.

## Authentication & passwords

Two lanes, because they are different protocols:

### Web / HTTP surfaces (Hermes WebUI, admin UI, tenant self-service)

**No per-service password.** Access is gated by nginx `auth_request`, which performs an
internal subrequest to an auth endpoint in the management app. `200` → serve (identity
injected upstream); `401/403` → reject.

- Hermes gets **no plaintext password** (it would otherwise take one via env var).
- The app's session/cookie is the single authentication authority.
- One auth boundary = one place to rate-limit / lock out (addresses "open services with
  no throttling").
- Identity is unified: the tenant `app_user` is the principal passed to WebUI.
- Pattern points (later): the auth subrequest must not redirect (`auth_request` can't
  follow); return `200`/`401` from a dedicated `/internal/auth` location. Keep the
  subrequest cheap/cacheable — it runs on every proxied request. Cookie must be on the
  same origin/site as WebUI.
- WebUI access = valid app session → resetting the app login password automatically
  gates WebUI; no cross-store sync needed for the web lane.

### XMPP (Snikket)

`auth_request` is HTTP-only, so XMPP (SASL/SCRAM) **must** keep a real stored
credential in Snikket.

### One shared password (web-auth + XMPP)

The web auth password and the XMPP password are the **same**. Rule: **when the web auth
password is set, the XMPP password is set to match.** Treat web-auth + XMPP as a single
logical credential set.

- **Set together:** one generated plaintext → (1) hashed into `app_users` (verifies the
  app/web login) and (2) pushed to Snikket's SCRAM store, in the same provisioning run.
- **Reset / resync together:** generate a fresh value, push to Snikket first, then update
  the app hash (ordering minimizes the failure window); retry the XMPP leg on failure.
  A later "resync password" self-service op is "rotate both," which doubles as the
  drift-repair path.
- **Nothing plaintext is retained at rest.** `app_users` hash is verification-only;
  Snikket's SCRAM is its own store; neither is reversible to the live value. The
  "xmpp matches web-auth" invariant is guaranteed by never setting one without the
  other — not by storing the shared value.
- Consequence: adding XMPP to an account *after* web-auth already has a password forces
  a rotation at that moment (we won't retain the old plaintext to copy in). That's fine —
  provisioning the standard profile already sets both together.
- No ssh password for normal accounts; Linux account auth is key-only.
- Generated passwords are high-entropy because they protect open, unthrottled services.

## Snikket / Bifrost integration (later)

- Snikket is containerized. Some ops require shelling into the Snikket docker container;
  that jank lives in **one place** (`xmpp/*` scripts) behind a typed operation, not
  scattered.
- Bifrost: gateway for LLM providers, model renaming, per-user usage/quota. Intended
  chokepoint for hosted agents. Model renaming enables transparent model swaps. Usage/
  quota can only be enforced for traffic through the gateway — users who bring their own
  providers pay for their own tokens, so Bifrost hooks (not hard enforcement).

## Export / import

- Because the stack is ~identical and per-user config is small (e.g. default model at
  the gateway), export/import collapses to serializing `(identity + config + key
  pointers)` and running reconcile on the target deployment.
- Do **not** copy XMPP accounts or old keys across deployments — regenerate identity on
  import.
- The genuinely non-trivial part is **Hermes persistent-state portability** (memories,
  config, caches — data that can't be regenerated). Hermes is designed to support it, but
  we must implement snapshot (`user/export.sh`) → transfer → restore (`user/import.sh`)
  and prove it round-trips on a scratch host. This is designed properly before it ships,
  not stubbed.

## Server bootstrap (future configs)

Fresh private server must dial the gateway and bring the VPN up *before* the admin can
provision it → "add a server to the fleet" is its own two-phase provisioning step
(`server/bootstrap.sh`: private dials out → admin confirms → admin pushes config),
represented as explicit state, not emergent.

## Idempotent converge guarantee

Every step script is `*-ensure`: safe on a clean host, safe on a partially-configured
host; converges toward the standard setup; never automatically breaks existing state.

## Milestone 1 (current target)

Web app on **otter**; create empty Linux accounts on **otter and goose** (both selectable
targets in the UI).

Delivery order:
1. Repo scaffold + `better-sqlite3` schema + auth (role-aware) + admin login.
2. `transport` ssh seam + `account/ensure.sh`; test by hand against goose first.
3. Job runner + SSE.
4. UI: host (otter|goose) + username → submit job → stream step status/output.
5. Test: create accounts on both otter and goose; re-run the same profile to prove
   idempotency (no-ops / repairs only).

### Explicitly out of scope for M1

Hermes install & snapshot/restore, WebUI + nginx `auth_request`, Snikket, Bifrost hooks,
password generation/setting, password self-service, auto reconcile (schema reserved),
multi-server bootstrap.

## Design principles recap

- Provisioning = idempotent `ensure` shell scripts, shipped over ssh at run time, never
  installed on hosts.
- Backend transport behind an interface (`run.ts`) for cheap backend swaps.
- Jobs = ordered steps, sqlite-persisted, SSE-streamed; process-group-kill timeouts.
- Account state is binary (active/inactive); reconcile is thin.
- Web auth centralized in the app behind nginx `auth_request`; XMPP is a separate store;
  web-auth and XMPP share one password, set together, never retained as plaintext.
- External-system jank (Snikket docker) isolated to typed scripts.
