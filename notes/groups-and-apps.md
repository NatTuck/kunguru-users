# Groups and extra apps — design & implementation plan

Status: **design agreed, not implemented.** Settled decisions are in §2; the
remaining open items are in §15.

Related: `notes/auth-protocol.md`, `notes/expanded-design.md`, `notes/deploy.md`,
`scripts/hermes/ensure.sh`, `scripts/webui/ensure.sh`.

---

## 1. What a group is

A **group** is a principal that a real user creates from the web UI. It is
modelled as a row in the existing `users` table with `kind = 'group'` (§3), so
it shares the id space, namespace, `accounts` row, slots, and ports with human
users.

Each group has:

- an **actual Linux user and Linux group with the same name**. `useradd
  --user-group <name>` creates the group as the user's primary group; members
  are added as *supplementary* members of that group.
- a **home directory** `/home/<name>`, owned `<name>:<name>`, mode `2770`
  (setgid), for shared work.
- an **owner** (the creating user) plus **members**.
- optionally a **Hermes instance** (1:1 with each member — §10).
- one **app** (`<name>.<base>`) and one **Hermes WebUI** (`<name>-agent.<base>`
  when Hermes is provisioned). There is no public/private slot split.
- a per-group **Bifrost virtual key** and default model, via its `accounts` row.

Limits: **5 groups per owning user**. Extra apps for a user are implemented as
groups (a solo group = an extra app). There is **no separate `apps` table and no
port allocator**.

---

## 2. Decisions (settled)

1. **Groups live in `users`** (`kind = 'group'`), not a parallel table.
2. **Shared id space** ⇒ the existing port formula applies to groups unchanged.
3. **Formulaic ports**, no allocator, no per-app allocation.
4. **Groups are the extra-app mechanism**; they consume the hostname namespace.
5. **Group apps run as `--user` systemd units as the group user**; the app can
   restart them and read their journald logs (§9).
6. **Hermes for a group is 1:1 per member**, with a `SOUL.md` roster (§10).
   The group uses the **root profile in its own home** — no named profile.
7. **No secrecy boundary between group members**: members can prompt the agent
   and write to the shared tree, so the home is not split into private/shared
   trees. The boundary is *group members vs other tenants* (mode `2770`).
   Revocation is by Linux group membership.
8. **Multi-user-server + shared accounts + shared file tree are intended but
   deferred** (§14). Today: one user server, local homes, local Linux groups.
9. **Verified identity**: the gateway authenticates (optionally) and injects
   `Remote-User` / `Remote-Groups`; apps never see the session cookie.
   Authentication is **required for the WebUI** and **optional by default** for
   other apps. See `notes/auth-protocol.md`.
10. **One app per principal** is the target. The `*.users.` subtree is retired
    in Phase 3; groups use the target scheme from day one.
11. **Self-service** group creation and Hermes provisioning, with a per-host /
    global capacity cap (§13).
12. **Disable only, no delete** for now (§12).
13. **Message-as-agent for groups** with a member picker (§11).

---

## 3. Identity and namespace

Users and groups share **one namespace** (`users.username UNIQUE`), which also
shares with alias labels and reserved names.

Validation for a new group name:

- same rule as usernames (`isProvisionableUsername`): `[a-z][a-z0-9-]{0,30}`,
  not ending in `-agent`, not in `RESERVED_LABELS`;
- not equal to an existing **user or group** (`users.username`);
- not equal to an existing **alias label** (`aliases.label`).

Hostnames derived from the name (covered by the existing wildcard cert — no cert
churn):

```
<name>.<base>            app
<name>-agent.<base>      Hermes WebUI (when provisioned)
```

Groups use this target scheme from day one. The `*.users.<base>` subtree remains
only for existing user slots until Phase 3 retires it.

Aliases add extra hostnames pointing at the app port. Their `access` field is
reinterpreted as **`require_auth`** immediately (`private` = require auth,
`public` = optional auth) and renamed in Phase 3.

