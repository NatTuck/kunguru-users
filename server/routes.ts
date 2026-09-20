import { Router } from "express";
import {
  countAdmins,
  createAlias,
  createUser,
  deleteAlias,
  deleteSessionsForUser,
  generatePassword,
  getAccountForUser,
  getAliasByLabel,
  getDb,
  getHostById,
  getJob,
  getJobSteps,
  getUserById,
  getUserByUsername,
  listAliasesForUser,
  listHosts,
  listJobsForUser,
  listUsersWithAccounts,
  setUserEnabled,
  setUserRole,
  toAdminRows,
  updateUserPasswordHash,
  type AliasAccess,
  type AliasKind,
  type AliasService,
  type Role,
} from "./db";
import {
  hashPassword,
  loginHandler,
  logoutHandler,
  meHandler,
  requireAdmin,
  requireAuth,
  verifyPassword,
} from "./auth";
import {
  deactivateUserAccess,
  provisionStandardAccount,
  syncSnikketPassword,
  type ProvisionResult,
} from "./provision";
import { isProvisionableAliasLabel, isProvisionableUsername } from "./sites";
import { reconcileUserSites } from "./nginx";
import { BASE_DOMAIN, PRIVATE_DOMAIN } from "./inventory";
import { XMPP_DOMAIN } from "./bifrost";

export const api = Router();

// Per-user site routes (Hermes WebUI / private app / public site) are derived
// from DB state, so reconcile them after any change to the user set. Failures
// are surfaced, never fatal to the user operation itself.
async function reconcileSitesSafe(): Promise<{ ok: boolean; output: string }> {
  try {
    const r = await reconcileUserSites();
    return { ok: r.ok, output: r.output };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

const ROLES: Role[] = ["admin", "user"];

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as string[]).includes(value);
}

// Usernames are Linux accounts, Snikket JIDs, and DNS labels for the per-user
// site hostnames (see server/sites.ts).
function isValidUsername(value: unknown): value is string {
  return isProvisionableUsername(value);
}

function parseId(raw: unknown): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== "string") return null;
  const id = Number(s);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

function toProvisionView(r: ProvisionResult): {
  ok: boolean;
  jobId: number;
  status: string;
  failedStep?: string;
} {
  return { ok: r.status === "succeeded", jobId: r.jobId, status: r.status, failedStep: r.failedStep };
}

function currentUserId(res: {
  locals: { session?: { user: { id: number } } };
}): number | undefined {
  return res.locals.session?.user.id;
}

// --- Auth ---

api.post("/auth/login", loginHandler);
api.post("/auth/logout", logoutHandler);
api.get("/auth/me", requireAuth, meHandler);

// --- Self-service password change ---
// Rotates the signed-in user's shared web/XMPP password. The Snikket credential
// is pushed FIRST; if that job fails the web password is left untouched, so the
// two never drift. Other sessions are dropped (the current browser is kept).

const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

function passwordPolicyError(password: string, username: string): string | null {
  if (password.length < PASSWORD_MIN) {
    return `password must be at least ${PASSWORD_MIN} characters`;
  }
  if (password.length > PASSWORD_MAX) {
    return `password must be at most ${PASSWORD_MAX} characters`;
  }
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return "password must not contain your username";
  }
  return null;
}

// Small per-user throttle for wrong current-password attempts (independent of
// the login lockout in auth.ts).
function makeThrottle(maxFailures: number, windowMs: number, lockMs: number) {
  const recs = new Map<
    number,
    { count: number; windowStart: number; lockedUntil: number }
  >();
  return {
    lockedMs(key: number): number {
      const rec = recs.get(key);
      if (!rec) return 0;
      const now = Date.now();
      if (now >= rec.lockedUntil) {
        if (now - rec.windowStart > windowMs) recs.delete(key);
        return 0;
      }
      return rec.lockedUntil - now;
    },
    noteFailure(key: number): void {
      const now = Date.now();
      const rec = recs.get(key);
      if (!rec || now - rec.windowStart > windowMs) {
        recs.set(key, { count: 1, windowStart: now, lockedUntil: 0 });
        return;
      }
      rec.count += 1;
      if (rec.count >= maxFailures) rec.lockedUntil = now + lockMs;
    },
    clear(key: number): void {
      recs.delete(key);
    },
  };
}

const pwThrottle = makeThrottle(5, 15 * 60 * 1000, 60 * 1000);

