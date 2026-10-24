import { createServer } from "node:http";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import express, { type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import ViteExpress from "vite-express";
import {
  ensureAdminSeed,
  ensureHostSeed,
  getDb,
  getStaticSiteByLabel,
  getUserById,
  getUserByUsername,
  isGroupMember,
  listGroupNamesForUser,
  ADMIN_USERNAME,
  type StaticSite,
  type User,
} from "./db";
import { config } from "./config";
import { hostSeeds } from "./inventory";
import { resolveSession } from "./auth";
import { resolveHost, type AccountSlot } from "./sites";
import { api } from "./routes";

const app = express();

app.use(express.json());
app.use(cookieParser());

app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return a === "::1" || a === "127.0.0.1" || a.startsWith("127.");
}

type AuthTarget =
  | { kind: "account"; slot: AccountSlot; account: User }
  | { kind: "static"; site: StaticSite; owner: User };

function resolveAuthTarget(
  db: ReturnType<typeof getDb>,
  host: string | undefined,
): AuthTarget | null {
  const match = resolveHost(host);
  if (!match) return null;
  if (match.kind === "account") {
    const account = getUserByUsername(db, match.name);
    if (!account) return null;
    return { kind: "account", slot: match.slot, account };
  }
  // A bare `<label>.<base>`: an account's app slot, or a static site. Account
  // names and static-site labels share one namespace, so the account wins.
  const account = getUserByUsername(db, match.label);
  if (account) return { kind: "account", slot: "app", account };
  const site = getStaticSiteByLabel(db, match.label);
  if (!site) return null;
  const owner = getUserById(db, site.owner_id);
  if (!owner) return null;
  return { kind: "static", site, owner };
}

function targetRequiresAuth(target: AuthTarget): boolean {
  if (target.kind === "static") return target.site.require_auth === 1;
  switch (target.slot) {
    case "hermes-webui":
      return true; // the managed WebUI is always gated
    case "app":
      return target.account.require_auth === 1;
    case "app-dev":
      return target.account.require_auth_dev === 1;
  }
}

// Whether the signed-in user may use the host. Groups are shared: any member
// may. Users and user-owned sites are self-only.
function targetAllows(
  db: ReturnType<typeof getDb>,
  target: AuthTarget,
  userId: number,
): boolean {
  if (target.kind === "static") {
    return target.owner.kind === "group"
      ? isGroupMember(db, target.owner.id, userId)
      : target.owner.id === userId;
  }
  return target.account.kind === "group"
    ? isGroupMember(db, target.account.id, userId)
    : target.account.id === userId;
}

// nginx `auth_request` target for every routed host. It resolves the requested
// host to an account slot (`<account>.<base>`, `<account>-dev.<base>`,
// `<account>-agent.<base>`) or a static site (`<label>.<base>`), then:
//
//   - optional host: 200, with identity headers when a session is present;
//   - require_auth host: 200 + identity, or 401 when anonymous/unauthorized;
//   - a valid session that is not allowed: 401 (not 403) so nginx's
//     `error_page 401 = @login` sends the visitor to the login form.
//
// Identity is asserted via X-Auth-User / X-Auth-Groups, which nginx forwards as
// the trusted Remote-User / Remote-Groups headers. This endpoint never
// redirects itself.
//
// It is reachable only from nginx: on the loopback TCP address when no socket
// is configured, otherwise on a unix socket in a root-created directory
// (`runtime.authSocket`) whose permissions exclude tenants.
function handleInternalAuth(req: Request, res: Response): void {
  const peer = req.socket.remoteAddress;
  // A unix socket has no peer address; its directory/socket permissions are
  // the access control. A TCP peer must be loopback.
  if (peer !== undefined && !isLoopback(peer)) {
    res.status(403).end();
    return;
  }
  const originalHost =
    (req.headers["x-original-host"] as string | undefined) ?? req.headers.host;
  const db = getDb();
  const target = resolveAuthTarget(db, originalHost);
  // Unknown host, or a disabled account/site whose route should be gone: no
  // identity, no access. Check the disabled state here rather than trusting the
  // route table to be current (reconcile may have failed).
  const disabled =
    target?.kind === "account"
      ? !target.account.enabled
      : target?.kind === "static"
        ? !target.owner.enabled
        : false;
  if (!target || disabled) {
    res.status(403).end();
    return;
  }
  const required = targetRequiresAuth(target);

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

  if (required && !targetAllows(db, target, ctx.user.id)) {
    res.status(401).end();
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Auth-User", ctx.user.username);
  res.setHeader("X-Auth-Groups", listGroupNamesForUser(db, ctx.user.id).join(","));
  res.status(200).end();
}

const authSocket = config.runtime.authSocket;
if (authSocket) {
  // The socket is the only way in; the TCP listener must not answer the
  // subrequest (a stale nginx target would otherwise get the SPA's 200).
  app.get("/internal/auth", (_req, res) => {
    res.status(404).end();
  });
} else {
  app.get("/internal/auth", handleInternalAuth);
}

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

if (authSocket) {
  // The directory is created by tmpfiles.d (root) with group www-data; the
  // socket inherits that group, so only nginx (and the app user) can connect.
  if (existsSync(authSocket)) {
    const st = lstatSync(authSocket);
    if (!st.isSocket()) {
      console.error(
        `error: ${authSocket} exists and is not a socket; refusing to start`,
      );
      process.exit(1);
    }
    unlinkSync(authSocket);
  }
  const internal = express();
  internal.use(cookieParser());
  internal.get("/internal/auth", handleInternalAuth);
  const internalServer = createServer(internal);
  internalServer.on("error", (err) => {
    console.error(
      `error: could not listen on the auth socket ${authSocket}: ${err.message}`,
    );
    process.exit(1);
  });
  internalServer.listen(authSocket, () => {
    chmodSync(authSocket, 0o660);
    console.log(`internal auth socket: ${authSocket}`);
  });
}
