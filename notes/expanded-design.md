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
  and is the intended LLM chokepoint for hosted agents. The gateway itself is
  **deployed** as a core component in the initial-install bootstrap (see
  "Snikket / Bifrost integration" below); the *mix* of providers behind it is
  the future part.

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

- `users` — `id, username, password_hash, role ∈ {admin, user}`, with `created_at`. Roles now so
  tenant self-service is a later feature, not a schema change. The `kunguru` admin is seeded
  on first boot with a random 16-char password (argon2-hashed; plaintext logged to the console
  once). A `pnpm reset-admin-pw` script regenerates that admin password. The DB file lives at
  `data/kunguru.db` with owner-only perms (`0700` dir / `0600` db + WAL sidecars) fixed on startup.
- `sessions` — `token_hash, user_id → users(id) ON DELETE CASCADE, created_at, expires_at`. Web
  logins issue an httpOnly session cookie; the DB stores only the SHA-256 hash of the bearer
  token (nothing reversible at rest), with a 7-day sliding expiry. `/api/auth/*` handles
  login/logout and `/api/auth/me` restores a session. In-app login is the current web-auth
  lane (the nginx `auth_request` boundary from §Authentication remains a later integration).
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

- **Set together:** one generated plaintext → (1) hashed into `users` (verifies the
  app/web login) and (2) pushed to Snikket's SCRAM store, in the same provisioning run.
- **Reset / resync together:** generate a fresh value, push to Snikket first, then update
  the app hash (ordering minimizes the failure window); retry the XMPP leg on failure.
  A later "resync password" self-service op is "rotate both," which doubles as the
  drift-repair path.
- **Nothing plaintext is retained at rest.** `users` hash is verification-only;
  Snikket's SCRAM is its own store; neither is reversible to the live value. The
  "xmpp matches web-auth" invariant is guaranteed by never setting one without the
  other — not by storing the shared value.
