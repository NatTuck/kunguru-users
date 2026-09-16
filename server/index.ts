import express from "express";
import cookieParser from "cookie-parser";
import ViteExpress from "vite-express";
import { ensureAdminSeed, ensureHostSeed, getAliasByLabel, getDb, getUserByUsername, ADMIN_USERNAME } from "./db";
import { hostSeeds } from "./inventory";
import { resolveSession } from "./auth";
import { privateLabelFromHost, privateUsernameFromHost } from "./sites";
import { api } from "./routes";

const app = express();

app.use(express.json());
app.use(cookieParser());

app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// nginx `auth_request` target for the private per-user site hosts. Runs on
// loopback (the gateway's nginx) only; validates the app session and asserts
// the requested private host (`<user>.users.<base>` / `<user>-hermes.users.<base>`)
// resolves to the session user. Returns 200 + X-Auth-User (which nginx forwards
// as the trusted Remote-User header) or 401/403 — never a redirect.
function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return a === "::1" || a === "127.0.0.1" || a.startsWith("127.");
}

app.get("/internal/auth", (req, res) => {
  if (!isLoopback(req.socket.remoteAddress)) {
    res.status(403).end();
    return;
  }
  // Read-only check (no global sweep); sliding expiry is throttled internally.
  const ctx = resolveSession(req, { sweep: false, touch: true });
  if (!ctx) {
    res.status(401).end();
    return;
  }
  const originalHost =
    (req.headers["x-original-host"] as string | undefined) ?? req.headers.host;
  const label = privateLabelFromHost(originalHost);
  if (!label) {
    res.status(403).end();
    return;
  }
  // Owner is the username the label maps to, or (for a private alias label) the
  // alias's user. Both resolve to a user id compared against the session.
  const db = getDb();
  let ownerId: number | null = null;
  const nameOwner = privateUsernameFromHost(originalHost);
  if (nameOwner) {
    const u = getUserByUsername(db, nameOwner);
    if (u) ownerId = u.id;
  }
  if (ownerId == null) {
    const alias = getAliasByLabel(db, label);
    if (alias && alias.access === "private") ownerId = alias.user_id;
  }
  if (ownerId == null || ownerId !== ctx.user.id) {
    res.status(403).end();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Auth-User", ctx.user.username);
  res.status(200).end();
});

app.use("/api", api);

const PORT = Number(process.env.PORT ?? 3030);
const HOST = process.env.HOST ?? "127.0.0.1";

const db = getDb();

const seed = await ensureAdminSeed(db);
if (seed.seeded) {
  console.log("==================================================");
  console.log(`  Admin user "${ADMIN_USERNAME}" created.`);
  console.log(`  One-time password: ${seed.password}`);
  console.log("  Store it somewhere safe now. It will not be shown again.");
  console.log("==================================================");
}

ensureHostSeed(db, hostSeeds());

const server = app.listen(PORT, HOST, () => {
  ViteExpress.bind(app, server);
  console.log(`kunguru-users listening on http://${HOST}:${PORT}`);
});
