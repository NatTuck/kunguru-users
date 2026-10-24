import express from "express";
import cookieParser from "cookie-parser";
import ViteExpress from "vite-express";
import { ensureAdminSeed, ensureHostSeed, getAliasByLabel, getDb, getUserByUsername, isGroupMember, listGroupsForUser, ADMIN_USERNAME } from "./db";
import { config } from "./config";
import { hostSeeds } from "./inventory";
import { resolveSession } from "./auth";
import { privateLabelFromHost, publicLabelFromHost } from "./sites";
import { api } from "./routes";

const app = express();

app.use(express.json());
app.use(cookieParser());

app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// nginx `auth_request` target for the private per-user site hosts. Runs on
// loopback (the gateway's nginx) only; validates the app session and asserts
// the requested private host (`<user>.users.<base>` / `<user>-agent.users.<base>`)
// resolves to the session user. Returns 200 + X-Auth-User (which nginx forwards
// as the trusted Remote-User header). No session, or a session that does not own
// the host, returns 401 so nginx's `error_page 401 = @login` sends the visitor
// to the login form (where they can sign in as the owner). Never redirects
// itself.
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
  const originalHost =
    (req.headers["x-original-host"] as string | undefined) ?? req.headers.host;
  // Private subtree (`*.users.<base>`) and `-agent` hosts (WebUIs) require a
  // signed-in user. Every other app host is optional-auth: anonymous is
  // allowed, and the signed-in identity is injected when present.
  const privateLabel = privateLabelFromHost(originalHost);
  const publicLabel =
    privateLabel == null ? publicLabelFromHost(originalHost) : null;
  const label = privateLabel ?? publicLabel;
  if (!label) {
    res.status(403).end();
    return;
  }
  const db = getDb();
  const alias = getAliasByLabel(db, label);
  const required =
    privateLabel != null ||
    label.endsWith("-agent") ||
    (alias != null && alias.access === "private");

  // Read-only check (no global sweep); sliding expiry is throttled internally.
  const ctx = resolveSession(req, { sweep: false, touch: true });
  if (!ctx) {
    if (required) {
      res.status(401).end();
      return;
    }
    // Optional auth: anonymous is allowed; no identity headers.
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end();
    return;
  }

  if (required) {
    // Resolve the principal (strip the `-agent` WebUI suffix) or the alias
    // owner, and authorize the session user. Groups allow any member; users
    // allow only themselves.
    const principalName = label.endsWith("-agent")
      ? label.slice(0, -"-agent".length)
      : label;
    const principal = getUserByUsername(db, principalName);
    const isGroup =
      (principal as { kind?: string } | undefined)?.kind === "group";
    const ownerId =
      principal?.id ?? (alias?.access === "private" ? alias.user_id : null);
    const authorized = isGroup && principal
      ? isGroupMember(db, principal.id, ctx.user.id)
      : ownerId != null && ownerId === ctx.user.id;
    if (!authorized) {
      // A valid session that does not own this host: 401 (not 403) so nginx
      // redirects to the login form instead of showing a bare 403.
      res.status(401).end();
      return;
    }
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Auth-User", ctx.user.username);
  res.setHeader("X-Auth-Groups", listGroupsForUser(db, ctx.user.id).join(","));
  res.status(200).end();
});

app.use("/api", api);

const PORT = config.runtime.port;
const HOST = config.runtime.host;

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
