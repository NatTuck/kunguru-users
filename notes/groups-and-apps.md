# Groups and extra apps — design & implementation plan

Status: **design agreed, not implemented.** Decisions below are settled; open
questions are listed in §15.

Related: `notes/expanded-design.md`, `notes/deploy.md`,
`scripts/hermes/ensure.sh`, `scripts/webui/ensure.sh`.

---

## 1. What a group is

A **group** is a principal that a real user creates from the web UI. It is
modelled as a row in the existing `users` table with `kind = 'group'` (see §3),
so it shares the id space, namespace, `accounts` row, slots, and ports with
human users.

Each group has:

- an **actual Linux user and Linux group with the same name**. `useradd <name>`
  creates the group as the user's primary group, so the pair is created
  together; members are added as *supplementary* members of that group
  (`gpasswd -a <member> <name>`).
- a **home directory** `/home/<name>`, owned `<name>:<name>`, mode `2770`
  (setgid), used for shared work.
- an **owner** (the creating user), plus **members** (other users).
- optionally a **Hermes instance** (1:1 with each member — §10).
- a **public** and a **private** web app slot (§9), plus the Hermes WebUI slot
  when Hermes is provisioned.
- a per-group **Bifrost virtual key** and default model, via its `accounts` row.

Limits: **5 groups per owning user** (enforced server-side).

Extra apps for a user are implemented as groups (a solo group = an extra app).
There is therefore **no separate `apps` table and no port allocator** for this
feature.

---

## 2. Decisions (settled)

1. **Groups live in `users`** (`kind = 'group'`), not a parallel table.
2. **Shared id space** ⇒ the existing port formula (`11000/12000/13000 + id`)
   applies to groups unchanged.
3. **Formulaic ports**, no allocator, no per-app allocation.
4. **Groups are the extra-app mechanism**; they consume the hostname namespace.
5. **Group apps run as `--user` systemd units as the group user**; the app can
   restart them and read their journald logs (§9).
6. **Hermes for a group is 1:1 per member**, with `SOUL.md` seeded from the
   member list (§10).
7. **No secrecy boundary between group members**: members can already prompt
   the agent into revealing its own secrets and share code execution, so the
   group home is not split into private/shared trees. The boundary is *group
   members vs other tenants* (mode `2770`, no world access). Revocation works
   by Linux group membership (§8).
8. **Multi-user-server + shared accounts + shared file tree are intended but
   deferred.** Today there is one user server; group homes are local and
   membership is the local Linux group. See §14.

---

## 3. Identity and namespace

Users and groups share **one namespace** (`users.username UNIQUE`), and it also
shares with alias labels and reserved names.

Validation for a new group name:

- same rule as usernames (`isProvisionableUsername`): `[a-z][a-z0-9-]{0,30}`,
  not ending in `-agent`, not in `RESERVED_LABELS` (`users`, `llm`, `chat`,
  `www`, `admin`, `api`, …);
- not equal to an existing **user or group** (`users.username`);
- not equal to an existing **alias label** (`aliases.label`).

Hostnames derived from the name (all covered by the existing wildcard cert
`*.kunguru.net` + `*.users.kunguru.net` — no cert churn):

```
<name>.<base>                 public app
<name>.users.<base>           private app
<name>-agent.users.<base>     Hermes WebUI (when provisioned)
```

---

## 4. Ports and hostnames

Because groups share the `users.id` sequence:

```
public-site   12000 + id
private-app   13000 + id
hermes-webui  11000 + id
```

No new bases, no allocation, no collision with user slots. `server/sites.ts`
(`siteRoutes`, `servicePort`, `*Host`) already produces these for every row in
`listSiteUsers`; groups appear there automatically.

---

## 5. Data model

Additive migration (no table rebuild):

