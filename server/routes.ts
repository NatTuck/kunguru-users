import { Router } from "express";
import {
  countAdmins,
  createUser,
  deleteUser,
  generatePassword,
  getDb,
  getUserById,
  listUsers,
  setUserRole,
  updateUserPasswordHash,
  type PublicUser,
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

export const api = Router();

const ROLES: Role[] = ["admin", "user"];

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as string[]).includes(value);
}

function isValidUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9._-]{1,64}$/.test(value)
  );
}

function toPublicOf(u: {
  id: number;
  username: string;
  role: Role;
  created_at: string;
}): PublicUser {
  return { id: u.id, username: u.username, role: u.role, created_at: u.created_at };
}

// --- Auth ---

api.post("/auth/login", loginHandler);
api.post("/auth/logout", logoutHandler);
api.get("/auth/me", requireAuth, meHandler);

// --- Admin-only user management ---

api.get("/users", requireAuth, requireAdmin, (_req, res) => {
  res.json({ users: listUsers(getDb()) });
});

api.post("/users", requireAuth, requireAdmin, async (req, res) => {
  const { username, role } = (req.body ?? {}) as {
    username?: unknown;
    role?: unknown;
  };
  if (!isValidUsername(username)) {
    res.status(400).json({ error: "invalid username" });
    return;
  }
  const targetRole: Role = isRole(role) ? role : "user";

  const db = getDb();
  const password = generatePassword();
  const hash = await hashPassword(password);
  try {
    const user = createUser(db, username, hash, targetRole);
    // Show the generated password exactly once.
    res.status(201).json({ user, password });
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
});

api.patch("/users/:id/role", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { role } = (req.body ?? {}) as { role?: unknown };
  if (!Number.isInteger(id) || id < 1) {
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
  const ctx = res.locals.session as { user: { id: number; role: Role } };
  if (id === ctx.user.id) {
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

api.delete("/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const db = getDb();
  const target = getUserById(db, id);
  if (!target) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  const ctx = res.locals.session as { user: { id: number; role: Role } };
  if (id === ctx.user.id) {
    res.status(400).json({ error: "you cannot delete your own account" });
    return;
  }
  if (target.role === "admin" && countAdmins(db) <= 1) {
    res.status(400).json({ error: "cannot delete the last admin" });
    return;
  }
  deleteUser(db, id);
  res.json({ ok: true });
});

api.post(
  "/users/:id/reset-password",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const db = getDb();
    const target = getUserById(db, id);
    if (!target) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    const password = generatePassword();
    const hash = await hashPassword(password);
    updateUserPasswordHash(db, id, hash);
    res.json({ user: toPublicOf(target), password });
  },
);
