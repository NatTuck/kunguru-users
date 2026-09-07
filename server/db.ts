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
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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
  fixPermissions();
  return db;
}

// Additive migrations for databases created before a column existed.
function migrate(db: Database.Database): void {
  const ucols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!ucols.some((c) => c.name === "enabled")) {
    db.exec("ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  }
  const acols = db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[];
  if (!acols.some((c) => c.name === "bifrost_vk_id")) {
    db.exec("ALTER TABLE accounts ADD COLUMN bifrost_vk_id TEXT");
  }
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
  } | null;
}

export interface AccountJoinRow extends PublicUser {
  enabled: number;
  host_id: number | null;
  host_name: string | null;
  host_role: HostRole | null;
  account_status: AccountStatus | null;
}

export function listUsersWithAccounts(db: Database.Database): AccountJoinRow[] {
  return db
    .prepare(
      `SELECT u.id, u.username, u.role, u.enabled, u.created_at,
              a.host_id, h.name AS host_name, h.role AS host_role, a.status AS account_status
       FROM users u
       LEFT JOIN accounts a ON a.user_id = u.id
       LEFT JOIN hosts h ON h.id = a.host_id
       ORDER BY u.id ASC`,
    )
    .all() as AccountJoinRow[];
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
    | { token_hash: string; expires_at: number; id: number; username: string; password_hash: string; role: Role; enabled: number; created_at: string }
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

export function getAccountByUserHost(
  db: Database.Database,
  userId: number,
  hostId: number,
): Account | undefined {
  return db
    .prepare("SELECT * FROM accounts WHERE user_id = ? AND host_id = ?")
    .get(userId, hostId) as Account | undefined;
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