---

## 4. Ports and hostnames

Because groups share the `users.id` sequence:

```
app          12000 + id
hermes-webui 11000 + id
```

`13000 + id` (the old private-app slot) is retired in Phase 3; existing private
apps migrate to the single app slot. Groups use app + WebUI only.

---

## 5. Data model

Additive migration (no table rebuild):

```sql
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'
  CHECK (kind IN ('user','group'));
ALTER TABLE users ADD COLUMN owner_user_id INTEGER REFERENCES users(id); -- humans: NULL
ALTER TABLE users ADD COLUMN require_auth INTEGER NOT NULL DEFAULT 0;    -- app host policy

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_users_kind_owner ON users(kind, owner_user_id);
```

Notes:

- `users.password_hash` is `NOT NULL`; groups get a **random unknown hash**
  (they never log in). Login additionally filters `kind = 'user'`.
- `require_auth` defaults to 0 (optional auth). The WebUI host is always
  `require_auth`; the group app is optional unless the owner opts in.
- `accounts` is reused unchanged (`UNIQUE(user_id, host_id)` works for groups;
  `bifrost_vk_id`, `hermes_model`, `agent_*` are per group).
- SQLite cannot enforce cross-table invariants; enforce in the app layer.

Invariants (application-enforced):

- `kind='group'` ⇒ `owner_user_id` is a `kind='user'` (and enabled).
- `kind='user'` ⇒ `owner_user_id IS NULL`.
- `group_members.user_id` is `kind='user'`; a group cannot be a member.
- `count(*) WHERE kind='group' AND owner_user_id = ?` ≤ **5**.
- name uniqueness as in §3.

---

## 6. Provisioning

Reuse the existing job/step machinery. Group provisioning is idempotent and
repairable, like user provisioning.

Linux account:

- `useradd --user-group <name>` (creates user + primary group `<name>`).
- locked login: no password, non-login shell; **linger enabled**.
- home `/home/<name>` owned `<name>:<name>`, mode `2770` setgid.
- member add/remove ⇒ `gpasswd -a/-d <member> <name>`.

Hermes (optional):

- reuse `scripts/hermes/ensure.sh` with the group's username/id;
- **only the agent XMPP account** is created (`<name>-agent@chat.<base>`); no
  human `<name>@chat` account;
- `XMPP_ALLOWED_USERS` = the member JIDs;
- **root profile** in the group home (`HERMES_HOME=/home/<name>/.hermes`);
- `SOUL.md` roster at `/home/<name>/.hermes/SOUL.md` (§10);
- WebUI on `<name>-agent.<base>` via `scripts/webui/ensure.sh`;
- per-group Bifrost virtual key + model default on the `accounts` row.

WebUI environment for a group:

```
HERMES_WEBUI_TRUSTED_AUTH_HEADER=Remote-User
HERMES_WEBUI_TRUSTED_GROUPS_HEADER=Remote-Groups
HERMES_WEBUI_GROUP_PROFILE_MAP={"<group>":"default"}   # pin the root profile
```

