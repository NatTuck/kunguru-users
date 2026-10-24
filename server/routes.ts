import { Router, type Response } from "express";
import {
  addGroupMember,
  countAdmins,
  countOwnedGroups,
  countStaticSitesForOwner,
  createGroup,
  createStaticSite,
  createUser,
  deleteSessionsForUser,
  deleteStaticSite,
  generatePassword,
  getAccountForUser,
  getDb,
  getGroupById,
  getHostById,
  getJob,
  getJobSteps,
  getStaticSiteById,
  getStaticSiteByLabel,
  getUserById,
  isGroupMember,
  getUserByUsername,
  listAllGroups,
  listGroupMembers,
  listGroupsForUser,
  listHosts,
  listJobsForUser,
  listStaticSitesForOwner,
  listUsersWithAccounts,
  removeGroupMember,
  setGroupOwner,
  setStaticSiteRequireAuth,
  setUserEnabled,
  setUserRole,
  toAdminRows,
  updateUserPasswordHash,
  type GroupRow,
  type Host,
  type Role,
  type StaticSite,
  type User,
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
  ensureGroupMembership,
  getFleetUpdateState,
  sendAgentXmppMessage,
  startAgentUpdate,
  startFleetAgentUpdate,
  startStandardAccountProvision,
  provisionGroup,
  sendGroupAgentMessage,
  startGroupAgent,
  syncSnikketPassword,
  applyUserModel,
  type GroupProvisionResult,
  type ProvisionResult,
} from "./provision";
import {
  LABEL_RULE,
  isProvisionableSiteLabel,
  isProvisionableUsername,
  sitePaths,
  staticSiteHost,
} from "./sites";
import {
  APP_SLOTS,
  controlApp,
  getAppLogs,
  getAppStatus,
  type AppAction,
  type AppSlot,
} from "./apps";
import { getIdentitySigner } from "./identity";
import { reconcileSites } from "./nginx";
import { refreshModelsAndRestartWebuis } from "./models";
import { BASE_DOMAIN } from "./inventory";
import {
  BIFROST_PROVIDERS,
  HERMES_MODEL,
  listCatalogModels,
  XMPP_DOMAIN,
} from "./bifrost";

export const api = Router();

