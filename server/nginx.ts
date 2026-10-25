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

// Convention (also used by provisioning): a host whose ssh target is
// `localhost` is the machine the app itself runs on — the gateway. Static sites
// owned by accounts there are served by the gateway's own nginx from a docroot
// instead of a loopback HTTP listener: a loopback listener would let any local
// process (including a tenant shell) read a `require_auth` site by sending the
// Host header directly.
const LOCAL_SSH_TARGET = "localhost";

export function isLocalSshTarget(sshTarget: string): boolean {
  return sshTarget.trim() === LOCAL_SSH_TARGET;
}

/**
 * Reconcile the gateway's nginx routes from current DB state: the two app slots
 * and WebUI of every enabled account, plus every static site owned on a remote
 * host (forwarded to `<owner-host>:14000`). Static sites owned on the gateway
 * itself are rendered as local docroot vhosts.
 *
 * `skipStaticHosts` drops the static routes for hosts whose listener failed to
 * converge, so the gateway never forwards to a port that is not being served.
 * Idempotent; safe after any user/account/site change.
 */
export async function reconcileUserSites(opts: {
  skipStaticHosts?: Set<string>;
} = {}): Promise<ReconcileResult> {
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

  const accounts = listSiteUsers(db);
  const sites = listStaticSiteHosts(db);
  const localSites = sites.filter(
    (s) =>
      isLocalSshTarget(s.ssh_target) &&
      !opts.skipStaticHosts?.has(s.ssh_target),
  );
  const remoteSites = sites.filter(
    (s) =>
      !isLocalSshTarget(s.ssh_target) && !opts.skipStaticHosts?.has(s.ssh_target),
  );
  const skippedHosts = sites.filter((s) =>
    opts.skipStaticHosts?.has(s.ssh_target),
  );

  const routes = siteRoutes(accounts, remoteSites);
  const local = localSites.map((s) => ({
    hostname: staticSiteHost(s.label, s.apex === 1),
    label: s.label,
    owner: s.owner_name,
    root: s.served_root,
    apex: s.apex === 1,
  }));

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
      KUNGURU_LOCAL_SITES: JSON.stringify(local),
      KUNGURU_SITES_CERT: SITES_CERT_NAME,
      // The apex site uses the base-domain certificate, not the wildcard pair.
      ...(BASE_DOMAIN ? { KUNGURU_APEX_CERT: BASE_DOMAIN } : {}),
      // The auth subrequest target: the app's unix socket when configured,
      // else its loopback TCP address.
      KUNGURU_AUTH_TARGET: config.runtime.authSocket
        ? `unix:${config.runtime.authSocket}`
        : `127.0.0.1:${config.runtime.port}`,
      // The login app's own host (`users.<base>`); require_auth hosts redirect
      // there with `next=<original URL>`.
      ...(PRIVATE_DOMAIN ? { KUNGURU_AUTH_HOST: PRIVATE_DOMAIN } : {}),
    },
    timeoutMs: 300_000,
  });
  const note =
    skippedHosts.length > 0
      ? `\nskipped ${skippedHosts.length} static route(s) on a host whose listener failed to converge`
      : "";
  return {
    ok: res.exitCode === 0,
    skipped: false,
    output: res.output + note,
  };
}

// The address a host's static nginx binds, and the peers allowed to reach it.
// Remote hosts only accept the gateway's VPN address; a co-located host does
// not get a listener at all (see LOCAL_SSH_TARGET).
function staticBind(sshTarget: string): { bind: string; allow: string } {
  return { bind: upstreamHost(sshTarget.trim()), allow: GATEWAY_WG_IP };
}

/**
 * Reconcile the static-site nginx on every enabled host. A remote host gets one
 * gateway-only HTTP listener on PORT_STATIC_SITES serving that host's sites
 * from the owner's `~/www/<label>`; the gateway host gets only the directories
 * and www-data ACLs (its sites are served by the gateway vhost). Hosts with no
 * sites get the listener removed, so deleting the last site on a host converges
 * too. Per-host failures are reported, never thrown.
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
    const local = isLocalSshTarget(sshTarget);
    const { bind, allow } = staticBind(sshTarget);
    const payload = sites.map((s) => ({
      label: s.label,
      hostname: staticSiteHost(s.label),
      owner: s.owner_name,
      source_root: s.source_root,
      served_root: s.served_root,
      apex: s.apex === 1,
    }));
    const res = await runRemote({
      sshUser: SSH_USER,
      sshTarget,
      script,
      env: {
        KUNGURU_BASE_DOMAIN: BASE_DOMAIN,
        KUNGURU_STATIC_PORT: String(PORT_STATIC_SITES),
        // The gateway host serves its own sites from the gateway vhost, so it
        // only needs the directories + ACLs.
        KUNGURU_STATIC_LISTEN: local ? "0" : "1",
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
 * Converge everything site-related: each host's static listener and docroots,
 * then the gateway's routes. The gateway is rendered last and told which hosts
 * failed, so it never forwards to a listener that is not there.
 */
export async function reconcileSites(): Promise<ReconcileResult> {
  const hosts = await reconcileUserStaticSites();
  const failed = new Set(hosts.filter((h) => !h.ok).map((h) => h.host));
  const gateway = await reconcileUserSites({ skipStaticHosts: failed });
  const output = [
    ...hosts.map((h) => `[${h.host}] ${h.output}`),
    gateway.output,
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  return {
    ok: gateway.ok && failed.size === 0,
    skipped: gateway.skipped && hosts.length === 0,
    output,
  };
}
