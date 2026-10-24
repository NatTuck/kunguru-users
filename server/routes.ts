import { Router, type Response } from "express";
import {
  countAdmins,
  countStaticSitesForOwner,
  createStaticSite,
  createUser,
  deleteSessionsForUser,
  deleteStaticSite,
  generatePassword,
  getAccountForUser,
  getDb,
  getHostById,
  getJob,
  getJobSteps,
  getStaticSiteById,
  getStaticSiteByLabel,
  getUserById,
  getUserByUsername,
  listHosts,
  listJobsForUser,
  listStaticSitesForOwner,
  listUsersWithAccounts,
  setStaticSiteRequireAuth,
  setUserEnabled,
  setUserRole,
  toAdminRows,
  updateUserPasswordHash,
  type Role,
  type StaticSite,
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
  getFleetUpdateState,
  sendAgentXmppMessage,
  startAgentUpdate,
  startFleetAgentUpdate,
  startStandardAccountProvision,
  syncSnikketPassword,
  applyUserModel,
  type ProvisionResult,
} from "./provision";
import {
  LABEL_RULE,
  isProvisionableSiteLabel,
  isProvisionableUsername,
  servicePort,
  sitePaths,
  staticSiteHost,
  upstreamHost,
} from "./sites";
import { tcpUp } from "./probe";
import { reconcileSites } from "./nginx";
import { refreshModelsAndRestartWebuis } from "./models";
import { BASE_DOMAIN, PRIVATE_DOMAIN } from "./inventory";
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
// app, `<account>-dev.<base>` app-dev, `<account>-agent.<base>` WebUI) and the
// XMPP domain. `authHost` is the login app's own host (`users.<base>`). Public:
// these are DNS names.
api.get("/config", (_req, res) => {
  res.json({
    baseDomain: BASE_DOMAIN,
    privateDomain: PRIVATE_DOMAIN,
    authHost: PRIVATE_DOMAIN,
    xmppDomain: XMPP_DOMAIN,
  });
});

// --- My personal apps (self) ---
// Liveness of the signed-in user's app slots (app, app-dev) and WebUI, for the
// account page. TCP-only: it reports whether the tenant's own upstream is
// listening on its slot port; the gateway route + TLS are managed separately by
// reconcile. Short, bounded probes run concurrently.
api.get("/me/sites", requireAuth, async (_req, res) => {
  const userId = currentUserId(res);
  if (userId == null) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const db = getDb();
  const account = getAccountForUser(db, userId);
  if (!BASE_DOMAIN || !account || !account.host.enabled) {
    res.json({
      provisioned: false,
      app: { up: false },
      appDev: { up: false },
      webui: { up: false },
    });
    return;
  }
  const host = upstreamHost(account.host.ssh_target);
  const [appUp, appDevUp, webuiUp] = await Promise.all([
    tcpUp(host, servicePort("app", userId)),
    tcpUp(host, servicePort("app-dev", userId)),
    tcpUp(host, servicePort("hermes-webui", userId)),
  ]);
  res.json({
    provisioned: true,
    app: { up: appUp },
    appDev: { up: appDevUp },
    webui: { up: webuiUp },
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
  if (!getUserById(db, id)) {
    res.status(404).json({ error: "user not found" });
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

// --- Static sites (owner-scoped) ---
//
// A static site is `<label>.<base>`, served from the owner's `~/www/<label>` by
// the nginx on the owner's host (the gateway forwards to
// `<owner-host>:14000`). The source/build project lives in `~/sites/<label>`.
// Owners are users or groups; 5 sites per owner. Removing a site drops the
// route only -- the owner's files are kept.

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

// A site may be managed by its owner or by an admin. Group-owned sites are
// admin-only for now; Phase 3 adds member management.
function siteManageable(
  site: StaticSite,
  user: SessionUser | undefined,
): boolean {
  if (!user) return false;
  return user.role === "admin" || site.owner_id === user.id;
}

// Admin: a specific account's static sites.
api.get("/users/:id/static-sites", requireAuth, requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const db = getDb();
  const owner = getUserById(db, id);
  if (!owner) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  res.json({
    sites: listStaticSitesForOwner(db, id).map((s) => siteView(s, owner.username)),
  });
});

api.post("/users/:id/static-sites", requireAuth, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const db = getDb();
  const owner = getUserById(db, id);
  if (!owner) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  await createSiteFor(res, owner, (req.body ?? {}) as Record<string, unknown>);
});

// Self-service: the signed-in user's own static sites. (Phase 3 adds sites
// owned by the user's groups.)
api.get("/me/static-sites", requireAuth, (_req, res) => {
  const user = currentUser(res);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json({
    sites: listStaticSitesForOwner(getDb(), user.id).map((s) =>
      siteView(s, user.username),
    ),
    limit: STATIC_SITE_LIMIT,
  });
});

api.post("/me/static-sites", requireAuth, async (req, res) => {
  const user = currentUser(res);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const db = getDb();
  const owner = getUserById(db, user.id);
  if (!owner) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  await createSiteFor(res, owner, (req.body ?? {}) as Record<string, unknown>);
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
  if (!siteManageable(site, currentUser(res))) {
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
  if (!siteManageable(site, currentUser(res))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  // Route only: the owner's ~/sites and ~/www trees are retained.
  deleteStaticSite(db, id);
  const sites = await reconcileSitesSafe();
  res.json({ ok: true, sites });
});