// Account app routes and static-site routes are derived from DB state, so
// reconcile them after any change to the account or site set. Failures are
// surfaced, never fatal to the operation itself.
async function reconcileSitesSafe(): Promise<{ ok: boolean; output: string }> {
  try {
    const r = await reconcileSites();
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

// Group rows are accounts, but their lifecycle (provisioning, membership,
// disabling) is the groups API. The user-admin routes operate on people.
function rejectGroup(
  target: { kind: "user" | "group" },
  res: Response,
  action: string,
): boolean {
  if (target.kind !== "group") return false;
  res.status(400).json({
    error: `this account is a group; use the groups API to ${action} it`,
  });
  return true;
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

// --- Default model (Bifrost catalog) ---
// A tenant's Hermes default model is a Bifrost `<provider>/<name>` id. The
// catalog is read server-side with the gateway's admin credentials; tenants
// only see models from the providers their per-user key is scoped to.

interface ModelView {
  current: string | null;
  default: string;
  models: { id: string; name: string; provider: string }[];
}

// Hermes model ids are `provider/name` (e.g. `kimi/k3`), while the Bifrost
// catalog reports those two fields separately. Map to the id agents actually
// use, and keep only providers the per-user key is scoped to.
function allowedModels(
  catalog: { name: string; provider: string }[],
): { id: string; name: string; provider: string }[] {
  return catalog
    .filter((m) => BIFROST_PROVIDERS.includes(m.provider))
    .map((m) => ({ id: `${m.provider}/${m.name}`, name: m.name, provider: m.provider }));
}

// A provider-independent default is a bare Bifrost routing alias (e.g.
// `default-model`) resolved by the gateway at request time; it is deliberately
// NOT part of any provider's catalog, so surface it explicitly for the pickers.
function withDefault(
  models: { id: string; name: string; provider: string }[],
  fallback: string,
): { id: string; name: string; provider: string }[] {
  if (!fallback || models.some((m) => m.id === fallback)) return models;
  return [{ id: fallback, name: fallback, provider: "" }, ...models];
}

async function modelViewFor(
  db: ReturnType<typeof getDb>,
  userId: number,
): Promise<ModelView> {
  const account = getAccountForUser(db, userId);
  const catalog = await listCatalogModels();
  return {
    current: account?.hermes_model ?? null,
    default: HERMES_MODEL,
    models: withDefault(allowedModels(catalog), HERMES_MODEL),
  };
}

// Validates the picked model against the live gateway catalog, then applies it
// (rewrites the tenant's model.default and restarts the agent gateway + WebUI).
async function setModelFor(
  res: Response,
  target: { id: number; username: string },
  model: unknown,
  createdBy: number | null,
): Promise<void> {
  if (typeof model !== "string" || !model.trim()) {
    res.status(400).json({ error: "model is required" });
    return;
  }
  const picked = model.trim();
  let catalog;
  try {
    catalog = await listCatalogModels();
  } catch (err) {
    res.status(502).json({
      error: "could not read the gateway model catalog",
      message: err instanceof Error ? err.message : undefined,
    });
    return;
  }
  // The instance default may be a provider-independent routing alias that is
  // absent from the catalog; accept it without a catalog/provider check.
  if (picked !== HERMES_MODEL) {
    if (!catalog.some((m) => `${m.provider}/${m.name}` === picked)) {
      res.status(400).json({ error: "unknown model" });
      return;
    }
    if (!allowedModels(catalog).some((m) => m.id === picked)) {
      res.status(400).json({ error: "model is not available for this account" });
      return;
    }
  }
  try {
    const result = await applyUserModel({ user: target, model: picked, createdBy });
    const ok = result.status === "succeeded";
    res.status(ok ? 200 : 502).json({
      ok,
      jobId: result.jobId,
      status: result.status,
      failedStep: result.failedStep,
      current: ok ? picked : undefined,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "failed to set model",
    });
  }
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
// Domain names the SPA needs to build per-account tool URLs (`<account>.<base>`
// app, `<account>-dev.<base>` app-dev, `<account>-agent.<base>` WebUI, and
// `<label>.<base>` static sites) and the XMPP domain. Public: these are DNS
// names. The login app's own host is server-side only.
api.get("/config", (_req, res) => {
  res.json({
    baseDomain: BASE_DOMAIN,
    xmppDomain: XMPP_DOMAIN,
  });
});

// --- Identity signing key (public) ---
// The public half of the key that signs X-Kunguru-Identity tokens. Apps pin
// this (or read it at deploy time) to verify identity without trusting a peer
// address. Public by design: a verification key, not a secret.
api.get("/identity-key", (_req, res) => {
  const signer = getIdentitySigner();
  res.json({
    kid: signer.kid,
    publicKeyPem: signer.publicKeyPem,
    publicKeyDer: signer.publicKeyDer,
  });
});

// --- My default model (self) ---
// The signed-in user's Hermes default model plus the gateway catalog to choose
// from. Applying restarts their agent gateway + WebUI.
api.get("/me/model", requireAuth, async (_req, res) => {
  const userId = currentUserId(res);
  if (userId == null) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    res.json(await modelViewFor(getDb(), userId));
  } catch (err) {
    res.status(502).json({
      error: "could not read the gateway model catalog",
      message: err instanceof Error ? err.message : undefined,
    });
  }
});

api.post("/me/model", requireAuth, async (req, res) => {
  const userId = currentUserId(res);
  if (userId == null) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const db = getDb();
  const user = getUserById(db, userId);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { model } = (req.body ?? {}) as { model?: unknown };
  await setModelFor(res, { id: user.id, username: user.username }, model, userId);
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
    res.status(400).json({ error: `invalid username: ${LABEL_RULE}` });
    return;
  }
  const targetRole: Role = isRole(role) ? role : "user";
  const targetHostId = hostId == null ? null : Number(hostId);
  if (targetHostId != null && !Number.isInteger(targetHostId)) {
    res.status(400).json({ error: "invalid hostId" });
    return;
  }

  const db = getDb();
  if (getStaticSiteByLabel(db, username)) {
    res.status(409).json({ error: "username collides with a static-site label" });
    return;
  }
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
        jobId: null,
        message: "target host not found or disabled; use 'Provision' once a host is available",
      });
      return;
    }
    try {
      // Provisioning can take minutes; run it in the background and let the
      // client poll the job. The account row exists immediately (status
      // "pending") so the user shows up with a Repair action.
      const { jobId } = startStandardAccountProvision({
        user: { id: user.id, username: user.username },
        hostId: targetHostId,
        password,
        // Create sets a fresh shared password; force it so web and XMPP cannot
        // drift even if a Snikket account with this name somehow already exists.
        forceTenantPassword: true,
        createdBy: currentUserId(res) ?? null,
      });
      res.status(202).json({ user, password, jobId });
      return;
    } catch (err) {
      res.status(201).json({
        user,
        password,
        jobId: null,
        message: err instanceof Error ? err.message : "provisioning failed",
      });
      return;
    }
  }

  res.status(201).json({ user, password, jobId: null });
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
  if (rejectGroup(target, res, "manage")) {
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
  if (rejectGroup(target, res, "manage")) {
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
  if (rejectGroup(target, res, "manage")) {
    return;
  }
  if (target.enabled) {
    res.status(400).json({ error: "user is already enabled" });
    return;
  }

  const password = generatePassword();
  updateUserPasswordHash(db, id, await hashPassword(password));
  setUserEnabled(db, id, true);

  let jobId: number | null = null;
  let message: string | undefined;
  const account = getAccountForUser(db, id);
  if (account) {
    try {
      ({ jobId } = startStandardAccountProvision({
        user: { id: target.id, username: target.username },
        hostId: account.host_id,
        password,
        // Disable randomized the XMPP credential, so enable must re-set it.
        forceTenantPassword: true,
        createdBy: currentUserId(res) ?? null,
      }));
    } catch (err) {
      message = err instanceof Error ? err.message : "provisioning failed";
    }
  } else {
    message = "user has no provisioned account; use Provision";
  }

  res.json({
    user: { id: target.id, username: target.username, role: target.role, enabled: 1 },
    password,
    jobId,
    message,
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
  if (rejectGroup(target, res, "manage")) {
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

  try {
    // Repair re-runs the whole idempotent profile. No password is passed, so
    // the tenant's existing web/XMPP password is left untouched: the Snikket
    // step only converges missing pieces.
    const { jobId } = startStandardAccountProvision({
      user: { id: target.id, username: target.username },
      hostId: targetHostId,
      createdBy: currentUserId(res) ?? null,
    });
    res.json({
      user: { id: target.id, username: target.username },
      jobId,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "provisioning failed",
    });
  }
});

// Standardize/upgrade a tenant's agent: force the stable channel, update the
// agent + WebUI onto the PM-managed environment, install plugin deps, reconcile
// the model, and retire the legacy venv. Background job; poll GET /api/jobs/:id.
api.post("/users/:id/update", requireAuth, requireAdmin, (req, res) => {
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
  if (rejectGroup(target, res, "manage")) {
    return;
  }
  if (!target.enabled) {
    res.status(400).json({ error: "user is disabled; enable it first" });
    return;
  }
  try {
    const { jobId } = startAgentUpdate({
      user: { id: target.id, username: target.username },
      createdBy: currentUserId(res) ?? null,
    });
    res.status(202).json({ user: { id: target.id, username: target.username }, jobId });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "failed to start update",
    });
  }
});

// Fleet-wide standardize/upgrade: serialized (one tenant at a time). Returns
// immediately; poll GET /api/users/update/status for progress.
api.post("/users/update", requireAuth, requireAdmin, (_req, res) => {
  try {
    const state = startFleetAgentUpdate({ createdBy: currentUserId(res) ?? null });
    res.status(202).json(state);
  } catch (err) {
    res.status(409).json({
      error: err instanceof Error ? err.message : "failed to start fleet update",
    });
  }
});

api.get("/users/update/status", requireAuth, requireAdmin, (_req, res) => {
  res.json(getFleetUpdateState());
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
  if (rejectGroup(target, res, "manage")) {
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

// Send an XMPP message to a user from their Hermes agent account. This is a
// literal `hermes send` (no LLM turn, no running gateway needed): the agent's
// configured XMPP credentials push the message to the tenant's own JID.
const MESSAGE_MAX = 2000;

api.post("/users/:id/message", requireAuth, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const { message } = (req.body ?? {}) as { message?: unknown };
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (message.length > MESSAGE_MAX) {
    res.status(400).json({ error: `message must be at most ${MESSAGE_MAX} characters` });
    return;
  }
  const db = getDb();
  const target = getUserById(db, id);
  if (!target) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  if (rejectGroup(target, res, "manage")) {
    return;
  }
  if (!target.enabled) {
    res.status(400).json({ error: "user is disabled; enable it first" });
    return;
  }
  if (!getAccountForUser(db, id)) {
    res.status(400).json({ error: "user is not provisioned; provision it first" });
    return;
  }
  try {
    const result = await sendAgentXmppMessage({
      user: { id: target.id, username: target.username },
      message,
    });
    // The send attempt's outcome is carried in the body (ok/output) so the UI
    // can show the captured output even on a delivery failure.
    res.json({ ok: result.ok, output: result.output });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "failed to send message",
    });
  }
});

// --- Upstream model refresh (admin) ---
// Re-lists the gateway's upstream provider models and restarts every tenant's
// WebUI so it drops its cached catalog. Needed because Bifrost does not re-list
// providers on a schedule: a model renamed at an upstream (e.g. a vLLM
// served-model-name change) stays invisible to `/v1/models` until refreshed.
api.post("/models/refresh", requireAuth, requireAdmin, async (_req, res) => {
  try {
    res.json(await refreshModelsAndRestartWebuis());
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "failed to refresh models",
    });
  }
});