The group map does **not** create a profile; it pins `bound_profile='default'`
so a member cannot switch the WebUI to a named profile (which would diverge from
the gateway's root profile and break shared memory).

Per-turn identity:

- XMPP already sets `user_id`/`user_name` (the sender JID);
- the WebUI must pass `Remote-User` to the gateway, and the gateway API server
  must set `user_id`/`user_name` on the source;
- a `pre_llm_call` hook injects “current sender is …” into the turn (the model
  does not see `user_id` otherwise).

App unit:

- `kunguru-app.service` as a `--user` unit for the group user (§9).

---

## 7. Authorization

### Login / sessions

- Login query: `WHERE username = ? AND kind = 'user'`.
- `resolveSession` / `getSessionUser` must never yield a group.
- Split `getUserByUsername` into:
  - `getPrincipalByName` (any kind) — hostname→owner and alias collision;
  - `getUserByName` (`kind='user'`) — login.

### `/internal/auth` (nginx auth_request)

Resolve the requested host to its principal, then:

- **optional host**: `200` + `X-Auth-User` if a session is present, else `200`
  with an empty user (anonymous allowed);
- **require_auth host**: `200` + user, else `401` (nginx redirects to login);
- **group host**: allow if the session user is a member (or the owner).

`Remote-Groups` is populated with the signed-in user's group names.

### Admin / self-service

- `requireAdmin` stays `role='admin'` (groups have `role='user'`).
- New self-service `/api/groups`: a user may read groups they own or belong to;
  the owner may manage members; admins may manage any group; admin ownership
  transfer.
- Admin user list filters `kind='user'`; groups get their own view.
- Hide human-only admin actions for groups: reset password, make admin.
- **Message-as-agent** for a group takes a member and sends from
  `<group>-agent@chat.<base>` to that member's JID.

---

## 8. Filesystem, permissions, trust model

- Home `/home/<name>`: `2770`, owner `<name>:<name>`. Members can read/write;
  other tenants cannot.
- Setgid makes new subdirectories inherit the group and new files get the
  group. Members need **umask 002** for group-writable files.
- **No private/shared split.** Members can prompt the agent and write to the
  shared tree, so hiding `.hermes` is not a boundary. Accept that a member can
  tamper with the shared agent.
- **Revocation** is by Linux group membership.
- **Repair permissions**: re-apply group ownership and setgid on the home tree,
  constrained to `/home/<name>`: `find -xdev ... -exec chgrp <name> {} +`, then
  re-apply `chmod g+s` on directories; symlink-safe (`-P`); run as a job,
  rate-limited, logged.
- No delete for now; disabling keeps the home.

---

## 9. App and WebUI units

Members cannot `systemctl --user` as the group user, so the app owns the units.

- **App**: `kunguru-app.service` under the group user, `Restart=always`, enabled
  with linger. Runs a convention start script in the group home:
  ```
  ~/apps/run
  ```
  with `PORT` (`12000+id`), bind address / `KUNGURU_*` facts, and
  `TRUSTED_PROXY` (trust `Remote-User` only from the gateway).
- **WebUI**: the existing `scripts/webui/ensure.sh` unit on
  `<name>-agent.<base>`, `require_auth`.
- The app can:
  - **restart**: `systemctl --user -M <name>@ restart kunguru-app`,
  - **logs**: `journalctl --user -M <name>@ -u kunguru-app` (or `_UID=<uid>`),
  - show "not deployed" when the run script is missing.
- This resolves "who runs the app": the managed unit, not whichever member
  SSH'd in last.

---

## 10. Hermes for a group

- **1:1 per member**: separate conversations keyed by each member's JID.
- Agent identity `<name>-agent@chat.<base>`; `XMPP_ALLOWED_USERS` = member JIDs.
- **Root profile** in the group home (`/home/<name>/.hermes`), so the XMPP
  gateway and the WebUI share one `state.db` and therefore shared memory.
- **`SOUL.md` roster** at `$HERMES_HOME/SOUL.md`
  (`/home/<name>/.hermes/SOUL.md`). It is the agent's **identity slot #1**
  (highest-priority context file, loaded by `agent/prompt_builder.py`); it
  should state that this is a group agent serving several members and list them.
- **On every membership change**: update the Linux group, regenerate `SOUL.md`,
  update the XMPP allowlist, restart the agent. Idempotent convergence.
- **WebUI**: sessions are scoped per `Remote-User` (the WebUI binds/rebinds the
  session to the trusted header); all sessions live in the root profile, so
  memory is shared while threads are per member. Pin `bound_profile='default'`
  via `HERMES_WEBUI_GROUP_PROFILE_MAP`.
- Per-turn identity: XMPP sets `user_id`/`user_name`; the WebUI must pass the
  `Remote-User` to the gateway and the gateway API server must set
  `user_id`/`user_name`; a `pre_llm_call` hook injects the sender into the turn.
- Per-group Bifrost virtual key + model default.

---

## 11. UI

Self-service **Groups** page (first non-admin surface in the app):

- my groups (owned + member-of), create (≤5, name validated per §3);
- per group: members (owner can add/remove), app URL/port, provisioning status +
  job log, Hermes model, **restart app** / **view logs**, **repair
  permissions**, **message as agent** (member picker);
- provisioning action for the optional Hermes instance.

Admin view:

- all groups, disable/enable, ownership transfer, view logs.

Account page:

- surface the signed-in user's group apps alongside personal apps (links + port
  facts).

