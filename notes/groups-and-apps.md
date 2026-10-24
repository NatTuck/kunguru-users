# Groups, apps, and static sites — design & implementation plan

Status: **Phases 1, 2a, 2b, 3a and 3b implemented** on `feature/groups` (not
deployed). Remaining: per-turn member identity in group WebUI sessions
(upstream), per-group resource limits, and the live migration/cutover.

Related: `notes/auth-protocol.md`, `notes/deploy.md`,
`scripts/hermes/ensure.sh`, `scripts/webui/ensure.sh`.

---

## 1. Model

- Every **account** (a user, or a group) gets **one app with two variants** plus
  a managed WebUI:

  | Slot | Hostname | Port | Access |
  |---|---|---|---|
  | app | `<account>.<base>` | 12000 + id | optional auth (or require_auth) |
  | app-dev | `<account>-dev.<base>` | 13000 + id | optional auth (or require_auth) |
  | hermes-webui | `<account>-agent.<base>` | 11000 + id | app session (managed) |

- **Groups are accounts** in the `users` table (`kind='group'`), sharing the id
  space, namespace, `accounts`, and ports. **5 owned groups per user.**
- **Extra apps for a user are groups.** There is no per-app allocator and no
  `apps` table.
- **Aliases are retired.** Custom app hostnames require an account name
  (`writing-hub` = a group named `writing-hub`; `ops`/`ops-dev` = a group named
  `ops`).
- **Static sites** are a separate owner-scoped resource:
  - owner is a **user or group**, limit **5 per owner**;
  - label → `<label>.<base>` (unique, shared namespace);
  - **source/build project** at `~/sites/<label>`;
  - **served docroot** at `~/www/<label>` (the built output);
  - served by **nginx on the owner's host** (the user server); the gateway
    forwards `<label>.<base>` to `<owner-host>:<static-port>`.
- **App code**: `~/.local/apps/app` (production) and `~/.local/apps/app-dev`
  (dev); units `app.service` / `app-dev.service`; WebUI at
  `~/.local/apps/hermes-webui`.
- `-dev` and `-agent` are **reserved suffixes** for account/site labels.
- Multi-user-server + shared accounts + shared file tree are intended but
  deferred (§14); keep `host_id` seams.

---

## 2. Decisions (settled)

1. Groups live in `users` (`kind='group'`), not a parallel table.
2. Two fixed app ports per account (`12000+id`, `13000+id`) + WebUI
   (`11000+id`); no per-app allocation.
3. Groups are the extra-app mechanism; aliases are gone.
4. Static sites are owner-scoped, 5 per owner, source `~/sites/<label>`, served
   `~/www/<label>`, served by user-server nginx.
5. Group apps run as `--user` units as the group user; the app can restart them
   and read journald.
6. Hermes for a group is 1:1 per member, **root profile in the group home** (no
   named profile), `SOUL.md` roster.
7. No secrecy boundary between members; home `2770`; revocation via Linux group.
8. Verified identity: gateway authenticates optionally and injects
   `Remote-User`/`Remote-Groups`; apps never see the session cookie. WebUI and
   `require_auth` hosts require login; everything else is optional.
9. **Disable only, no delete** for groups; ownership transfer by an admin.
10. **Message-as-agent for groups** with a member picker.
11. Self-service group creation/provisioning and static sites, with capacity
    caps.
12. Multi-host/shared FS deferred.

---

## 3. Identity and namespace

Users and groups share one namespace (`users.username UNIQUE`). Static-site
labels also live in it.

Validation for a new account or static-site label:

- lowercase letters/digits/hyphens, starting with a letter;
- not ending in `-agent` or `-dev`;
- not a reserved label (`users`, `llm`, `chat`, `www`, `admin`, `api`, …);
- not equal to an existing user/group or static-site label.

Hostnames:

```
<account>.<base>            app
<account>-dev.<base>        app-dev
<account>-agent.<base>      Hermes WebUI
<label>.<base>              static site
```