// --- Per-user default model (admin) ---
// Lets an admin set any tenant's Hermes default model. Mirrors the self-service
// /me/model routes; applying restarts that tenant's agent gateway + WebUI.

api.get("/users/:id/model", requireAuth, requireAdmin, async (req, res) => {
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
  if (rejectGroup(target, res, "manage")) {
    return;
  }
  try {
    res.json(await modelViewFor(db, id));
  } catch (err) {
    res.status(502).json({
      error: "could not read the gateway model catalog",
      message: err instanceof Error ? err.message : undefined,
    });
  }
});

api.post("/users/:id/model", requireAuth, requireAdmin, async (req, res) => {
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
  if (rejectGroup(target, res, "manage")) {
    return;
  }
  const { model } = (req.body ?? {}) as { model?: unknown };
  await setModelFor(
    res,
    { id: target.id, username: target.username },
    model,
    currentUserId(res) ?? null,
  );
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

// Admins see every job; anyone else may read a job they started (e.g. a group
// owner polling their group's agent provisioning).
api.get("/jobs/:id", requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const user = currentUser(res);
  const db = getDb();
  const job = getJob(db, id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  if (user?.role !== "admin" && job.created_by !== user?.id) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  res.json({ job, steps: getJobSteps(db, id) });
});

// --- Account-scoped static sites ---
//
// A static site is `<label>.<base>`, served from the owner's `~/www/<label>` by
// the nginx on the owner's host (the gateway forwards to
// `<owner-host>:14000`). The source/build project lives in `~/sites/<label>`.
// The owner is an account: a user, or a group (whose owner manages its sites;
// members may read them). 5 sites per owner. Removing a site drops the route
// only -- the files are kept.

const STATIC_SITE_LIMIT = 5;

interface StaticSiteView {
  id: number;
  owner_kind: "user" | "group";
  owner_id: number;
  owner_name: string;
  label: string;
  hostname: string;
  source_root: string;
  served_root: string;
  require_auth: number;
  created_at: string;
}

function siteView(site: StaticSite, ownerName: string): StaticSiteView {
  return {
    ...site,
    owner_name: ownerName,
    hostname: BASE_DOMAIN ? staticSiteHost(site.label) : "",
  };
}

interface SessionUser {
  id: number;
  username: string;
  role: Role;
}

function currentUser(res: {
  locals: { session?: { user: SessionUser } };
}): SessionUser | undefined {
  return res.locals.session?.user;
}

interface AccountTarget {
  account: User;
  host: Host;
}

// Authorization for account-scoped resources. Admins always; otherwise the
// account itself, plus (for a group) its members. `manage` narrows group access
// to the group's owner -- static sites use that, while app slots let any member
// operate them.
function accountTargetFor(
  res: Response,
  id: number,
  opts: { manage?: boolean } = {},
): { target: AccountTarget } | { status: number; error: string } {
  const user = currentUser(res);
  if (!user) return { status: 401, error: "unauthorized" };
  const db = getDb();
  const account = getUserById(db, id);
  if (!account) return { status: 404, error: "account not found" };
  const isOwner =
    account.id === user.id ||
    (account.kind === "group" && account.owner_user_id === user.id);
  const isMember =
    account.kind === "group" && isGroupMember(db, account.id, user.id);
  const allowed =
    user.role === "admin" || (opts.manage ? isOwner : isOwner || isMember);
  if (!allowed) return { status: 403, error: "forbidden" };
  const hostAccount = getAccountForUser(db, account.id);
  if (!hostAccount) {
    return { status: 400, error: "account is not provisioned" };
  }
  return { target: { account, host: hostAccount.host } };
}

// Site labels share the account namespace, so a label may not collide with a
// username or group name (or with another site's label).
function siteLabelConflict(
  db: ReturnType<typeof getDb>,
  label: string,
): string | null {
  if (getUserByUsername(db, label)) return "label collides with an account name";
  if (getStaticSiteByLabel(db, label)) return "label already exists";
  return null;
}

async function createSiteFor(
  res: Response,
  owner: { id: number; username: string; kind: "user" | "group"; enabled: number },
  body: { label?: unknown; requireAuth?: unknown },
): Promise<void> {
  const { label, requireAuth } = body;
  if (!isProvisionableSiteLabel(label)) {
    res.status(400).json({ error: `invalid label: ${LABEL_RULE}` });
    return;
  }
  if (!owner.enabled) {
    res.status(400).json({ error: "owner account is disabled; enable it first" });
    return;
  }
  const db = getDb();
  const account = getAccountForUser(db, owner.id);
  if (!account || !account.host.enabled) {
    res.status(400).json({
      error:
        "owner has no provisioned host account; provision the account before adding static sites",
    });
    return;
  }
  const conflict = siteLabelConflict(db, label);
  if (conflict) {
    res.status(409).json({ error: conflict });
    return;
  }
  if (countStaticSitesForOwner(db, owner.id) >= STATIC_SITE_LIMIT) {
    res.status(409).json({
      error: `at most ${STATIC_SITE_LIMIT} static sites per owner`,
    });
    return;
  }
  const paths = sitePaths(owner.username, label);
  let site: StaticSite;
  try {
    site = createStaticSite(db, {
      owner_kind: owner.kind,
      owner_id: owner.id,
      label,
      source_root: paths.source,
      served_root: paths.served,
      require_auth: requireAuth === true ? 1 : 0,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      res.status(409).json({ error: "label already exists" });
      return;
    }
    throw err;
  }
  const sites = await reconcileSitesSafe();
  res.status(201).json({ site: siteView(site, owner.username), sites });
}

// A site may be managed by its owner (a user, or a group's owner) or an admin.
function siteManageable(
  db: ReturnType<typeof getDb>,
  site: StaticSite,
  user: SessionUser | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (site.owner_kind === "user") return site.owner_id === user.id;
  const group = getGroupById(db, site.owner_id);
  return !!group && group.owner_user_id === user.id;
}

// An account's static sites (self, group member read, admin).
api.get("/accounts/:id/static-sites", requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const found = accountTargetFor(res, id);
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  const { account } = found.target;
  const db = getDb();
  res.json({
    sites: listStaticSitesForOwner(db, account.id).map((s) =>
      siteView(s, account.username),
    ),
    limit: STATIC_SITE_LIMIT,
  });
});

// Create a site for the account (the account itself, a group's owner, admin).
api.post("/accounts/:id/static-sites", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const found = accountTargetFor(res, id, { manage: true });
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  await createSiteFor(
    res,
    found.target.account,
    (req.body ?? {}) as Record<string, unknown>,
  );
});

api.patch("/static-sites/:id", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const { requireAuth: required } = (req.body ?? {}) as { requireAuth?: unknown };
  if (typeof required !== "boolean") {
    res.status(400).json({ error: "requireAuth must be a boolean" });
    return;
  }
  const db = getDb();
  const site = getStaticSiteById(db, id);
  if (!site) {
    res.status(404).json({ error: "static site not found" });
    return;
  }
  if (!siteManageable(db, site, currentUser(res))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  setStaticSiteRequireAuth(db, id, required);
  const owner = getUserById(db, site.owner_id);
  const sites = await reconcileSitesSafe();
  res.json({
    site: siteView({ ...site, require_auth: required ? 1 : 0 }, owner?.username ?? ""),
    sites,
  });
});

api.delete("/static-sites/:id", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const db = getDb();
  const site = getStaticSiteById(db, id);
  if (!site) {
    res.status(404).json({ error: "static site not found" });
    return;
  }
  if (!siteManageable(db, site, currentUser(res))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  // Route only: the owner's ~/sites and ~/www trees are retained.
  deleteStaticSite(db, id);
  const sites = await reconcileSitesSafe();
  res.json({ ok: true, sites });
});

// --- Account app slots (self, group members, admins) ---
//
// Every account has two app slots (`app`, `app-dev`) as user units installed by
// provisioning (scripts/account/ensure-apps.sh). The app reads their state and
// enables/disables/restarts them through the account's user manager, and serves
// recent journal lines. The same routes work for a user and for a group
// (members may manage their group's slots).

function isAppSlot(value: unknown): value is AppSlot {
  return typeof value === "string" && (APP_SLOTS as string[]).includes(value);
}

function isAppAction(value: unknown): value is AppAction {
  return value === "enable" || value === "disable" || value === "restart";
}

api.get("/accounts/:id/apps", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const found = accountTargetFor(res, id);
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  const { account, host } = found.target;
  try {
    const status = await getAppStatus({
      username: account.username,
      ssh_target: host.ssh_target,
    });
    res.json({
      account: { id: account.id, username: account.username, kind: account.kind },
      ...status,
    });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "could not read app slots",
    });
  }
});

