import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb, getHostByName, listSiteUsers, listStaticSiteHosts } from "./db";
import {
  BASE_DOMAIN,
  GATEWAY_HOST_NAME,
  PRIVATE_DOMAIN,
  SCRIPTS_DIR,
  SITES_CERT_NAME,
  SSH_USER,
} from "./inventory";
import { siteRoutes } from "./sites";
import { runRemote } from "./transport/run";
import { config } from "./config";

export interface ReconcileResult {
  ok: boolean;
  skipped: boolean;
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
