import { mkdirSync, chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import argon2 from "argon2";

export const DATA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
);
export const DB_PATH = join(DATA_DIR, "kunguru.db");

export const ADMIN_USERNAME = "kunguru";

export type Role = "admin" | "user";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  kind: "user" | "group";
  owner_user_id: number | null;
  // Per-slot access policy: whether the gateway requires a signed-in principal
  // for the account's app / app-dev host. The WebUI slot is always required.
  require_auth: number;
  require_auth_dev: number;
  enabled: number;
  created_at: string;
}

export interface PublicUser {
  id: number;
  username: string;
  role: Role;
  created_at: string;
}

export type HostRole = "user-server" | "gateway" | "admin";

export interface Host {
  id: number;
  name: string;
  role: HostRole;
  ssh_target: string;
  enabled: number;
}

export type AccountStatus = "pending" | "active" | "failed";
export type JobStatus = "running" | "succeeded" | "failed";

export interface Account {
  id: number;
  user_id: number;
  host_id: number;
  status: AccountStatus;
  last_job_id: number | null;
  bifrost_vk_id: string | null;
  // Per-tenant default Hermes model (Bifrost `provider/name`). NULL falls back
  // to the instance-wide HERMES_MODEL; set when the user picks one in the UI.
  hermes_model: string | null;
  // Fleet visibility, reconciled from each agent host: the recorded update
  // channel, the agent version banner, and whether the agent runs on the
  // PM-managed environment ("pm") or the retired in-tree venv ("legacy").
  agent_channel: string | null;
  agent_version: string | null;
  venv_kind: string | null;
}

export interface JobRow {
  id: number;
  host_id: number | null;
  profile: string;
  created_by: number | null;
  status: JobStatus;
  started_at: number;
  finished_at: number | null;
}

export interface JobStepRow {
  id: number;
  job_id: number;
  seq: number;
  script: string;
  target_host_id: number | null;
  target_ssh: string;
  status: JobStatus;
  exit_code: number | null;
  output_log: string;
  started_at: number;
  finished_at: number | null;
}

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'group')),
    owner_user_id INTEGER REFERENCES users(id),
    require_auth INTEGER NOT NULL DEFAULT 0,
    require_auth_dev INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role     TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

  CREATE TABLE IF NOT EXISTS static_sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'group')),
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL UNIQUE,
    source_root TEXT NOT NULL,
    served_root TEXT NOT NULL,
    require_auth INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_static_sites_owner ON static_sites(owner_id);

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('user-server', 'gateway', 'admin')),
    ssh_target TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id INTEGER REFERENCES hosts(id),
    profile TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS job_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    script TEXT NOT NULL,
    target_host_id INTEGER REFERENCES hosts(id),
    target_ssh TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
    exit_code INTEGER,
    output_log TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host_id INTEGER NOT NULL REFERENCES hosts(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
    last_job_id INTEGER REFERENCES jobs(id),
    bifrost_vk_id TEXT,
    hermes_model TEXT,
    agent_channel TEXT,
    agent_version TEXT,
    venv_kind TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, host_id)
  );
