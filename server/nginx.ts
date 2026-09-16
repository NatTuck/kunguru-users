import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb, getHostByName, listSiteUsers } from "./db";
import {
  ACME_EMAIL,
  BASE_DOMAIN,
  GATEWAY_HOST_NAME,
  SCRIPTS_DIR,
  SITES_CERT_NAME,
  SSH_USER,
} from "./inventory";
import { siteRoutes } from "./sites";
import { runRemote } from "./transport/run";

export interface ReconcileResult {
  ok: boolean;
  skipped: boolean;
  output: string;
}

/**
 * Reconcile the gateway's per-user reverse-proxy routes (Hermes WebUI, private
 * app, public site) from current DB state. Runs on the host that owns nginx.
 * Idempotent; safe after any user create/enable/disable/provision.
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

  const routes = siteRoutes(listSiteUsers(db));
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
      KUNGURU_ACME_EMAIL: ACME_EMAIL,
      KUNGURU_SITES_CERT: SITES_CERT_NAME,
      KUNGURU_AUTH_TARGET: `127.0.0.1:${process.env.PORT ?? 3030}`,
    },
    timeoutMs: 300_000,
  });
  return { ok: res.exitCode === 0, skipped: false, output: res.output };
}
