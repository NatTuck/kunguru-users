import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getDb,
  getHostByName,
  listHosts,
  listSiteUsers,
  listStaticSiteHosts,
  type StaticSiteHostRow,
} from "./db";
import {
  BASE_DOMAIN,
  GATEWAY_HOST_NAME,
  GATEWAY_WG_IP,
  PORT_STATIC_SITES,
  PRIVATE_DOMAIN,
  SCRIPTS_DIR,
  SITES_CERT_NAME,
  SSH_USER,
} from "./inventory";
import { siteRoutes, staticSiteHost, upstreamHost } from "./sites";
import { runRemote } from "./transport/run";
import { config } from "./config";

export interface ReconcileResult {
  ok: boolean;
  skipped: boolean;
  output: string;
}

export interface HostReconcileResult {
  host: string;
  ok: boolean;
  output: string;
}

/**
 * Reconcile the gateway's nginx routes from current DB state: the two app slots
 * and WebUI of every enabled account, plus every static site (forwarded to the
 * owner's host). Runs on the host that owns nginx. Idempotent; safe after any
 * user/account/site change.
 */
export async function reconcileUserSites(): Promise<ReconcileResult> {
  if (!BASE_DOMAIN) {
    return {
      ok: true,
      skipped: true,
      output: "KUNGURU_BASE_DOMAIN unset; per-user site routing disabled",
    };
  }
  const db = getDb();
  const gateway = getHostByName(db, GATEWAY_HOST_NAME);
  if (!gateway || !gateway.enabled) {
    throw new Error(`gateway host '${GATEWAY_HOST_NAME}' not configured`);
  }

  const routes = siteRoutes(listSiteUsers(db), listStaticSiteHosts(db));
  const script = await readFile(
    join(SCRIPTS_DIR, "nginx/ensure-user-sites.sh"),
    "utf8",
  );
  const res = await runRemote({
    sshUser: SSH_USER,
    sshTarget: gateway.ssh_target,
    script,
    env: {
      KUNGURU_BASE_DOMAIN: BASE_DOMAIN,
      KUNGURU_ROUTES: JSON.stringify(routes),
      KUNGURU_SITES_CERT: SITES_CERT_NAME,
      KUNGURU_AUTH_TARGET: `127.0.0.1:${config.runtime.port}`,
      // The login app's own host (`users.<base>`); require_auth hosts redirect
      // there with `next=<original URL>`.
      ...(PRIVATE_DOMAIN ? { KUNGURU_AUTH_HOST: PRIVATE_DOMAIN } : {}),
    },
    timeoutMs: 300_000,
  });
  return { ok: res.exitCode === 0, skipped: false, output: res.output };
}

// The address a host's static nginx binds, and the peers allowed to reach it.
// Co-located hosts are reached over loopback; everything else only accepts the
// gateway's VPN address.
function staticBind(sshTarget: string): { bind: string; allow: string } {
  const t = sshTarget.trim();
  if (t === "localhost") return { bind: "127.0.0.1", allow: "127.0.0.1 ::1" };
  return { bind: upstreamHost(t), allow: GATEWAY_WG_IP };
}

/**
 * Reconcile the static-site nginx on every enabled host. Each host gets one
 * gateway-only HTTP listener on PORT_STATIC_SITES serving that host's sites
 * from the owner's `~/www/<label>` (and creating those directories + the
 * www-data ACLs). Hosts with no sites get the listener removed, so deleting the
 * last site on a host converges too. Per-host failures are reported, never
 * thrown.
 */
export async function reconcileUserStaticSites(): Promise<HostReconcileResult[]> {
  if (!BASE_DOMAIN) return [];
  const db = getDb();
  const sitesByHost = new Map<string, StaticSiteHostRow[]>();
  for (const host of listHosts(db)) sitesByHost.set(host.ssh_target, []);
  for (const site of listStaticSiteHosts(db)) {
    const bucket = sitesByHost.get(site.ssh_target);
    if (bucket) bucket.push(site);
  }

  let script: string;
  try {
    script = await readFile(
      join(SCRIPTS_DIR, "nginx/ensure-user-static.sh"),
      "utf8",
    );
  } catch {
    return [];
  }

  const results: HostReconcileResult[] = [];
  for (const [sshTarget, sites] of sitesByHost) {
    const { bind, allow } = staticBind(sshTarget);
    const payload = sites.map((s) => ({
      label: s.label,
      hostname: staticSiteHost(s.label),
      owner: s.owner_name,
      source_root: s.source_root,
      served_root: s.served_root,
    }));
    const res = await runRemote({
      sshUser: SSH_USER,
      sshTarget,
      script,
      env: {
        KUNGURU_BASE_DOMAIN: BASE_DOMAIN,
        KUNGURU_STATIC_PORT: String(PORT_STATIC_SITES),
        KUNGURU_STATIC_BIND: bind,
        KUNGURU_STATIC_ALLOW: allow,
        KUNGURU_SITES: JSON.stringify(payload),
      },
      timeoutMs: 300_000,
    });
    results.push({
      host: sshTarget,
      ok: res.exitCode === 0,
      output: res.output,
    });
  }
  return results;
}

/**
 * Converge everything site-related: the gateway's routes and each host's static
 * listener. Used after any account or static-site change.
 */
export async function reconcileSites(): Promise<ReconcileResult> {
  // Hosts first: a static-site route should only appear on the gateway once the
  // host listener that serves it exists.
  const hosts = await reconcileUserStaticSites();
  const gateway = await reconcileUserSites();
  const output = [
    ...hosts.map((h) => `[${h.host}] ${h.output}`),
    gateway.output,
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  return {
    ok: gateway.ok && hosts.every((h) => h.ok),
    skipped: gateway.skipped && hosts.length === 0,
    output,
  };
}
