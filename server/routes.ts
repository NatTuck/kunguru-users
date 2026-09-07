import { Router } from "express";
import {
  countAdmins,
  createUser,
  generatePassword,
  getAccountForUser,
  getDb,
  getHostById,
  getJob,
  getJobSteps,
  getUserById,
  listHosts,
  listJobsForUser,
  listUsersWithAccounts,
  setUserEnabled,
  setUserRole,
  toAdminRows,
  updateUserPasswordHash,
  type Role,
} from "./db";
import {
  hashPassword,
  loginHandler,
  logoutHandler,
  meHandler,
  requireAdmin,
  requireAuth,
} from "./auth";
import {
  deactivateUserAccess,
  provisionStandardAccount,
  syncSnikketPassword,
  type ProvisionResult,
} from "./provision";

export const api = Router();

const ROLES: Role[] = ["admin", "user"];

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as string[]).includes(value);
}

// Linux/XMPP-friendly usernames (provisioned onto hosts / into Snikket).
function isValidUsername(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9._-]{0,31}$/.test(value);
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
        "invalid username: lowercase letters/digits/._- , starting with a letter (max 32)",
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
      res.status(201).json({
        user,
        password,
        provisioning: toProvisionView(result),
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

  res.json({
    user: { id: target.id, username: target.username, role: target.role, enabled: 0 },
    provisioning,
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

  res.json({
    user: { id: target.id, username: target.username, role: target.role, enabled: 1 },
    password,
    provisioning,
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
    res.json({ user: { id: target.id, username: target.username }, password, provisioning: toProvisionView(result) });
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