api.post("/accounts/:id/apps", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const { slot, action } = (req.body ?? {}) as { slot?: unknown; action?: unknown };
  if (!isAppSlot(slot)) {
    res.status(400).json({ error: "slot must be 'app' or 'app-dev'" });
    return;
  }
  if (!isAppAction(action)) {
    res.status(400).json({ error: "action must be enable, disable, or restart" });
    return;
  }
  const found = accountTargetFor(res, id);
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  const target = {
    username: found.target.account.username,
    ssh_target: found.target.host.ssh_target,
  };
  try {
    const result = await controlApp(target, slot, action);
    // Re-read the state so the caller can render it without a second request;
    // a failed read must not hide the action's own result.
    let status = null;
    try {
      status = await getAppStatus(target);
    } catch {
      status = null;
    }
    res.json({ ok: result.ok, output: result.output, ...(status ?? {}) });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "app control failed",
    });
  }
});

api.get("/accounts/:id/apps/:slot/logs", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  if (!isAppSlot(req.params.slot)) {
    res.status(400).json({ error: "slot must be 'app' or 'app-dev'" });
    return;
  }
  const found = accountTargetFor(res, id);
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  const rawLines = Array.isArray(req.query.lines)
    ? req.query.lines[0]
    : req.query.lines;
  const lines =
    typeof rawLines === "string" && /^[0-9]+$/.test(rawLines)
      ? Math.min(2000, Math.max(1, Number(rawLines)))
      : 200;
  try {
    const result = await getAppLogs(
      {
        username: found.target.account.username,
        ssh_target: found.target.host.ssh_target,
      },
      req.params.slot,
      lines,
    );
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "could not read app logs",
    });
  }
});