```sql
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'
  CHECK (kind IN ('user','group'));
ALTER TABLE users ADD COLUMN owner_user_id INTEGER REFERENCES users(id); -- humans: NULL

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
  (they never log in). Login additionally filters `kind = 'user'` as defence in
  depth.
- `accounts` is reused unchanged: `UNIQUE(user_id, host_id)` works for groups;
  `bifrost_vk_id`, `hermes_model`, `agent_*` are per group.
- SQLite can't enforce cross-table invariants; enforce in the app layer.

Invariants (application-enforced):

- `kind='group'` ⇒ `owner_user_id` is a `kind='user'` (and enabled).
- `kind='user'` ⇒ `owner_user_id IS NULL`.
- `group_members.user_id` is `kind='user'`; a group cannot be a member.
- `count(*) WHERE kind='group' AND owner_user_id = ?` ≤ **5**.
- name uniqueness as in §3.

---

## 6. Provisioning

Reuse the existing job/step machinery (`jobs`, `job_steps`, `provision.ts`,
`scripts/…`). Group provisioning is idempotent and repairable, like user
provisioning.

Linux account:

- `useradd --user-group <name>` (creates user + primary group `<name>`).
- locked login: no password, non-login shell; **linger enabled** so
  `systemd --user` runs at boot.
- home `/home/<name>` owned `<name>:<name>`, mode `2770` setgid.
- member add/remove ⇒ `gpasswd -a/-d <member> <name>`.

Hermes (optional):

- reuse `scripts/hermes/ensure.sh` with the group's username/id;
- **only the agent XMPP account** is created (`<name>-agent@chat.<base>`); no
  human `<name>@chat` account;
- `XMPP_ALLOWED_USERS` = the member JIDs;
- `SOUL.md` seeded/refreshed with the member list (§10);
- WebUI on `<name>-agent.users.<base>` via `scripts/webui/ensure.sh`;
- per-group Bifrost virtual key + model default on the `accounts` row.

App units:

- create `kunguru-app-public.service` / `kunguru-app-private.service` as
  `--user` units for the group user (§9).

---

## 7. Authorization

### Login / sessions

- Login query: `WHERE username = ? AND kind = 'user'`.
- `resolveSession` / `getSessionUser` must never yield a group (guard
  defensively).
- `getUserByUsername` is overloaded today; split into:
  - `getPrincipalByName` (any kind) — for hostname→owner and alias collision;
  - `getUserByName` (`kind='user'`) — for login.

### `/internal/auth` (nginx auth_request)

Resolve the private host to its principal, then:

```
if principal.kind == 'group':
    allow iff session user is a member of principal (group_members)
else:
    allow iff session user.id == principal.id