api.post("/auth/password", requireAuth, async (req, res) => {
  const session = res.locals.session as
    | { user: { id: number; username: string }; tokenHash: string }
    | undefined;
  if (!session) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { id: userId, username } = session.user;

  const lockRemaining = pwThrottle.lockedMs(userId);
  if (lockRemaining > 0) {
    res.status(429).json({
      error: "too many failed attempts",
      retryAfterSec: Math.ceil(lockRemaining / 1000),
    });
    return;
  }

  const { currentPassword, newPassword } = (req.body ?? {}) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    res.status(400).json({ error: "currentPassword and newPassword are required" });
    return;
  }

  const db = getDb();
  const user = getUserById(db, userId);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const ok = await verifyPassword(user.password_hash, currentPassword);
  if (!ok) {
    pwThrottle.noteFailure(userId);
    res.status(400).json({ error: "current password is incorrect" });
    return;
  }
  if (newPassword === currentPassword) {
    res.status(400).json({ error: "new password must be different from the current one" });
    return;
  }
  const policyError = passwordPolicyError(newPassword, username);
  if (policyError) {
    res.status(400).json({ error: policyError });
    return;
  }

  // Push to Snikket first (when the user has an XMPP account) so the web and
  // XMPP passwords never drift; abort the change if the sync fails.
  let provisioning: unknown = null;
  if (getAccountForUser(db, userId)) {
    try {
      const result = await syncSnikketPassword({
        user: { id: userId, username },
        password: newPassword,
        createdBy: userId,
      });
      if (result.status !== "succeeded") {
        res.status(502).json({
          error: "could not update your XMPP password; your password was not changed",
          failedStep: result.failedStep,
          jobId: result.jobId,
        });
        return;
      }
      provisioning = toProvisionView(result);
    } catch (err) {
      res.status(502).json({
        error: "could not update your XMPP password; your password was not changed",
        message: err instanceof Error ? err.message : "snikket sync failed",
      });
      return;
    }
  }

  updateUserPasswordHash(db, userId, await hashPassword(newPassword));
  deleteSessionsForUser(db, userId, session.tokenHash);
  pwThrottle.clear(userId);
  res.json({ ok: true, provisioning });
});

// --- Public config ---
// Domain names the SPA needs to build per-user tool URLs (the agent WebUI host
// `<user>-agent.users.<base>` and the XMPP domain). Public: these are DNS names.
api.get("/config", (_req, res) => {
  res.json({
    baseDomain: BASE_DOMAIN,
    privateDomain: PRIVATE_DOMAIN,
    xmppDomain: XMPP_DOMAIN,
  });
});

// --- Hosts (admin) ---

api.get("/hosts", requireAuth, requireAdmin, (_req, res) => {
  const hosts = listHosts(getDb()).map((h) => ({
    id: h.id,
    name: h.name,
    role: h.role,
  }));
  res.json({ hosts });
});

// --- Admin-only user management ---

api.get("/users", requireAuth, requireAdmin, (_req, res) => {
  const rows = listUsersWithAccounts(getDb());
  res.json({ users: toAdminRows(rows) });
});

api.post("/users", requireAuth, requireAdmin, async (req, res) => {
  const { username, role, hostId } = (req.body ?? {}) as {
    username?: unknown;
    role?: unknown;
    hostId?: unknown;
  };
  if (!isValidUsername(username)) {
    res.status(400).json({
      error:
        "invalid username: lowercase letters/digits/hyphens, starting with a letter, not ending in '-agent', max 32 (must be a DNS label)",
    });
    return;
  }
  const targetRole: Role = isRole(role) ? role : "user";
  const targetHostId = hostId == null ? null : Number(hostId);
  if (targetHostId != null && !Number.isInteger(targetHostId)) {
    res.status(400).json({ error: "invalid hostId" });
    return;
  }

  const db = getDb();
  const password = generatePassword();
  const hash = await hashPassword(password);

  let user;
  try {
    user = createUser(db, username, hash, targetRole);
  } catch (err) {
    if (
      err instanceof Error &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      res.status(409).json({ error: "username already exists" });
      return;
    }
    throw err;
  }

  if (targetHostId != null) {
    const host = getHostById(db, targetHostId);
    if (!host || !host.enabled) {
      // User is created; without a usable host we cannot provision it yet.
      res.status(201).json({
        user,
        password,
        provisioning: {
          ok: false,
          jobId: null,
          message: "target host not found or disabled; use 'Provision' once a host is available",
        },
      });
      return;
    }
    try {
      const result = await provisionStandardAccount({
        user: { id: user.id, username: user.username },
        hostId: targetHostId,
        password,
        createdBy: currentUserId(res) ?? null,
      });
      const sites = await reconcileSitesSafe();
      res.status(201).json({
        user,
        password,
        provisioning: toProvisionView(result),
        sites,
      });
      return;
    } catch (err) {
      res.status(201).json({
        user,
        password,
        provisioning: {
          ok: false,
          jobId: null,
          message: err instanceof Error ? err.message : "provisioning failed",
        },
      });
      return;
    }
  }

  res.status(201).json({ user, password, provisioning: null });
});