`;

export function openDb(): Database.Database {
  mkdirSync(DATA_DIR, { recursive: true });
  fixPermissions();

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  failStaleJobs(db);
  fixPermissions();
  return db;
}

// Job runs execute in-process; a restart means any row still marked "running"
// will never finish. Mark them failed so polling observers terminate instead of
// spinning forever on a dead job.
function failStaleJobs(db: Database.Database): void {
  const now = Date.now();
  db.prepare(
    "UPDATE jobs SET status = 'failed', finished_at = ? WHERE status = 'running'",
  ).run(now);
  db.prepare(
    "UPDATE job_steps SET status = 'failed', finished_at = ? WHERE status = 'running'",
  ).run(now);
}

// Additive migrations for databases created before a column existed.
function migrate(db: Database.Database): void {
  const ucols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!ucols.some((c) => c.name === "enabled")) {
    db.exec("ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  }
  if (!ucols.some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'");
  }
  if (!ucols.some((c) => c.name === "owner_user_id")) {
    db.exec("ALTER TABLE users ADD COLUMN owner_user_id INTEGER REFERENCES users(id)");
  }
  if (!ucols.some((c) => c.name === "require_auth")) {
    db.exec("ALTER TABLE users ADD COLUMN require_auth INTEGER NOT NULL DEFAULT 0");
  }
  if (!ucols.some((c) => c.name === "require_auth_dev")) {
    db.exec("ALTER TABLE users ADD COLUMN require_auth_dev INTEGER NOT NULL DEFAULT 0");
  }
  const acols = db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[];
  if (!acols.some((c) => c.name === "bifrost_vk_id")) {
    db.exec("ALTER TABLE accounts ADD COLUMN bifrost_vk_id TEXT");
  }
  if (!acols.some((c) => c.name === "hermes_model")) {
    db.exec("ALTER TABLE accounts ADD COLUMN hermes_model TEXT");
  }
  if (!acols.some((c) => c.name === "agent_channel")) {
    db.exec("ALTER TABLE accounts ADD COLUMN agent_channel TEXT");
  }
  if (!acols.some((c) => c.name === "agent_version")) {
    db.exec("ALTER TABLE accounts ADD COLUMN agent_version TEXT");
  }
  if (!acols.some((c) => c.name === "venv_kind")) {
    db.exec("ALTER TABLE accounts ADD COLUMN venv_kind TEXT");
  }
  migrateAliases(db);
}

// Aliases are retired (the two-port account model + static sites replace them).
// A static alias becomes a static site for the same owner; a proxy alias needs
// an account or group with the same name, which only an operator can create, so
// it is dropped with a warning. The table is removed either way.
function migrateAliases(db: Database.Database): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'aliases'")
    .get();
  if (!exists) return;
  const rows = db
    .prepare("SELECT * FROM aliases ORDER BY label ASC")
    .all() as {
    user_id: number;
    label: string;
    kind: string;
    root: string | null;
    access: string;
  }[];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO static_sites
       (owner_kind, owner_id, label, source_root, served_root, require_auth)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const a of rows) {
    const owner = getUserById(db, a.user_id);
    if (a.kind === "static" && owner) {
      const home = `/home/${owner.username}`;
      insert.run(
        owner.kind,
        owner.id,
        a.label,
        `${home}/sites/${a.label}`,
        `${home}/www/${a.label}`,
        a.access === "private" ? 1 : 0,
      );
      console.warn(
        `migrated static alias '${a.label}' to a static site for '${owner.username}' ` +
          `(served root ${home}/www/${a.label}; previous docroot ${a.root ?? "unset"})`,
      );
    } else if (a.kind === "proxy") {
      console.warn(
        `dropped proxy alias '${a.label}': aliases are retired; create an account ` +
          `or group named '${a.label}' to keep that hostname`,
      );
    } else {
      console.warn(`dropped static alias '${a.label}': owner account is missing`);
    }
  }
  db.exec("DROP TABLE aliases");
}

let sharedDb: Database.Database | undefined;

export function getDb(): Database.Database {
  sharedDb ??= openDb();
  return sharedDb;
}

function fixPermissions(): void {
  for (const p of [DATA_DIR, DB_PATH]) {
    if (!existsSync(p)) continue;
    const st = statSync(p);
    const isDir = st.isDirectory();
    chmodSync(p, isDir ? 0o700 : 0o600);
  }
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${DB_PATH}${suffix}`;
    if (!existsSync(sidecar)) continue;
    chmodSync(sidecar, 0o600);
  }
}

const PASSWORD_LENGTH = 16;
const PASSWORD_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";

export function generatePassword(length = PASSWORD_LENGTH): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_CHARS[bytes[i] % PASSWORD_CHARS.length];
  }
  return out;
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password).catch(() => false);
}

export function getAdminUser(db: Database.Database) {
  return db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(ADMIN_USERNAME) as User | undefined;
}

export function getUserByUsername(
  db: Database.Database,
  username: string,
): User | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
    | User
    | undefined;
}

export function getUserById(
  db: Database.Database,
  id: number,
): User | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
    | User
    | undefined;
}

/**
 * Group names a user belongs to, for the `Remote-Groups` header. Returns [] on
 * databases without the groups schema (the query is forward-compatible with
 * the Phase 2 `group_members` table).
 */
