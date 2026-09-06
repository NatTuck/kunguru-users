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
  created_at: string;
}

export interface PublicUser {
  id: number;
  username: string;
  role: Role;
  created_at: string;
}

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

export function openDb(): Database.Database {
  mkdirSync(DATA_DIR, { recursive: true });
  fixPermissions();

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  fixPermissions();
  return db;
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

export function deleteUser(db: Database.Database, id: number): boolean {
  const info = db.prepare("DELETE FROM users WHERE id = ?").run(id);
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
    | { token_hash: string; expires_at: number; id: number; username: string; password_hash: string; role: Role; created_at: string }
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
