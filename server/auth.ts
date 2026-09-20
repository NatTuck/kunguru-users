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
import { COOKIE_DOMAIN, PRIVATE_DOMAIN } from "./inventory";

export const SESSION_COOKIE = "kunguru_sid";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Extend the sliding expiry at most this often. The nginx `auth_request`
// endpoint is hit for every WebUI request (assets, API, SSE), so writing
// `sessions.expires_at` on each call would hammer sqlite; a session only needs
// to be extended well within its TTL, not on every request.
export const SESSION_TOUCH_THROTTLE_MS = 60 * 60 * 1000;

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
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  });
}

export interface ResolveSessionOptions {
  // Run the global expired-session sweep. Skip on hot paths (the auth
  // subrequest) — the per-session expiry check below is sufficient.
  sweep?: boolean;
  // Extend the sliding expiry (throttled to SESSION_TOUCH_THROTTLE_MS).
  touch?: boolean;
}

export function resolveSession(
  req: Request,
  opts: ResolveSessionOptions = {},
): SessionContext | null {
  const sweep = opts.sweep ?? true;
  const touch = opts.touch ?? true;
  const db = getDb();
  if (sweep) deleteExpiredSessions(db);
  const token = readToken(req);
  if (!token) return null;
  const tokenHash = sha256(token);
  const found = getSessionUser(db, tokenHash);
  if (
    !found ||
    found.session.expires_at <= Date.now() ||
    !found.user.enabled
  ) {
    if (found) deleteSession(db, tokenHash);
    return null;
  }
  if (
    touch &&
    found.session.expires_at - Date.now() <
      SESSION_TTL_MS - SESSION_TOUCH_THROTTLE_MS
  ) {
    touchSession(db, tokenHash, Date.now() + SESSION_TTL_MS);
  }
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
  const { username, password, next } = (req.body ?? {}) as {
    username?: unknown;
    password?: unknown;
    next?: unknown;
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
  if (!ok || !user || !user.enabled) {
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
  res.json({ user: toPublic(user), redirectTo: sanitizeNext(next, PRIVATE_DOMAIN) });
}

/**
 * Validate a post-login `next` target. Allows same-origin absolute paths and
 * cross-origin URLs only on a single-label host under the private subtree
 * (`<user>.users.<base>` / `<user>-agent.users.<base>`). Returns null when
 * unsafe.
 */
export function sanitizeNext(raw: unknown, privateDomain: string): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  // Same-origin absolute path: exactly one leading slash, no scheme-relative
  // (`//host`) or backslash trickery.
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) {
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const domain = privateDomain.trim().toLowerCase();
  if (!domain) return null;
  const suffix = "." + domain;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  return url.toString();
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