- Consequence: adding XMPP to an account *after* web-auth already has a password forces
  a rotation at that moment (we won't retain the old plaintext to copy in). That's fine —
  provisioning the standard profile already sets both together.
- No ssh password for normal accounts; Linux account auth is key-only.
- Generated passwords are high-entropy because they protect open, unthrottled services.

## Snikket / Bifrost integration (deployed; app automation later)

- Snikket is containerized. Some ops require shelling into the Snikket docker container;
  that jank lives in **one place** (`xmpp/*` scripts) behind a typed operation, not
  scattered.
- Bifrost (the LLM gateway: provider aggregation, model aliasing/renaming, per-user
  virtual keys with budgets/limits and usage tracking) is deployed as a **core component
  on the hub** by the initial-install bootstrap — `ensure-bifrost.sh`, dashboard/API at
  `https://llm.<base>`, see `notes/initial-setup.md`. Model renaming enables transparent
  model swaps. Usage/quota can only be enforced for traffic through the gateway — users
  who bring their own providers pay for their own tokens, so Bifrost hooks (not hard
  enforcement).
- Later (app automation): at provisioning time the app issues a per-user virtual key
  through the Bifrost management API and records it against the `accounts` row; the
  Hermes-facing model alias is set at the gateway, never per agent.

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

## Initial-install bootstrap (implemented, `scripts/bootstrap/`)

Pure-bash, idempotent (`*-ensure`) scripts run manually from any controller that can ssh
to the group (not necessarily the webapp host); the web app can wrap the same scripts
behind the transport seam later. Reads a gitignored `group.conf` inventory (template in
`group.conf.example`). Dev topology: hub **otter** (`otter.ferrus.net`), lanpeer **goose**
(`10.0.1.2` behind the existing WG peer LAN); Snikket primary **chat.ironbeard.com**.

- `bootstrap.sh [--check|--apply] [--only step]` — orchestrator; `--check` is a
  non-destructive status read, `--apply` converges the steps in order.
- `ensure-ssh-access.sh` — one-time (as the init sudo user): authorizes the controller key
  on `kunguru@` per host + passwordless sudo; all later steps run as `kunguru@`.
- `ensure-wireguard.sh` — ADOPTS/VERIFIES the existing hub (`wg0 10.0.0.1/24`), never
  regenerates keys or rewrites addresses; checks ip_forward + hub→peer/LAN reachability.
  (A clean-host hub would be created from inventory facts; direct `peer` spokes are the
  future "add a server to the fleet" path.)
- `ensure-nginx.sh` — makes nginx own 80/443 on the public gateway: deletes the legacy
  wg `DNAT` of :80/:443 → `10.0.1.2` (live iptables **and** stripped from `wg0.conf`
  PostUp/PostDown so it cannot return), installs nginx/certbot, writes the Snikket vhost
  and, when `BIFROST_DOMAIN` is set, the Bifrost vhost (ACME webroot + streaming-safe
  proxy; HTTPS once a certbot cert exists) (+ an `ssl_reject_handshake` default so
  unknown HTTPS SNI is not served).
- `ensure-snikket.sh` — Docker Snikket on host networking behind nginx, `SNIKKET_TWEAK_*`
  alt ports (5080/5443), converging `/etc/snikket/snikket.conf`.
- `ensure-bifrost.sh` — Docker Bifrost LLM gateway pinned on `127.0.0.1:BIFROST_PORT`
  behind nginx; converges `/etc/bifrost` (env file with a generated encryption key +
  one-time dashboard admin password, and a `config.json` that seeds admin auth and
  requires a virtual key on inference). Providers/virtual keys are operator-configured
  in the dashboard afterwards (upstream keys are secrets and never in the repo).

**Snikket TLS model (single ACME owner):** Snikket's cert-manager obtains/owns the
certificates for `chat./groups.chat./share.chat.<base>` (its HTTP-01 is proxied through
nginx :80); nginx terminates TLS using those same cert files from the Snikket data volume.
certbot is installed for future vhosts but is NOT run against Snikket hostnames, so two
ACME clients can never fight over HTTP-01. Note: taking over 80/443 removes the legacy
DNAT, which drops the pre-existing public `hermes-nat.goose.ferrus.net` entry (re-wired in
the later WebUI milestone). Manual precondition: any other service bound to host :80/:443
(e.g. a dockerized mail stack on the hub) must be stopped/disarmed by the operator first —
the scripts never manage other services' containers.

## Provisioning tenant accounts (implemented)

Users are created in the app with a target machine; creating one runs the `standard-account`
profile **inline** (Linux account on the chosen host via `scripts/account/ensure.sh`, a Snikket
account for the tenant via `scripts/snikket/ensure-account.sh`, a second Snikket account
`<user>-agent` for the tenant's **Hermes agent**, and `scripts/hermes/ensure.sh` on the
user-host) so the shared web/XMPP plaintext never rests anywhere — it travels only in-memory
to the remote step. The run is recorded as an audit `jobs`/`job_steps` row (status + output
log; secrets never logged).

- Hermes (github.com/NousResearch/hermes-agent, per-user `~/.hermes`) runs as a **user
  systemd unit** (`hermes-gateway`, linger enabled) and talks to the LLM through the Bifrost
  gateway: `model.provider custom` + `https://<llm>/v1`, default model, and a **per-user
  virtual key** issued app-side at provisioning (`server/bifrost.ts`; only the key id is
  stored on `accounts.bifrost_vk_id`, never the secret). The XMPP plugin logs the agent in as
  `<user>-agent@<domain>` and allows only the tenant's own account — tenants message their
  agent from the Snikket account they were provisioned.
- Lifecycle: re-provision/enable rotate the shared password **and** issue a fresh key
  (deactivating the old). Reset-password rotates only the tenant web/XMPP credential (the
  agent's key/account are untouched). Disable randomizes the tenant XMPP password, deactivates
  the agent's key, and stops the gateway.
- Tables: `hosts` (seeded from `server/inventory.ts`, env-overridable), `accounts`
  (user↔host link + status + `bifrost_vk_id`), `jobs` + `job_steps`.

- Tables: `hosts` (seeded from `server/inventory.ts`, env-overridable), `accounts`
  (user↔host link + status), `jobs` + `job_steps`.
- Admin routes: `GET /api/hosts` (user-servers first), `POST /api/users` (with `hostId`),
  `POST /api/users/:id/disable` and `/enable`, `POST /api/users/:id/provision` (re-provision =
  password rotation, since old plaintext is gone), `POST /api/users/:id/reset-password`
  (re-hash + Snikket-only sync), `GET /api/jobs/:id` for the audit log.
- Users are disabled, never deleted: disabling marks `users.enabled = 0` (blocks app login
  and kills live sessions) and randomizes the Snikket SCRAM password so the XMPP account is
  neutralized but kept. Linux accounts have no password to disable. Enabling issues a fresh
  shared password and re-applies it to Snikket (shown once).
- Transport (`server/transport/run.ts`) is the app-side twin of the bootstrap `run_remote`:
  `ssh kunguru@<ssh_target> 'sudo -n bash -s'` with the process user's default key.
- Job queue/SSE is deferred: inline execution sidesteps plaintext persistence; profiles are
  code in `server/provision.ts` (extend for hermes/webui/xmpp steps later).

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