api.patch("/users/:id/role", requireAuth, requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  const { role } = (req.body ?? {}) as { role?: unknown };
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  if (!isRole(role)) {
    res.status(400).json({ error: "invalid role" });
    return;
  }
  const db = getDb();
  const target = getUserById(db, id);
  if (!target) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  if (!target.enabled) {
    res.status(400).json({ error: "user is disabled; enable it first" });
    return;
  }
  if (id === currentUserId(res)) {
    res.status(400).json({ error: "you cannot change your own role" });
    return;
  }
  if (target.role === "admin" && role === "user" && countAdmins(db) <= 1) {
    res.status(400).json({ error: "cannot demote the last admin" });
    return;
  }
  setUserRole(db, id, role);
  res.json({ ok: true });
});

// Disable a user: blocks app login and Snikket login by randomizing the XMPP
// credential (the account is kept, never removed; Linux accounts have no
// password to disable). Re-enabling issues a fresh shared password.
api.post("/users/:id/disable", requireAuth, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const db = getDb();
  const target = getUserById(db, id);
  if (!target) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  if (id === currentUserId(res)) {
    res.status(400).json({ error: "you cannot disable your own account" });
    return;
  }
  if (target.role === "admin" && countAdmins(db) <= 1) {
    res.status(400).json({ error: "cannot disable the last admin" });
    return;
  }
  if (!target.enabled) {
    res.status(400).json({ error: "user is already disabled" });
    return;
  }

  setUserEnabled(db, id, false);

  // Keep the Snikket account (identity/affiliation) but neutralize it by
  // randomizing its password, and cut the user's Hermes agent off: deactivate
  // its Bifrost key and stop its gateway. The random value is never shown or
  // stored.
  let provisioning: unknown = null;
  const account = getAccountForUser(db, id);
  if (account) {
    try {
      const result = await syncSnikketPassword({
        user: { id: target.id, username: target.username },
        password: generatePassword(),
        createdBy: currentUserId(res) ?? null,
      });
      provisioning = toProvisionView(result);
    } catch (err) {
      provisioning = {
        ok: false,
        message: err instanceof Error ? err.message : "failed to randomize snikket password",
      };
    }
    try {
      await deactivateUserAccess({
        user: { id: target.id, username: target.username },
        createdBy: currentUserId(res) ?? null,
      });
    } catch (err) {
      provisioning = {
        ok: false,
        message: err instanceof Error ? err.message : "failed to stop hermes / deactivate llm key",
      };
    }
  }

  const sites = await reconcileSitesSafe();

  res.json({
    user: { id: target.id, username: target.username, role: target.role, enabled: 0 },
    provisioning,
    sites,
  });
});

// Re-enable a user: issues a new shared password and re-applies it to Snikket
// (Linux account is untouched). The new password is shown exactly once.
api.post("/users/:id/enable", requireAuth, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const db = getDb();
  const target = getUserById(db, id);
  if (!target) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  if (target.enabled) {
    res.status(400).json({ error: "user is already enabled" });
    return;
  }

  const password = generatePassword();
  updateUserPasswordHash(db, id, await hashPassword(password));
  setUserEnabled(db, id, true);

  let provisioning: unknown = null;
  const account = getAccountForUser(db, id);
  if (account) {
    try {
      const result = await provisionStandardAccount({
        user: { id: target.id, username: target.username },
        hostId: account.host_id,
        password,
        createdBy: currentUserId(res) ?? null,
      });
      provisioning = toProvisionView(result);
    } catch (err) {
      provisioning = {
        ok: false,
        message: err instanceof Error ? err.message : "snikket password sync failed",
      };
    }
  }

  const sites = await reconcileSitesSafe();

  res.json({
    user: { id: target.id, username: target.username, role: target.role, enabled: 1 },
    password,
    provisioning,
    sites,
  });
});

// Provision a user (or re-provision an existing account) on a host. Because the
// prior plaintext is gone, this rotates the password (shared web+XMPP value).
api.post("/users/:id/provision", requireAuth, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const { hostId } = (req.body ?? {}) as { hostId?: unknown };
  const db = getDb();
  const target = getUserById(db, id);
  if (!target) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  if (!target.enabled) {
    res.status(400).json({ error: "user is disabled; enable it first" });
    return;
  }

  let targetHostId = hostId == null ? null : Number(hostId);
  if (targetHostId == null) {
    const existing = getAccountForUser(db, id);
    targetHostId = existing ? existing.host_id : null;
  }
  if (targetHostId == null || !getHostById(db, targetHostId)) {
    res.status(400).json({ error: "no target host (pass hostId or provision the user first)" });
    return;
  }

  const password = generatePassword();
  await updateUserPasswordHash(db, id, await hashPassword(password));
  try {
    const result = await provisionStandardAccount({
      user: { id: target.id, username: target.username },
      hostId: targetHostId,
      password,
      createdBy: currentUserId(res) ?? null,
    });
    const sites = await reconcileSitesSafe();
    res.json({
      user: { id: target.id, username: target.username },
      password,
      provisioning: toProvisionView(result),
      sites,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "provisioning failed",
      password,
    });
  }
});