```

This covers the group's private app **and** its Hermes WebUI. Membership is
read from the DB on every request, so removal takes effect immediately.

### Admin / self-service

- `requireAdmin` stays `role='admin'` (groups have `role='user'`, so they can
  never be admin).
- New self-service `/api/groups` endpoints: a user may read groups they own or
  belong to; the owner may manage members; admins may manage any group.
- Admin user list (`listUsers`, `listUsersWithAccounts`, `toAdminRows`) must
  filter `kind='user'`; groups get their own view.
- Hide human-only admin actions for groups: reset password, make admin,
  message-as-agent (no single recipient).

---

## 8. Filesystem, permissions, trust model

- Home `/home/<name>`: `2770`, owner `<name>:<name>`. Members (in the Linux
  group) can read/write; other tenants cannot.
- Setgid makes new subdirectories inherit the group and new files get the
  group. Members need **umask 002** for files to be group-writable — see §15.
- **No private/shared split.** Members can prompt the agent and can write to the
  shared tree, so hiding `.hermes` from members is not a boundary. Accept that a
  member can tamper with the shared agent (affects other members).
- **Revocation** is by Linux group membership: removing a member from the group
  removes access regardless of file modes.
- **Repair permissions** (button, admin/owner): re-apply group ownership and
  setgid on the home tree, constrained to `/home/<name>`:
  - `find /home/<name> -xdev ... -exec chgrp <name> {} +`
  - re-apply `chmod g+s` on directories;
  - symlink-safe (`-P`, don't follow out of the tree);
  - run as a job, rate-limited, logged.
- Deleting a group removes the home (archive vs delete — §15).

---

## 9. App slots as managed `--user` units

Members cannot `systemctl --user` as the group user, so the app owns the units.

- Units: `kunguru-app-public.service`, `kunguru-app-private.service` under the
  group user, `Restart=always`, enabled with linger.
- Each runs a **convention start script** in the group home, maintained by
  members:
  ```
  ~/apps/public/run
  ~/apps/private/run
  ```
- The unit passes environment the app needs:
  - `PORT` (the slot port: `12000+id` / `13000+id`),
  - bind address / `KUNGURU_*` facts (from the same data as the
    `kunguru-sites` skill),
  - `TRUSTED_PROXY` for private apps (trust `Remote-User` only from the gateway).
- The app can:
  - **restart**: `systemctl --user -M <name>@ restart kunguru-app-public`,
  - **logs**: `journalctl --user -M <name>@ -u kunguru-app-public` (or
    `_UID=<uid>`),
  - show "not deployed" when the run script is missing.
- This resolves "who runs the slot": the managed unit, not whichever member
  SSH'd in last.

---

## 10. Hermes for a group

- **1:1 per member**: separate conversations keyed by each member's JID.
- Agent identity `<name>-agent@chat.<base>`; `XMPP_ALLOWED_USERS` = member JIDs.
- **`SOUL.md` seeded with the member list** so the agent understands it serves
  several humans.
- On **every membership change**: update Linux group, regenerate `SOUL.md`,
  update the allowlist, restart the agent. Idempotent convergence (same job
  pattern as provisioning).
- Per-group Bifrost virtual key + model default.
- Home channel: per-member (no single group channel in the 1:1 model).
- WebUI at `<name>-agent.users.<base>`, member-gated; ensure conversation
  history is scoped by `Remote-User` (§15).

---

## 11. UI

Self-service **Groups** page (first non-admin surface in the app):

- my groups (owned + member-of), create (≤5, name validated per §3);
- per group: members (owner can add/remove), slot URLs/ports, provisioning
  status + job log, Hermes model, **restart app** / **view logs**,
  **repair permissions**;
- provisioning action for the optional Hermes instance.

Admin view:

- all groups, disable/enable, delete, transfer ownership (per §15), view logs.

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
- **Disable**: groups are disabled like users; auth gate and routes drop.
- **Delete**: remove Linux user+group, home (archive vs delete — §15), Hermes,
  XMPP, Bifrost key, units, DB rows (FK cascade for `accounts`,
  `group_members`, `aliases`). Hostnames are covered by the wildcard cert, so
  no cert change.
- **Owner disabled/deleted**: users are disabled, never deleted; groups persist
  with a disabled owner — admin can transfer (§15).

---

## 13. Capacity and limits

- 5 groups per owning user (enforced).
- 5/user is **not** a capacity bound: each provisioned group Hermes is
  ~0.5 GB RAM and ~7 GB disk (measured per tenant). On the current single user
  server (disk-bound at ~13 tenants), a handful of group Hermes instances can
  exhaust disk. Need a global cap and/or admin approval for **provisioning**
  (creating the empty group can be free).
- Disk is the binding constraint; shared/deduped toolchain is the lever.

---

## 14. Multi-host / shared accounts and file tree (intended, deferred)

**Intended**: every user server in an instance shares user accounts (directory
service, e.g. LDAP) and a shared file tree (e.g. NFS), with central uid/gid
allocation. Group homes live on the shared tree; members can access from any
host; the group's Hermes/apps run on the group's host.

**Deferred**: today there is one user server, so:

- group homes are local; membership is the local Linux group;
- provisioning uses local `useradd`/`groupadd`/`gpasswd`;
- no directory service, no NFS.

**Keep the seams** so this lands cleanly later:

- keep `host_id` on the group's `accounts` row even though it is constant now;
- keep membership changes in one place (a converge step) so they can be
  fanned out to the directory later;
- don't bake "single host" into `siteRoutes`/auth (they already route per
  `ssh_target`).

When multi-host lands, this section becomes: directory-based identity, central
uid/gid, group homes on the shared export, membership propagation to every
host, and `useradd` → directory writes.

---

## 15. Open questions

1. **Membership rights**: owner-only add/remove? can the owner transfer
   ownership / leave? admin override? effect of disabling a user who owns or
   belongs to groups?
2. **Provisioning gate**: self-service Hermes for groups, or admin-approved?
   global cap?
3. **Group deletion**: real delete vs disable-only; archive vs delete the home;
   what happens to files owned by removed members.
4. **Repair permissions**: `chgrp -R` only, or also re-apply setgid / `g+rwX`;
   rate limit; job log. And **umask 002** for members (profile / directory).
5. **WebUI scoping** for a shared 1:1 agent: confirm history is scoped by
   `Remote-User` so members don't see each other's conversations.
6. **Audit log** for membership/ownership/repair/provision actions.
7. **Message-as-agent** for a group: hide, or broadcast to members?

---

## 16. Phased implementation

**Phase 0 — docs/decisions.** Land this file; add a line to `AGENTS.md`
recording the intended-but-deferred multi-host/shared-FS model.

**Phase 1 — schema + namespace + ports.**
- `kind`, `owner_user_id`, `group_members` migration.
- `getPrincipalByName` / `getUserByName` split; login filter.
- name validation against users + aliases + reserved.
- group slots appear via `listSiteUsers`/`siteRoutes` (verify).

**Phase 2 — provisioning.**
- group Linux user/group, home `2770` setgid, linger, locked login.
- optional Hermes branch (agent XMPP only, allowed users, `SOUL.md`).
- Bifrost VK + model.
- jobs/repair.

**Phase 3 — auth.**
- owner-aware `/internal/auth` (membership).
- admin list filtering; hide human-only actions.
- self-service `/api/groups` authz (owner/member/admin).

**Phase 4 — app units.**
- public/private `--user` units + run-script convention + env.
- restart + journald logs endpoints/UI.

**Phase 5 — UI.**
- Groups page (create ≤5, members, slots, provision, repair, restart/logs).
- admin group view; account-page group apps.

**Phase 6 — lifecycle + audit.**
- disable/delete/transfer; membership propagation; audit log.

**Phase 7 (deferred) — multi-host.**
- directory service, central uid/gid, shared homes, membership fan-out.

---

## 17. Code touchpoints

- `server/db.ts` — users schema/migrate (`kind`, `owner_user_id`),
  `group_members`, `getPrincipalByName`/`getUserByName`, `listUsers` filter,
  group/member CRUD, `listSiteUsers` (groups included), `listActiveAccountUsers`.
- `server/auth.ts` — login `kind='user'`; session guard.
- `server/index.ts` — `/internal/auth` membership check.
- `server/routes.ts` — `/api/groups` (CRUD, members, provision, repair,
  restart/logs); admin group view; filter user list; hide group-inapplicable
  actions.
- `server/provision.ts` — branch on kind (XMPP agent only, allowed users,
  `SOUL.md`); group units.
- `server/sites.ts` — no change expected (groups flow through); rename
  `SiteUserRow` → principal if desired.
- `server/inventory.ts` / `server/config.ts` — no change (ports formulaic).
- `scripts/hermes/ensure.sh` — member list, `SOUL.md`, allowed users, group
  branch.
- `scripts/webui/ensure.sh` — works as-is for the group user.
- new scripts — group account provisioning, app unit install/restart/logs,
  repair permissions.
- `client/` — Groups page + store, admin group view, account-page group apps.

---

## 18. Verification

- Create a group: name validation (collisions, reserved, `-agent`), 5-group cap.
- Linux: user+group exist, home `2770` setgid, linger, locked login; member in
  group.
- Slots: `<g>.<base>`, `<g>.users.<base>` resolve and present the wildcard cert;
  private app gated to members; public app open.
- Auth: non-member gets 302/401 on the private app and group WebUI; member gets
  200; removed member loses access immediately.
- Hermes: agent account, allowed users, `SOUL.md` lists members; membership
  change restarts and updates.
- App units: restart works, logs visible, `PORT`/bind/`TRUSTED_PROXY` correct.
- Repair permissions: chgrp/setgid restored; symlinks not followed out; job
  logged.
- Delete: Linux user/group, home, Hermes, XMPP, Bifrost key, units, DB rows
  gone; no cert change.
- `pnpm check` (tsc + check-config) and a build.
