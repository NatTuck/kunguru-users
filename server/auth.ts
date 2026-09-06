import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import argon2 from "argon2";
import {
  deleteSession,
  deleteExpiredSessions,
  getDb,
  getSessionUser,
  getUserByUsername,
  insertSession,
  toPublic,
  touchSession,
  type PublicUser,
} from "./db";

export const SESSION_COOKIE = "kunguru_sid";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sha256 = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

const newToken = (): string => randomBytes(32).toString("base64url");

export const hashPassword = (pw: string) => argon2.hash(pw);
export const verifyPassword = (hash: string, pw: string) =>
  argon2.verify(hash, pw).catch(() => false);

export interface SessionContext {
  user: PublicUser;
  tokenHash: string;
}

function readToken(req: Request): string | undefined {
  const raw = (req.cookies as Record<string, unknown> | undefined)?.[
    SESSION_COOKIE
  ];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function setSessionCookie(res: Response, token: string): void {
  const secure = process.env.NODE_ENV === "production";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
  });
}

export function resolveSession(req: Request): SessionContext | null {
  const db = getDb();
  deleteExpiredSessions(db);
  const token = readToken(req);
  if (!token) return null;
  const tokenHash = sha256(token);
  const found = getSessionUser(db, tokenHash);
  if (!found || found.session.expires_at <= Date.now()) {
    if (found) deleteSession(db, tokenHash);
    return null;
  }
  touchSession(db, tokenHash, Date.now() + SESSION_TTL_MS);
  return { user: toPublic(found.user), tokenHash };
}

function currentUser(res: Response): SessionContext | undefined {
  return (res.locals.session as SessionContext | undefined) ?? undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const ctx = resolveSession(req);
  if (!ctx) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.locals.session = ctx;
  next();
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction): void {
  const ctx = currentUser(res);
  if (!ctx || ctx.user.role !== "admin") {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

export async function loginHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { username, password } = (req.body ?? {}) as {
    username?: unknown;
    password?: unknown;
  };
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password required" });
    return;
  }

  const lockRemaining = loginLockedMs(username);
  if (lockRemaining > 0) {
    res.status(429).json({
      error: "too many failed attempts",
      retryAfterSec: Math.ceil(lockRemaining / 1000),
    });
    return;
  }

  const db = getDb();
  const user = getUserByUsername(db, username);
  const ok = user ? await verifyPassword(user.password_hash, password) : false;
  if (!ok || !user) {
    noteLoginFailure(username);
    // Generic message; do not reveal whether the user exists.
    res.status(401).json({ error: "invalid username or password" });
    return;
  }

  clearLoginFailures(username);
  const token = newToken();
  const tokenHash = sha256(token);
  insertSession(db, tokenHash, user.id, Date.now() + SESSION_TTL_MS);
  setSessionCookie(res, token);
  res.json({ user: toPublic(user) });
}

export function logoutHandler(req: Request, res: Response): void {
  const ctx = resolveSession(req);
  if (ctx) deleteSession(getDb(), ctx.tokenHash);
  clearSessionCookie(res);
  res.json({ ok: true });
}

export function meHandler(_req: Request, res: Response): void {
  const ctx = currentUser(res);
  res.json({ user: ctx?.user ?? null });
}

// --- Login throttle (in-memory, per username) ---

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 60 * 1000;

const failures = new Map<
  string,
  { count: number; windowStart: number; lockedUntil: number }
>();

function loginLockedMs(username: string): number {
  const rec = failures.get(username);
  if (!rec) return 0;
  const now = Date.now();
  if (now >= rec.lockedUntil) {
    if (now - rec.windowStart > WINDOW_MS) failures.delete(username);
    return 0;
  }
  return rec.lockedUntil - now;
}

function noteLoginFailure(username: string): void {
  const now = Date.now();
  const rec = failures.get(username);
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    failures.set(username, { count: 1, windowStart: now, lockedUntil: 0 });
    return;
  }
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) rec.lockedUntil = now + LOCK_MS;
}

function clearLoginFailures(username: string): void {
  failures.delete(username);
}