export function listGroupsForUser(
  db: Database.Database,
  userId: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT g.username AS name
         FROM group_members m
         JOIN users g ON g.id = m.group_id
        WHERE m.user_id = ? AND g.enabled = 1
        ORDER BY g.username ASC`,
    )
    .all(userId) as { name: string }[];
  return rows.map((r) => r.name);
}

/** Whether a user is a member of a group. */
export function isGroupMember(
  db: Database.Database,
  groupId: number,
  userId: number,
): boolean {
  return !!db
    .prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?")
    .get(groupId, userId);
}

export function listUsers(db: Database.Database): PublicUser[] {
  return db
    .prepare(
      "SELECT id, username, role, created_at FROM users ORDER BY id ASC",
    )
    .all() as PublicUser[];
}

export interface AdminUserRow extends PublicUser {
  enabled: number;
  account: {
    hostId: number;
    hostName: string;
    hostRole: HostRole;
    status: AccountStatus;
    agentChannel: string | null;
    agentVersion: string | null;
    venvKind: string | null;
  } | null;
}

export interface AccountJoinRow extends PublicUser {
  enabled: number;
  host_id: number | null;
  host_name: string | null;
  host_role: HostRole | null;
  account_status: AccountStatus | null;
  agent_channel: string | null;
  agent_version: string | null;
  venv_kind: string | null;
}

export function listUsersWithAccounts(db: Database.Database): AccountJoinRow[] {
  return db
    .prepare(
      `SELECT u.id, u.username, u.role, u.enabled, u.created_at,
              a.host_id, h.name AS host_name, h.role AS host_role, a.status AS account_status,
              a.agent_channel, a.agent_version, a.venv_kind
       FROM users u
       LEFT JOIN accounts a ON a.user_id = u.id
       LEFT JOIN hosts h ON h.id = a.host_id
       WHERE u.kind = 'user'
       ORDER BY u.id ASC`,
    )
    .all() as AccountJoinRow[];
}

export interface SiteAccountRow {
  id: number;
  username: string;
  kind: OwnerKind;
  require_auth: number;
  require_auth_dev: number;
  ssh_target: string;
}

// Enabled accounts (users and groups) on an enabled host: the set that gets the
// two app slots + the WebUI route. Disabled accounts are omitted, so their
// reverse proxies are dropped on the next reconcile.
export function listSiteUsers(db: Database.Database): SiteAccountRow[] {
  return db
    .prepare(
      `SELECT u.id AS id, u.username AS username, u.kind AS kind,
              u.require_auth AS require_auth, u.require_auth_dev AS require_auth_dev,
              h.ssh_target AS ssh_target
       FROM users u
       JOIN accounts a ON a.user_id = u.id
       JOIN hosts h ON h.id = a.host_id
       WHERE u.enabled = 1 AND h.enabled = 1
       ORDER BY u.id ASC`,
    )
    .all() as SiteAccountRow[];
}

// Minimal account row for operations that only need to reach a host (agent
// update, WebUI restart).
export interface SiteUserRow {
  id: number;
  username: string;
  ssh_target: string;
}

// Enabled users on an enabled host whose account is active: the set that
// actually has a running Hermes WebUI unit to restart.
export function listActiveAccountUsers(db: Database.Database): SiteUserRow[] {
  return db
    .prepare(
      `SELECT u.id AS id, u.username AS username, h.ssh_target AS ssh_target
       FROM users u
       JOIN accounts a ON a.user_id = u.id
       JOIN hosts h ON h.id = a.host_id
       WHERE u.enabled = 1 AND h.enabled = 1 AND a.status = 'active'
       ORDER BY u.id ASC`,
    )
    .all() as SiteUserRow[];
}

export function toAdminRows(rows: AccountJoinRow[]): AdminUserRow[] {
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    enabled: r.enabled,
    created_at: r.created_at,
    account:
      r.host_id != null
        ? {
            hostId: r.host_id,
            hostName: r.host_name as string,
            hostRole: r.host_role as HostRole,
            status: r.account_status as AccountStatus,
            agentChannel: r.agent_channel,
            agentVersion: r.agent_version,
            venvKind: r.venv_kind,
          }
        : null,
  }));
}

export function countAdmins(db: Database.Database): number {
  return (
    (db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      .get() as { n: number }).n
  );
}

export function toPublic(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    created_at: user.created_at,
  };
}

export function createUser(
  db: Database.Database,
  username: string,
  passwordHash: string,
  role: Role,
): PublicUser {
  const info = db
    .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
    .run(username, passwordHash, role);
  return {
    id: Number(info.lastInsertRowid),
    username,
    role,
    created_at: new Date().toISOString(),
  };
}

export function setUserEnabled(
  db: Database.Database,
  id: number,
  enabled: boolean,
): boolean {
  const info = db
    .prepare("UPDATE users SET enabled = ? WHERE id = ?")
    .run(enabled ? 1 : 0, id);
  return info.changes > 0;
}

export function setUserRole(
  db: Database.Database,
  id: number,
  role: Role,
): boolean {
  const info = db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  return info.changes > 0;
}

export function updateUserPasswordHash(
  db: Database.Database,
  id: number,
  passwordHash: string,
): boolean {
  const info = db
    .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(passwordHash, id);
  return info.changes > 0;
}

export function insertSession(
  db: Database.Database,
  tokenHash: string,
  userId: number,
  expiresAt: number,
): void {
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(tokenHash, userId, Date.now(), expiresAt);
}

export function getSessionUser(
  db: Database.Database,
  tokenHash: string,
): { session: { token_hash: string; expires_at: number }; user: User } | undefined {
  const row = db
    .prepare(
      `SELECT s.token_hash AS token_hash, s.expires_at AS expires_at,
              u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as
    | { token_hash: string; expires_at: number; id: number; username: string; password_hash: string; role: Role; kind: "user" | "group"; owner_user_id: number | null; require_auth: number; require_auth_dev: number; enabled: number; created_at: string }
    | undefined;
  if (!row) return undefined;
  const { token_hash, expires_at, ...u } = row;
  return { session: { token_hash, expires_at }, user: u };
}