// --- Groups (accounts shared by members) ---
//
// A group is an account (users.kind='group') with an owner and members. The
// owner manages it; members can use it (its app slots and hosts) and read it.
// Groups are disabled, never deleted; ownership transfer is admin-only.
// Self-service creation is capped and provisions on the owner's host.

const GROUP_LIMIT = 5;

interface GroupView {
  id: number;
  username: string;
  role: "owner" | "member" | "admin";
  owner_username: string | null;
  enabled: number;
  created_at: string;
  member_count: number;
  provisioned: boolean;
  host: string | null;
  status: "pending" | "active" | "failed" | null;
  agent: boolean;
}

function groupView(db: ReturnType<typeof getDb>, row: GroupRow): GroupView {
  const account = getAccountForUser(db, row.id);
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    owner_username: row.owner_username,
    enabled: row.enabled,
    created_at: row.created_at,
    member_count: row.member_count,
    provisioned: !!account,
    host: account?.host.name ?? null,
    status: account?.status ?? null,
    agent: !!account?.bifrost_vk_id,
  };
}

function groupViewFrom(
  db: ReturnType<typeof getDb>,
  group: User,
  role: GroupView["role"],
): GroupView {
  const account = getAccountForUser(db, group.id);
  const members = listGroupMembers(db, group.id);
  const owner = members.find((m) => m.role === "owner");
  return {
    id: group.id,
    username: group.username,
    role,
    owner_username: owner?.username ?? null,
    enabled: group.enabled,
    created_at: group.created_at,
    member_count: members.length,
    provisioned: !!account,
    host: account?.host.name ?? null,
    status: account?.status ?? null,
    agent: !!account?.bifrost_vk_id,
  };
}