The wildcard cert (`*.<base>`) covers all of them.

---

## 4. Ports

```
app          12000 + id
app-dev      13000 + id
hermes-webui 11000 + id
static       a dedicated port on the owner's host (e.g. 14000),
             bound to the VPN/LAN address, gateway-only access
```

The gateway maps static-site hostnames to `<owner-host>:14000`; the user-server
nginx serves the docroot locally.

---

## 5. Data model

```sql
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'
  CHECK (kind IN ('user','group'));
ALTER TABLE users ADD COLUMN owner_user_id INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN require_auth INTEGER NOT NULL DEFAULT 0;      -- app
ALTER TABLE users ADD COLUMN require_auth_dev INTEGER NOT NULL DEFAULT 0;  -- app-dev

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS static_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user','group')),
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL UNIQUE,
  source_root TEXT NOT NULL,   -- ~/sites/<label>
  served_root TEXT NOT NULL,   -- ~/www/<label>
  require_auth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `users.password_hash` stays `NOT NULL`; groups get a random hash. Login
  filters `kind='user'`.
- **Aliases table is dropped** (after migrating `docs` and `ops`).
- Invariants: owner/members are `kind='user'`; ≤5 owned groups; ≤5 static sites
  per owner; `served_root` under `/home/<owner>/www/`; `source_root` under
  `/home/<owner>/sites/`; no `..`/symlink escape.

---

## 6. Provisioning

Linux account (user or group):

- `useradd --user-group <name>`; locked login, no password, non-login shell;
  linger enabled.
- home `/home/<name>` `2770` setgid; `~/sites/<label>` (source) and
  `~/www/<label>` (served) created for static sites, with `www-data` read access
  (ACL: `setfacl -m u:www-data:x /home/<name>` +
  `setfacl -R -m u:www-data:rX /home/<name>/www/<label>`).
- member add/remove via `gpasswd`.

App slots (per account):

- Provisioning installs two **user units**: `app.service` →
  `WorkingDirectory=%h/.local/apps/app`, `PORT=12000+id`, `HOST=<bind>`;
  `app-dev.service` → `~/.local/apps/app-dev`, `PORT=13000+id`. Both are
  enabled at boot; `ConditionPathIsExecutable=%h/.local/apps/<slot>/run` keeps a
  slot inactive (not failed) until the account provides the convention start
  script.
- The units are user units: the app drives them as root through the account's
  user manager (`runuser` / `systemctl --user -M`), which works for user and
  group accounts alike. Members of a group have no session as the group, so the
  app's UI is their control surface.
- The app's UI shows each slot's state (installed / enabled / active) and offers
  enable, disable, restart, and recent journal logs. The unit files are
  platform-owned (port, bind address, restart policy); the `run` script and code
  are the account's.
- `HOST` is loopback when the account is on the gateway host (one-host
  deployments) and the host's VPN/LAN address otherwise — derived from the host
  row, never hardcoded.

Group accounts (Phase 3a):

- `scripts/account/ensure-group.sh`: `useradd --user-group`, locked login,
  linger, and a shared home (`2770`, setgid, group = the group) so members can
  read/write while other tenants cannot enter.
- `scripts/account/ensure-membership.sh`: converges the Linux group to the
  app's `group_members` rows (`gpasswd -a`/`-d`); run after provisioning and
  after every membership change. Membership applies to new sessions.
- Self-service groups are provisioned on the owner's host; an admin can retry
  (Repair) or choose a host through the same provisioning path.
- Group Hermes (root profile, `SOUL.md`, WebUI map, message-as-agent) is Phase
  3b; a group currently gets no Snikket or Hermes.

Hermes (optional, per account):

- agent-only XMPP account `<name>-agent@chat.<base>`; allowed users = member
  JIDs; **root profile** in the account home; `SOUL.md` roster at
  `$HERMES_HOME/SOUL.md`.
- WebUI on `<name>-agent.<base>`; env:
  `HERMES_WEBUI_TRUSTED_AUTH_HEADER=Remote-User`,
  `HERMES_WEBUI_TRUSTED_GROUPS_HEADER=Remote-Groups`,
  `HERMES_WEBUI_GROUP_PROFILE_MAP={"<name>":"default"}` (pin root).
- Per-group Bifrost VK + model.

User-server nginx (static sites):

- Install nginx if missing; base config listens on the VPN/LAN address on the
  static port, `allow <gateway-wg-ip>; deny all;`, default server `404`,
  `autoindex off`, `disable_symlinks on`, `server_tokens off`.
- One `server` per static site: `server_name <label>.<base>`,
  `root /home/<owner>/www/<label>`; `nginx -t` (with rollback) + reload after
  reconcile.
- Managed by `scripts/nginx/ensure-user-static.sh`, run by the app on each user
  server; it also creates the directories and the `www-data` ACLs.

Gateway:

- Route map includes app/app-dev/webui hosts and static-site hosts
  (→ `<owner-host>:14000`); `auth_request` for `require_auth`; cookie strip;
  WebSocket upgrade; `Host` preserved.
- Gateway-local owners (the admin `kunguru`) are served directly with a `root`
  block: a loopback listener would let any local process read a `require_auth`
  site by sending the `Host` header directly.
- A permanent redirect from the retired `.users.` hosts (needs the
  `*.users.<base>` SAN).

---

## 7. Authorization

- `/internal/auth` resolves the host to an account or static site:
  - optional host: `200` + identity when signed in, else `200` + empty;
  - `require_auth` host: `200` + identity, else `401` (nginx login redirect);
  - group host: allow members/owner.
- `Remote-Groups` carries the signed-in user's group names.
- Login filters `kind='user'`; `resolveSession` rejects groups.
- Self-service `/api/groups` (list/create/members/disable/enable/provision):
  owner/member read; owner manage; admin override. Account-scoped resources use
  `/api/accounts/:id/...`: app slots let any member operate them, static sites
  are owner-manage/member-read. Admin: `GET /api/admin/groups`, ownership
  transfer (`POST /api/groups/:id/owner`).
- Admin user list filters `kind='user'`; hide human-only actions for groups.
- Message-as-agent for groups: pick a member; send from `<group>-agent` to that
  member's JID.

---

## 8. Filesystem, permissions, trust model

- Account home `2770` setgid; members can read/write; other tenants cannot.
- No private/shared split; members can prompt the agent and write to the tree.
- Revocation is by Linux group membership.
- **Static sites**: source `~/sites/<label>`, served `~/www/<label>`; the
  user-server nginx (`www-data`) needs traverse/read (ACL recommended);
  `disable_symlinks on`; docroot under the owner's home; no directory listing.
- **Repair permissions**: re-apply group ownership + setgid on the home; a
  separate repair for `~/www/<label>` ACLs.
- Umask 002 for members so shared files stay group-writable.

---

## 9. App / WebUI units

- `app.service`, `app-dev.service` as above; `hermes-webui.service` managed by
  `scripts/webui/ensure.sh`; `hermes-gateway.service`,
  `hermes-xmpp-watchdog.*`.
- Restart/logs are driven by the app (`scripts/account/app-control.sh` →
  `runuser … systemctl --user …` / `journalctl --user`); the equivalent manual
  commands are `systemctl --user -M <account>@ restart app` and
  `journalctl --user -M <account>@ -u app`.
- Static sites have **no unit**; the user-server nginx serves them.

---

## 10. Hermes for a group

**Implemented (3b)** as an explicit, background "Enable agent" run per group:

- agent identity `<name>-agent@chat.<base>`; allowed users = member JIDs
  (converged into `XMPP_ALLOWED_USERS`); proactive messages default to the group
  owner as the home channel;
- Hermes installed in the group home with the **root profile** (no named
  profile); shared memory; per-member WebUI sessions;
- `SOUL.md` roster at `$HERMES_HOME/SOUL.md` (identity slot #1), generated by
  `scripts/hermes/ensure-soul.sh`; regenerated (and the gateway restarted only
  when the roster/allowlist changed) on membership change;
- WebUI pinned to the root profile via
  `HERMES_WEBUI_GROUP_PROFILE_MAP={"<group>":"default"}`;
- per-group Bifrost virtual key; the group's default model follows the account;
- message-as-agent: the owner/admin sends from `<group>-agent` to a chosen
  member (`POST /api/groups/:id/message`).

**Remaining (upstream)**: per-turn identity. XMPP sets `user_id`/`user_name`,
but the WebUI does not forward `Remote-User` to the gateway and the gateway API
server does not set `user_id`/`user_name`; until that lands the agent cannot
reliably attribute a WebUI turn to a member (SOUL.md tells it to ask). A
`pre_llm_call` hook injects the sender once the header is available.

---

## 11. UI

- **Groups page**: my groups (owned + member-of), create ≤5, members, app URLs,
  provision status/log, restart/logs, repair, message (member picker).
- **Static sites page**: my sites (owned), create ≤5 (label + source/served
  paths), `require_auth`, delete (route only; files retained), status.
- **Groups page**: my groups (owned + member-of), create (≤5), members
  (add/remove for the owner), app slots and static sites per group, agent
  enable/update with the job log, message-as-agent with a member picker,
  provision/repair, disable/enable; members see the group read-only except for
  its app slots.
- **Account page**: the app-slot panel (state, enable/disable, restart, logs,
  links) and static sites.
- **Admin**: the same app-slot and static-site panels per account, plus
  **Manage groups** (`/admin/groups`): every group, its owner and state, app
  slots, sites, disable/enable, and ownership transfer.
- App-slot `require_auth`/`require_auth_dev` are enforced by `/internal/auth`
  but have **no UI yet**; set the columns directly until the self-service
  toggle lands in Phase 3.
- Admin: all groups, all static sites, disable/transfer.

---

## 12. Lifecycle

- **Create account**: DB row + job (Linux user/group, home, linger; optional
  Hermes).
- **Static site**: create DB row, make `~/www/<label>`, ACLs, render the
  user-server nginx + gateway route; delete removes the route (files remain).
- **Member add/remove**: Linux group (Phase 3a), then XMPP allowlist,
  `SOUL.md`, agent restart (Phase 3b).
- **Disable/enable**: routes and auth drop; home/files retained.
- **Ownership transfer**: admin only.
- **Message-as-agent**: member picker.

---

## 13. Capacity and limits

- 5 owned groups/user; 5 static sites/owner.
- Self-service Hermes provisioning gated by a per-host/global cap; clear "no
  capacity" error.
- Each Hermes ≈ 0.5 GB RAM / ~7 GB disk; static docroots consume user-server
  disk (cap + quota).

---

## 14. Multi-host / shared accounts and file tree (intended, deferred)

Intended: directory identity + shared file tree across user servers; group
homes on the shared tree; members can access from any host.

Deferred: one user server today; local homes, local Linux groups. Keep `host_id`
on accounts, keep membership changes in one converge step, don't bake
single-host assumptions into `siteRoutes`/auth.

Topology (one host vs gateway + user servers, and the constraints current work
must respect) is documented in `notes/topology.md`.

---

## 15. kunguru.net inventory & migration

**Special cases** (excluded): `users.<base>` (auth app), `chat.<base>` +
`groups.chat.`/`share.chat.` (Snikket), `llm.<base>` (Bifrost), `kunguru.net` /
`www` (apex), `*-agent.<base>` (WebUIs), `drongo.ferrus.net`, `default`.

**Personal apps**: 7 users; only `ndinda` (private 10 KB “ndinda operations”,
public 195 B test) and `nat` (private 541 B “Batcave”) have content; 5 users have
nothing listening.

**Source vs served today**: source/build projects live in ndinda's
`~/sites/<label>`; served docroots are on the **gateway** at
`/home/kunguru/www/<host>` (built output). There is no `~/www` on the user
server. Migrate to source `~/sites/<label>` + served `~/www/<label>` on the
owner's host.

**Static sites** (pure static): `declutter`, `docs`, `thoughts`, `wireframes`
(source for `wireframes` not found in ndinda's `~/sites`; ownership unclear).
`docs` source is ndinda's, DB alias owner `kunguru` — decide.

**Static + API (apps, not static sites)**: `snacks` (`/api/` 8801), `tasks`
(4011), `tasks.comms` (4013), `tasks.ops` (4012). `hours.kunguru.net` is a Node
app (`server.cjs`), not a static site.

**Apps / groups**:
- `ops` → **group named `ops`** (`ops.<base>`, `ops-dev.<base>`); retire the
  legacy 4001 vhost/alias; move the app to the group's app slot.
- `writing-hub` → group `writing-hub` (owned by ndinda).
- `gitbot`, `tongue-tie-dev` → **retire** (down).
- `hours` → an app/group.

**Port/hostname mapping**: public `12000+id` stays `<user>.<base>`; private
`13000+id` becomes `<user>-dev.<base>`; WebUI `11000+id` becomes
`<user>-agent.<base>`. Retire `.users.`.

**Auth migration**: two-stage (strip `kunguru_sid` everywhere first, then
broaden the cookie + enable optional auth); see `notes/auth-protocol.md`.

---

## 16. Phases

**Phase 1 — Auth foundation** (done, on `feature/groups`)
- cookie `Domain=<base>`; strip the session cookie upstream; inject
  `Remote-User`/`Remote-Groups`; optional vs `require_auth`; login redirect;
  `sanitizeNext` for `<label>.<base>`; additive schema.

**Phase 2 — Two-port apps + static sites** (foundation for groups)
- done (2a): schema (`require_auth`/`require_auth_dev`, `static_sites`, aliases
  dropped); `server/sites.ts` host model; `/internal/auth` for account slots and
  static sites; gateway route map; user-server static nginx
  (`scripts/nginx/ensure-user-static.sh`, dirs + ACLs);
  `/api/static-sites` + admin routes; UI (app/app-dev cards, static-sites panel
  and admin modal).
- done (2b): app slots as user units + convention `run` scripts, provisioning,
  and the in-app control surface (state, enable/disable, restart, logs).
- todo (2b): migration of the existing sites/apps (see §15).

**Phase 3 — Groups**
- done (3a): group accounts (Linux user/group, shared 2770 home, app slots),
  membership convergence, owner-aware auth (hosts, app slots, static sites),
  self-service `/api/groups` + capacity cap (5 owned), Groups page, disable/
  enable, admin ownership transfer API.
- done (3b): Hermes for groups (agent account, root profile, `SOUL.md` roster +
  allowlist convergence, WebUI profile map, per-group Bifrost key),
  message-as-agent with a member picker, admin groups view.
- todo (3b): per-turn member identity (upstream: the WebUI must forward
  `Remote-User` and the gateway API server must set `user_id`/`user_name`), and
  per-group resource limits.

**Phase 4 — Multi-host (deferred)**.

---

## 17. Code touchpoints

- `server/db.ts` — users (`kind`, `owner_user_id`, `require_auth`,
  `require_auth_dev`), `group_members`, `static_sites`, `getUserByUsername`
  (any kind), `listUsersWithAccounts` filter, `listSiteUsers` (accounts),
  `listStaticSiteHosts` (sites + owner host).
- `server/auth.ts` — login `kind='user'`; session guard; `sanitizeNext`.
- `server/index.ts` — `/internal/auth` optional/required + membership + static
  sites.
- `server/routes.ts` — `/api/groups`, `/api/static-sites`, app/app-dev status,
  message; admin views; filter user list.
- `server/provision.ts` — account branch, app-slot step, static-site dirs/ACLs.
- `scripts/account/ensure-apps.sh` — app-slot dirs + user units.
- `scripts/account/app-control.sh` — status / enable / disable / restart / logs.
- `server/apps.ts` — transport + status parsing for the app slots.
- `client/AppSlotsPanel.tsx` — the control surface.
- `scripts/account/ensure-group.sh` — the Linux user/group + shared home.
- `scripts/account/ensure-membership.sh` — Linux group membership.
- `server/provision.ts` — `GROUP_ACCOUNT_PROFILE`, `provisionGroup`,
  `ensureGroupMembership`.
- `server/routes.ts` — `/api/groups`, `/api/admin/groups`, account-scoped
  static sites.
- `client/groupsStore.ts`, `client/GroupsPage.tsx` — the Groups page.
- `client/AdminGroupsPage.tsx` — the admin groups view.
- `scripts/hermes/ensure-soul.sh` — SOUL.md roster + XMPP allowlist + restart.
- `server/provision.ts` — `GROUP_HERMES_PROFILE`, `startGroupAgent`,
  `sendGroupAgentMessage`.
- `server/routes.ts` — `/api/groups/:id/hermes`, `/api/groups/:id/message`,
  creator-readable job polling.
- `server/sites.ts` — app/app-dev/webui routes; static-site routes to the
  owner-host static port; drop alias routes.
- `server/nginx.ts` — `reconcileUserSites` (gateway), `reconcileUserStaticSites`
  (each host), `reconcileSites` (both).
- `scripts/nginx/ensure-user-sites.sh` — gateway routes (one wildcard vhost +
  host->upstream map; no tenant docroots).
- `scripts/nginx/ensure-user-static.sh` — user-server static listener, site
  directories and `www-data` ACLs.
- `scripts/hermes/ensure.sh` — skill text, `SOUL.md`, allowed users, group
  branch.
- `scripts/webui/ensure.sh` — group WebUI env.
- `client/` — Groups page, Static sites page, app URLs, message modal.
- `notes/auth-protocol.md`, `kunguru-sites` skill.

---

## 18. Verification

- Two-port apps: `<account>` and `<account>-dev` resolve, optional/require_auth
  behavior correct, app units restart/log.
- App slots: provisioning installs `app.service`/`app-dev.service` (enabled,
  inactive until `run` is executable), the UI shows state and logs, enable /
  disable / restart work for a user account and for a group account (as an
  admin), and `HOST` is loopback on a one-host deployment.
- Static sites: source `~/sites/<label>`, served `~/www/<label>`; user-server
  nginx serves 200; gateway forwards; `require_auth` gates; `www-data` can read;
  symlink escape blocked; 5/owner cap; a gateway-local site is served by the
  gateway vhost (no loopback listener); deleting the last site on a host removes
  its listener; a failed host reconcile drops that host's gateway routes.
- Auth edges: a **disabled** owner's static site is 403 (not just unrouted); the
  retired `.users.` hosts redirect to the two-port hosts.
- Identity: `Remote-User`/`Remote-Groups` on apps; cookie not visible to
  upstreams; anonymous optional; WebUI/require_auth redirect.
- Groups (3a): create (≤5), Linux user/group + 2770 home, membership add/remove
  converges the Linux group, owner/member/admin authorization on the group, its
  app slots and its static sites, disable drops the routes, ownership transfer,
  group members can operate app slots but only the owner manages sites.
- Groups (3b): "Enable agent" creates `<group>-agent`, installs Hermes in the
  group home, writes SOUL.md, converges the allowlist, pins the WebUI profile,
  issues the Bifrost key; membership changes regenerate SOUL.md/allowlist and
  restart only when they changed; message-as-agent reaches the picked member;
  the admin groups view lists/transfers/disables. Per-turn identity remains
  upstream.
- Limits: 5 groups/user, 5 static sites/owner; capacity errors.
- `pnpm check` (tsc + check-config) and a build.