export function deleteSession(db: Database.Database, tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function touchSession(
  db: Database.Database,
  tokenHash: string,
  newExpiresAt: number,
): void {
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(
    newExpiresAt,
    tokenHash,
  );
}

export function deleteExpiredSessions(db: Database.Database, now = Date.now()): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
}

// Drop a user's sessions, optionally sparing the one making the change (so a
// password change logs out other devices but keeps the current browser in).
export function deleteSessionsForUser(
  db: Database.Database,
  userId: number,
  exceptTokenHash?: string,
): void {
  if (exceptTokenHash) {
    db.prepare(
      "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
    ).run(userId, exceptTokenHash);
  } else {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

export async function setAdminPassword(
  db: Database.Database,
  password: string,
): Promise<void> {
  const hash = await argon2.hash(password);
  db.prepare(
    `INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')
     ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`,
  ).run(ADMIN_USERNAME, hash);
}

export interface SeedResult {
  seeded: boolean;
  password?: string;
}

export async function ensureAdminSeed(db: Database.Database): Promise<SeedResult> {
  const existing = getAdminUser(db);
  if (existing) return { seeded: false };
  const password = generatePassword();
  await setAdminPassword(db, password);
  return { seeded: true, password };
}

// --- Hosts ---

const HOST_ROLE_ORDER = "CASE role WHEN 'user-server' THEN 0 WHEN 'gateway' THEN 1 ELSE 2 END";

export interface HostSeed {
  name: string;
  role: HostRole;
  ssh_target: string;
}

export function ensureHostSeed(
  db: Database.Database,
  seed: HostSeed[],
): void {
  const stmt = db.prepare(
    "INSERT INTO hosts (name, role, ssh_target) VALUES (@name, @role, @ssh_target) ON CONFLICT(name) DO NOTHING",
  );
  for (const h of seed) stmt.run(h);
}

export function listHosts(db: Database.Database, includeDisabled = false): Host[] {
  return db
    .prepare(
      `SELECT * FROM hosts ${includeDisabled ? "" : "WHERE enabled = 1"}
       ORDER BY ${HOST_ROLE_ORDER}, name ASC`,
    )
    .all() as Host[];
}

export function getHostById(db: Database.Database, id: number): Host | undefined {
  return db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as Host | undefined;
}

export function getHostByName(db: Database.Database, name: string): Host | undefined {
  return db.prepare("SELECT * FROM hosts WHERE name = ?").get(name) as Host | undefined;
}

// --- Accounts (login user <-> provisioned host account) ---

export function createAccount(
  db: Database.Database,
  userId: number,
  hostId: number,
): Account {
  const info = db
    .prepare("INSERT INTO accounts (user_id, host_id) VALUES (?, ?)")
    .run(userId, hostId);
  return {
    id: Number(info.lastInsertRowid),
    user_id: userId,
    host_id: hostId,
    status: "pending",
    last_job_id: null,
    bifrost_vk_id: null,
    hermes_model: null,
    agent_channel: null,
    agent_version: null,
    venv_kind: null,
  };
}

export function setAccountStatus(
  db: Database.Database,
  accountId: number,
  status: AccountStatus,
  lastJobId?: number | null,
): void {
  db.prepare("UPDATE accounts SET status = ?, last_job_id = ? WHERE id = ?").run(
    status,
    lastJobId ?? null,
    accountId,
  );
}

export function setAccountVkId(
  db: Database.Database,
  accountId: number,
  vkId: string | null,
): void {
  db.prepare("UPDATE accounts SET bifrost_vk_id = ? WHERE id = ?").run(vkId, accountId);
}

export function setAccountModel(
  db: Database.Database,
  accountId: number,
  model: string | null,
): void {
  db.prepare("UPDATE accounts SET hermes_model = ? WHERE id = ?").run(model, accountId);
}

// Fleet visibility, set from a converge's machine-readable markers. Only the
// provided fields are updated; omitted fields are left untouched.
export function setAccountAgentInfo(
  db: Database.Database,
  accountId: number,
  info: { channel?: string | null; version?: string | null; venvKind?: string | null },
): void {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (info.channel !== undefined) {
    sets.push("agent_channel = ?");
    vals.push(info.channel);
  }
  if (info.version !== undefined) {
    sets.push("agent_version = ?");
    vals.push(info.version);
  }
  if (info.venvKind !== undefined) {
    sets.push("venv_kind = ?");
    vals.push(info.venvKind);
  }
  if (sets.length === 0) return;
  vals.push(String(accountId));
  db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function getAccountByUserHost(
  db: Database.Database,
  userId: number,
  hostId: number,
): Account | undefined {
  return db
    .prepare("SELECT * FROM accounts WHERE user_id = ? AND host_id = ?")
    .get(userId, hostId) as Account | undefined;
}

// --- Static sites (owner-scoped: a user or a group) ---
//
// A static site is a label served as `<label>.<base>` from the owner's
// `~/www/<label>` by the nginx on the owner's host. The source/build project
// lives beside it in `~/sites/<label>`; both paths are derived by
// server/sites.ts `sitePaths()` and stored here so a future move stays a data
// change. Files are never touched by the app beyond ensuring the directories.

export type OwnerKind = "user" | "group";

export interface StaticSite {
  id: number;
  owner_kind: OwnerKind;
  owner_id: number;
  label: string;
  source_root: string;
  served_root: string;
  require_auth: number;
  created_at: string;
}

export function listStaticSites(db: Database.Database): StaticSite[] {
  return db
    .prepare("SELECT * FROM static_sites ORDER BY label ASC")
    .all() as StaticSite[];
}

export function listStaticSitesForOwner(
  db: Database.Database,
  ownerId: number,
): StaticSite[] {
  return db
    .prepare("SELECT * FROM static_sites WHERE owner_id = ? ORDER BY label ASC")
    .all(ownerId) as StaticSite[];
}

export function getStaticSiteByLabel(
  db: Database.Database,
  label: string,
): StaticSite | undefined {
  return db
    .prepare("SELECT * FROM static_sites WHERE label = ?")
    .get(label) as StaticSite | undefined;
}

export function getStaticSiteById(
  db: Database.Database,
  id: number,
): StaticSite | undefined {
  return db.prepare("SELECT * FROM static_sites WHERE id = ?").get(id) as
    | StaticSite
    | undefined;
}

export function countStaticSitesForOwner(
  db: Database.Database,
  ownerId: number,
): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM static_sites WHERE owner_id = ?")
      .get(ownerId) as { n: number }
  ).n;
}

export function createStaticSite(
  db: Database.Database,
  site: Omit<StaticSite, "id" | "created_at">,
): StaticSite {
  const info = db
    .prepare(
      `INSERT INTO static_sites
         (owner_kind, owner_id, label, source_root, served_root, require_auth)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      site.owner_kind,
      site.owner_id,
      site.label,
      site.source_root,
      site.served_root,
      site.require_auth,
    );
  return { id: Number(info.lastInsertRowid), created_at: new Date().toISOString(), ...site };
}

export function setStaticSiteRequireAuth(
  db: Database.Database,
  id: number,
  requireAuth: boolean,
): boolean {
  const info = db
    .prepare("UPDATE static_sites SET require_auth = ? WHERE id = ?")
    .run(requireAuth ? 1 : 0, id);
  return info.changes > 0;
}

// Removes the route only; the owner's files (`~/sites`, `~/www`) are retained.
export function deleteStaticSite(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM static_sites WHERE id = ?").run(id);
}

// Static sites whose owner is an enabled account on an enabled host: the set
// that gets a gateway route. `ssh_target` is the host the gateway forwards to
// (the owner's host, where the static nginx serves the docroot). An owner with
// accounts on several hosts yields one row per host; multi-host accounts are
// deferred (see notes/groups-and-apps.md §14).
export interface StaticSiteHostRow extends StaticSite {
  owner_name: string;
  owner_enabled: number;
  ssh_target: string;
}

export function listStaticSiteHosts(
  db: Database.Database,
): StaticSiteHostRow[] {
  return db
    .prepare(
      `SELECT s.*, u.username AS owner_name, u.enabled AS owner_enabled,
              h.ssh_target AS ssh_target
         FROM static_sites s
         JOIN users u ON u.id = s.owner_id
         JOIN accounts a ON a.user_id = u.id
         JOIN hosts h ON h.id = a.host_id
        WHERE u.enabled = 1 AND h.enabled = 1
        ORDER BY s.label ASC`,
    )
    .all() as StaticSiteHostRow[];
}

export function getAccountForUser(
  db: Database.Database,
  userId: number,
): (Account & { host: Host }) | undefined {
  const row = db
    .prepare(
      `SELECT a.*, h.id AS h_id, h.name AS h_name, h.role AS h_role,
              h.ssh_target AS h_ssh_target, h.enabled AS h_enabled
       FROM accounts a JOIN hosts h ON h.id = a.host_id
       WHERE a.user_id = ? ORDER BY a.id ASC LIMIT 1`,
    )
    .get(userId) as
    | (Account & {
        h_id: number;
        h_name: string;
        h_role: HostRole;
        h_ssh_target: string;
        h_enabled: number;
      })
    | undefined;
  if (!row) return undefined;
  const { h_id, h_name, h_role, h_ssh_target, h_enabled, ...account } = row;
  return {
    ...account,
    host: {
      id: h_id,
      name: h_name,
      role: h_role,
      ssh_target: h_ssh_target,
      enabled: h_enabled,
    },
  };
}

// --- Jobs / steps (audit trail for provisioning runs) ---

export function createJob(
  db: Database.Database,
  opts: {
    hostId: number | null;
    profile: string;
    createdBy: number | null;
  },
): JobRow {
  const info = db
    .prepare(
      "INSERT INTO jobs (host_id, profile, created_by, started_at) VALUES (?, ?, ?, ?)",
    )
    .run(opts.hostId, opts.profile, opts.createdBy, Date.now());
  return {
    id: Number(info.lastInsertRowid),
    host_id: opts.hostId,
    profile: opts.profile,
    created_by: opts.createdBy,
    status: "running",
    started_at: Date.now(),
    finished_at: null,
  };
}

export function finishJob(
  db: Database.Database,
  id: number,
  status: JobStatus,
): void {
  db.prepare("UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?").run(
    status,
    Date.now(),
    id,
  );
}

export function createJobStep(
  db: Database.Database,
  opts: {
    jobId: number;
    seq: number;
    script: string;
    targetHostId: number | null;
    targetSsh: string;
  },
): JobStepRow {
  const info = db
    .prepare(
      `INSERT INTO job_steps (job_id, seq, script, target_host_id, target_ssh, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.jobId, opts.seq, opts.script, opts.targetHostId, opts.targetSsh, Date.now());
  return {
    id: Number(info.lastInsertRowid),
    job_id: opts.jobId,
    seq: opts.seq,
    script: opts.script,
    target_host_id: opts.targetHostId,
    target_ssh: opts.targetSsh,
    status: "running",
    exit_code: null,
    output_log: "",
    started_at: Date.now(),
    finished_at: null,
  };
}

export function finishJobStep(
  db: Database.Database,
  id: number,
  status: JobStatus,
  exitCode: number,
  outputLog: string,
): void {
  db.prepare(
    "UPDATE job_steps SET status = ?, exit_code = ?, output_log = ?, finished_at = ? WHERE id = ?",
  ).run(status, exitCode, outputLog, Date.now(), id);
}

export function getJob(db: Database.Database, id: number): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function getJobSteps(
  db: Database.Database,
  jobId: number,
): JobStepRow[] {
  return db
    .prepare("SELECT * FROM job_steps WHERE job_id = ? ORDER BY seq ASC")
    .all(jobId) as JobStepRow[];
}

export function listJobsForUser(
  db: Database.Database,
  userId: number,
  limit = 20,
): (JobRow & { host_name: string | null })[] {
  return db
    .prepare(
      `SELECT j.*, h.name AS host_name
       FROM jobs j LEFT JOIN hosts h ON h.id = j.host_id
       WHERE j.created_by = ? OR EXISTS (
         SELECT 1 FROM accounts a WHERE a.user_id = ? AND a.last_job_id = j.id
       )
       ORDER BY j.id DESC LIMIT ?`,
    )
    .all(userId, userId, limit) as (JobRow & { host_name: string | null })[];
}