interface GroupAccess {
  group: User;
  role: GroupView["role"];
}

// Read: admins, the owner, members. Manage: admins and the owner.
function groupAccess(
  res: Response,
  id: number,
  opts: { manage?: boolean } = {},
): { access: GroupAccess } | { status: number; error: string } {
  const user = currentUser(res);
  if (!user) return { status: 401, error: "unauthorized" };
  const db = getDb();
  const group = getGroupById(db, id);
  if (!group) return { status: 404, error: "group not found" };
  const isOwner = group.owner_user_id === user.id;
  const isMember = isGroupMember(db, group.id, user.id);
  const isAdmin = user.role === "admin";
  const allowed = isAdmin || (opts.manage ? isOwner : isOwner || isMember);
  if (!allowed) return { status: 403, error: "forbidden" };
  const role: GroupView["role"] = isOwner
    ? "owner"
    : isMember
      ? "member"
      : "admin";
  return { access: { group, role } };
}

// My groups (owned + member-of) and the self-service cap.
api.get("/groups", requireAuth, (_req, res) => {
  const user = currentUser(res);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const db = getDb();
  res.json({
    groups: listGroupsForUser(db, user.id).map((g) => groupView(db, g)),
    limit: GROUP_LIMIT,
    owned: countOwnedGroups(db, user.id),
  });
});