---

## 12. Lifecycle

- **Create**: DB row (`kind='group'`, owner, random password) + job to provision
  Linux user/group + home; Hermes optional (separate action).
- **Provision / repair**: idempotent convergence of Linux, XMPP, Hermes, WebUI,
  Bifrost key, units.
- **Member add**: Linux group + XMPP allowlist + `SOUL.md` + agent restart.
- **Member remove**: reverse; auth gate denies immediately (DB-driven); files
  owned by the removed member remain (ownership unchanged).
- **Disable/enable**: groups are disabled like users; auth gate and routes drop.
  **No delete for now** — the home and account are retained.
- **Ownership transfer**: admin only.
- **Message-as-agent**: pick a member; send from the group agent to that member.

---

## 13. Capacity and limits

- 5 groups per owning user (enforced).
- Self-service Hermes provisioning is gated by a **per-host / global capacity
  cap**; when full, the provision action fails with a clear error.
- Each provisioned group Hermes is ~0.5 GB RAM and ~7 GB disk. On the current
  single user server (disk-bound at ~13 tenants), a handful of group Hermes
  instances can exhaust disk. Shared/deduped toolchain is the lever.

---

## 14. Multi-host / shared accounts and file tree (intended, deferred)

**Intended**: every user server in an instance shares user accounts (directory
service) and a shared file tree, with central uid/gid allocation. Group homes
live on the shared tree; members can access from any host; the group's
Hermes/apps run on the group's host.

**Deferred**: today there is one user server, so group homes are local,
membership is the local Linux group, and provisioning uses local
`useradd`/`groupadd`/`gpasswd`.

**Keep the seams**: keep `host_id` on the group's `accounts` row; keep
membership changes in one converge step; don't bake "single host" into
`siteRoutes`/auth.

---

## 15. Open items

1. **`require_auth` surface**: WebUI only, or per-app opt-in? (Recommended:
   per-app flag, default optional; WebUI always require_auth.)
2. **Capacity caps**: per-host/global values and the "full" behavior.
3. **Audit log**: scope/retention (membership, ownership, repair, provision,
   message).
4. **Phase 3 migration** of existing private apps (`13000+id` → `12000+id`,
   hostname move).
5. **`sanitizeNext` migration window**: allow both `.users.<base>` and
   `*.<base>` until Phase 3 completes.
6. **`plugins.enabled` merge** (tracked in `notes/cleanup-legacy.md`).

---

## 16. Phased implementation

**Phase 1 — Auth foundation** (see `notes/auth-protocol.md`)
- cookie `Domain=<base>`; app stays at `users.<base>`; the legacy
  `users.<base>` cookie is expired on login/logout so it cannot win a duplicate;
- nginx strips the session cookie on every upstream vhost except the auth app
  (user-sites, Snikket, Bifrost); overwrites `Remote-User`/`Remote-Groups`;
  strips client `Remote-*`;
- `/internal/auth`: optional (`200 + empty`) vs require_auth (`401`); WebUI is
  require_auth (the `-agent` suffix and the `users.` subtree are required);