// Reset password: rotates the shared web/XMPP password and re-syncs Snikket
// (the tenant's chat identity). The Hermes agent has its own Snikket account
// and Bifrost key, so it is untouched by a password reset.
api.post("/users/:id/reset-password", requireAuth, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const db = getDb();
  const target = getUserById(db, id);
  if (!target) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  if (!target.enabled) {
    res.status(400).json({ error: "user is disabled; enable it first" });
    return;
  }
  const password = generatePassword();
  const hash = await hashPassword(password);
  updateUserPasswordHash(db, id, hash);

  let provisioning: unknown = null;
  const account = getAccountForUser(db, id);
  if (account) {
    try {
      const result = await syncSnikketPassword({
        user: { id: target.id, username: target.username },
        password,
        createdBy: currentUserId(res) ?? null,
      });
      provisioning = toProvisionView(result);
    } catch (err) {
      provisioning = {
        ok: false,
        message: err instanceof Error ? err.message : "snikket password sync failed",
      };
    }
  }

  res.json({
    user: { id: target.id, username: target.username, role: target.role },
    password,
    provisioning,
  });
});

// --- Job audit trail (admin) ---

api.get("/users/:id/jobs", requireAuth, requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  res.json({ jobs: listJobsForUser(getDb(), id) });
});

api.get("/jobs/:id", requireAuth, requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const db = getDb();
  const job = getJob(db, id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json({ job, steps: getJobSteps(db, id) });
});

// --- Per-user site aliases (admin) ---

const ALIAS_KINDS: AliasKind[] = ["proxy", "static"];
const ALIAS_ACCESS: AliasAccess[] = ["public", "private"];
const ALIAS_SERVICES: AliasService[] = [
  "private-app",
  "public-site",
  "hermes-webui",
];

function isAliasKind(v: unknown): v is AliasKind {
  return typeof v === "string" && (ALIAS_KINDS as string[]).includes(v);
}
function isAliasAccess(v: unknown): v is AliasAccess {
  return typeof v === "string" && (ALIAS_ACCESS as string[]).includes(v);
}
function isAliasService(v: unknown): v is AliasService {
  return typeof v === "string" && (ALIAS_SERVICES as string[]).includes(v);
}

api.get("/users/:id/aliases", requireAuth, requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  res.json({ aliases: listAliasesForUser(getDb(), id) });
});

api.post("/users/:id/aliases", requireAuth, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const { label, kind, service, root, access } = (req.body ?? {}) as {
    label?: unknown;
    kind?: unknown;
    service?: unknown;
    root?: unknown;
    access?: unknown;
  };
  if (!isProvisionableAliasLabel(label)) {
    res.status(400).json({
      error:
        "invalid label: lowercase letters/digits/hyphens, starting with a letter, not '-agent', not reserved",
    });
    return;
  }
  const db = getDb();
  if (!getUserById(db, id)) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  // A label must not shadow an existing username or another alias.
  if (getUserByUsername(db, label)) {
    res.status(409).json({ error: "label collides with a username" });
    return;
  }
  if (getAliasByLabel(db, label)) {
    res.status(409).json({ error: "alias label already exists" });
    return;
  }
  const aliasKind: AliasKind = isAliasKind(kind) ? kind : "proxy";
  const aliasAccess: AliasAccess = isAliasAccess(access) ? access : "public";
  let aliasService: AliasService | null = null;
  let aliasRoot: string | null = null;
  if (aliasKind === "proxy") {
    if (!isAliasService(service)) {
      res.status(400).json({ error: "proxy alias needs a valid service" });
      return;
    }
    aliasService = service;
  } else {
    if (typeof root !== "string" || !root.startsWith("/") || root.length > 512) {
      res.status(400).json({ error: "static alias needs an absolute root path" });
      return;
    }
    aliasRoot = root;
  }
  let alias;
  try {
    alias = createAlias(db, {
      user_id: id,
      label,
      kind: aliasKind,
      service: aliasService,
      root: aliasRoot,
      access: aliasAccess,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      res.status(409).json({ error: "alias label already exists" });
      return;
    }
    throw err;
  }
  const sites = await reconcileSitesSafe();
  res.status(201).json({ alias, sites });
});

api.delete("/aliases/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  deleteAlias(getDb(), id);
  const sites = await reconcileSitesSafe();
  res.json({ ok: true, sites });
});