// Create a group and provision it on the owner's host. The DB row is created
// first (groups are disable-only), then the converge runs inline so the caller
// gets the log; a failed converge is reported, not hidden.
api.post("/groups", requireAuth, async (req, res) => {
  const user = currentUser(res);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { name } = (req.body ?? {}) as { name?: unknown };
  if (!isProvisionableUsername(name)) {
    res.status(400).json({ error: `invalid group name: ${LABEL_RULE}` });
    return;
  }
  const db = getDb();
  if (getUserByUsername(db, name)) {
    res.status(409).json({ error: "name already exists" });
    return;
  }
  if (getStaticSiteByLabel(db, name)) {
    res.status(409).json({ error: "name collides with a static-site label" });
    return;
  }
  if (countOwnedGroups(db, user.id) >= GROUP_LIMIT) {
    res.status(409).json({ error: `at most ${GROUP_LIMIT} owned groups` });
    return;
  }
  const ownerAccount = getAccountForUser(db, user.id);
  if (!ownerAccount || !ownerAccount.host.enabled) {
    res.status(400).json({
      error: "provision your own account before creating groups",
    });
    return;
  }
  let group: User;
  try {
    group = createGroup(db, {
      name,
      ownerUserId: user.id,
      passwordHash: await hashPassword(generatePassword()),
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      res.status(409).json({ error: "name already exists" });
      return;
    }
    throw err;
  }
  let provisioning: GroupProvisionResult;
  try {
    provisioning = await provisionGroup({
      group,
      hostId: ownerAccount.host_id,
      createdBy: user.id,
    });
  } catch (err) {
    provisioning = {
      ok: false,
      jobId: 0,
      status: "failed",
      output: err instanceof Error ? err.message : "provisioning failed",
    };
  }
  const fresh = getGroupById(db, group.id);
  res.status(201).json({
    group: fresh ? groupViewFrom(db, fresh, "owner") : null,
    members: listGroupMembers(db, group.id),
    provisioning,
  });
});

api.get("/groups/:id", requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const found = groupAccess(res, id);
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  const user = currentUser(res);
  const db = getDb();
  res.json({
    group: groupViewFrom(db, found.access.group, found.access.role),
    members: listGroupMembers(db, id),
    canManage:
      user?.role === "admin" ||
      found.access.group.owner_user_id === user?.id,
  });
});

// Add a member by username (owner/admin). Converges the Linux group.
api.post("/groups/:id/members", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const found = groupAccess(res, id, { manage: true });
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  const { username } = (req.body ?? {}) as { username?: unknown };
  if (typeof username !== "string" || !username.trim()) {
    res.status(400).json({ error: "username is required" });
    return;
  }
  const db = getDb();
  const member = getUserByUsername(db, username.trim());
  if (!member) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  if (member.kind !== "user") {
    res.status(400).json({ error: "a group cannot be a member of a group" });
    return;
  }
  if (!member.enabled) {
    res.status(400).json({ error: "user is disabled" });
    return;
  }
  addGroupMember(db, id, member.id);
  const membership = await ensureGroupMembership(found.access.group);
  res.json({ members: listGroupMembers(db, id), membership });
});

// Remove a member (owner/admin). The owner must be transferred, not removed.
api.delete("/groups/:id/members/:userId", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  if (id == null || userId == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const found = groupAccess(res, id, { manage: true });
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  const db = getDb();
  const member = listGroupMembers(db, id).find((m) => m.user_id === userId);
  if (!member) {
    res.status(404).json({ error: "member not found" });
    return;
  }
  if (member.role === "owner") {
    res.status(400).json({ error: "transfer ownership before removing the owner" });
    return;
  }
  removeGroupMember(db, id, userId);
  const membership = await ensureGroupMembership(found.access.group);
  res.json({ members: listGroupMembers(db, id), membership });
});

// Disable/enable (disable-only lifecycle; the account and files are kept).
api.post("/groups/:id/disable", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const found = groupAccess(res, id, { manage: true });
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  const db = getDb();
  setUserEnabled(db, id, false);
  // Cut the group's agent off the same way a user disable does: stop its
  // gateway and deactivate its LLM key. (Routes drop via the reconcile below.)
  try {
    await deactivateUserAccess({
      user: found.access.group,
      createdBy: currentUser(res)?.id ?? null,
    });
  } catch (err) {
    console.error(`could not stop the agent for group ${id}:`, err);
  }
  const fresh = getGroupById(db, id);
  const sites = await reconcileSitesSafe();
  res.json({
    group: fresh ? groupViewFrom(db, fresh, found.access.role) : null,
    sites,
  });
});