- inject `Remote-Groups`;
- broaden `sanitizeNext` to single-label hosts under `<base>` (keep `.users.`
  during migration);
- WebUI→gateway identity + `pre_llm_call` sender hook;
- harden CSRF/origin checks and log hygiene;
- **land the additive schema early** (`users.kind`, `owner_user_id`,
  `require_auth`, `group_members`) so the auth path never queries a missing
  table. Phase 2 adds the API/UI/provisioning on top.

**Phase 2 — Groups**
- schema + namespace + login/admin filtering (§5);
- provisioning (Linux, home, linger, optional Hermes root profile + SOUL.md +
  WebUI group map, Bifrost key, app unit) (§6);
- auth (owner-aware, self-service `/api/groups`, membership propagation,
  disable-only, message-as-agent) (§7);
- UI (Groups page, admin view, account page) (§11);
- capacity cap (§13).

**Phase 3 — One app per principal / retire `.users.`**
- consolidate to app `12000+id` + WebUI `11000+id`; drop `.users.`; cert
  `*.<base>`; migrate existing private apps; update skill/WebUI/XMPP hostnames
  and `sanitizeNext`.

**Phase 4 — Multi-host (deferred)**
- directory identity, central uid/gid, shared homes, membership fan-out.

---

## 17. Code touchpoints

- `server/db.ts` — users schema/migrate (`kind`, `owner_user_id`,
  `require_auth`), `group_members`, `getPrincipalByName`/`getUserByName`,
  `listUsers` filter, group/member CRUD, `listSiteUsers` (groups included),
  `listActiveAccountUsers`.
- `server/auth.ts` — login `kind='user'`; session guard; `sanitizeNext`
  broadening.
- `server/index.ts` — `/internal/auth` optional/required + membership.
- `server/routes.ts` — `/api/groups` (CRUD, members, provision, repair,
  restart/logs, message); admin group view; filter user list; hide
  group-inapplicable actions.
- `server/provision.ts` — branch on kind (XMPP agent only, allowed users,
  `SOUL.md`, app/WebUI units).
- `server/sites.ts` — groups flow through; app/WebUI slots; `require_auth`.
- `server/inventory.ts` / `server/config.ts` — ports/domains; no new secrets.
- `scripts/hermes/ensure.sh` — member list, `SOUL.md`, allowed users, group
  branch.
- `scripts/webui/ensure.sh` — group WebUI env (`TRUSTED_GROUPS_HEADER`,
  `GROUP_PROFILE_MAP`).
- new scripts — group account provisioning, app unit install/restart/logs,
  repair permissions.
- nginx template — cookie strip, `Remote-User`/`Remote-Groups`, optional vs
  require_auth.
- `client/` — Groups page + store, admin group view, account-page group apps,
  message modal with member picker.
- `notes/auth-protocol.md`, `kunguru-sites` skill — app auth contract.

---

## 18. Verification

- Create a group: name validation (collisions, reserved, `-agent`), 5-group cap.
- Linux: user+group exist, home `2770` setgid, linger, locked login; member in
  group.
- Slots: `<g>.<base>` and `<g>-agent.<base>` resolve and present the wildcard
  cert; app optional by default; WebUI requires login.
- Identity: `Remote-User`/`Remote-Groups` present on app requests; absent for
  anonymous; not spoofable from the client; session cookie not visible to the
  app.
- Auth: non-member gets 302/401 on the group WebUI; member gets 200; removed
  member loses access immediately.
- Hermes: agent account, allowed users, `SOUL.md` roster; membership change
  restarts and updates; WebUI sessions per member, shared root-profile memory.
- App unit: restart works, logs visible, `PORT`/bind/`TRUSTED_PROXY` correct.
- Repair permissions: chgrp/setgid restored; symlinks not followed out; job
  logged.
- Disable: routes/auth drop; home retained; no delete path.
- Message-as-agent: member picker sends to the selected member.
- `pnpm check` (tsc + check-config) and a build.