api.post("/groups/:id/enable", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const found = groupAccess(res, id, { manage: true });
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  const db = getDb();
  setUserEnabled(db, id, true);
  const membership = await ensureGroupMembership(found.access.group);
  const fresh = getGroupById(db, id);
  const sites = await reconcileSitesSafe();
  res.json({
    group: fresh ? groupViewFrom(db, fresh, found.access.role) : null,
    membership,
    sites,
  });
});

// Retry/converge the group account (Linux user+group, home, app slots).
api.post("/groups/:id/provision", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const found = groupAccess(res, id, { manage: true });
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  const db = getDb();
  const group = found.access.group;
  const existing = getAccountForUser(db, id);
  let hostId = existing?.host_id ?? null;
  if (hostId == null && group.owner_user_id != null) {
    const ownerAccount = getAccountForUser(db, group.owner_user_id);
    hostId = ownerAccount?.host_id ?? null;
  }
  if (hostId == null) {
    res.status(400).json({
      error: "no host: the group owner has no provisioned account",
    });
    return;
  }
  try {
    const provisioning = await provisionGroup({
      group,
      hostId,
      createdBy: currentUser(res)?.id ?? null,
    });
    const fresh = getGroupById(db, id);
    res.json({
      group: fresh ? groupViewFrom(db, fresh, found.access.role) : null,
      members: listGroupMembers(db, id),
      provisioning,
    });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "provisioning failed",
    });
  }
});

// Provision (or re-run) the group's agent. Heavy, so it is a background job;
// the caller polls GET /api/jobs/:id.
api.post("/groups/:id/hermes", requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const found = groupAccess(res, id, { manage: true });
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  try {
    const { jobId } = startGroupAgent({
      group: found.access.group,
      createdBy: currentUser(res)?.id ?? null,
    });
    res.status(202).json({ jobId });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "could not start the agent",
    });
  }
});

// Message as the group's agent to a chosen member (a group has no single home
// channel, so the sender picks).
api.post("/groups/:id/message", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const found = groupAccess(res, id, { manage: true });
  if ("error" in found) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  const { username, message } = (req.body ?? {}) as {
    username?: unknown;
    message?: unknown;
  };
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (message.length > 2000) {
    res.status(400).json({ error: "message must be at most 2000 characters" });
    return;
  }
  const db = getDb();
  const member =
    typeof username === "string"
      ? listGroupMembers(db, id).find((m) => m.username === username.trim())
      : undefined;
  if (!member) {
    res.status(400).json({ error: "choose a member of this group" });
    return;
  }
  try {
    const result = await sendGroupAgentMessage({
      group: found.access.group,
      target: member.username,
      message,
    });
    res.json({ ok: result.ok, output: result.output });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "failed to send the message",
    });
  }
});

// Admin: transfer ownership (the previous owner stays a member).
api.post("/groups/:id/owner", requireAuth, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const db = getDb();
  const group = getGroupById(db, id);
  if (!group) {
    res.status(404).json({ error: "group not found" });
    return;
  }
  const { username } = (req.body ?? {}) as { username?: unknown };
  if (typeof username !== "string" || !username.trim()) {
    res.status(400).json({ error: "username is required" });
    return;
  }
  const next = getUserByUsername(db, username.trim());
  if (!next || next.kind !== "user") {
    res.status(400).json({ error: "the new owner must be a user account" });
    return;
  }
  if (!next.enabled) {
    res.status(400).json({ error: "user is disabled" });
    return;
  }
  setGroupOwner(db, id, next.id);
  const fresh = getGroupById(db, id) as User;
  const membership = await ensureGroupMembership(fresh);
  const user = currentUser(res);
  res.json({
    group: groupViewFrom(
      db,
      fresh,
      fresh.owner_user_id === user?.id ? "owner" : "admin",
    ),
    members: listGroupMembers(db, id),
    membership,
  });
});

// Admin: every group (the admin user list only shows people).
api.get("/admin/groups", requireAuth, requireAdmin, (_req, res) => {
  const user = currentUser(res);
  const db = getDb();
  res.json({
    groups: listAllGroups(db, user?.id ?? -1).map((g) => groupView(db, g)),
    limit: GROUP_LIMIT,
  });
});
