import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, sshTargetForHost } from "./config";
import type { HostSeed } from "./db";

// Server-side inventory for the machines the app provisions onto, and how the
// transport reaches them. Every value is read from the per-instance config
// (server/config.ts); there are no baked-in host/domain defaults.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SSH_USER = config.sshUser;

// Path to the provisioning scripts. Not instance identity; repo-relative unless
// explicitly overridden (e.g. for tests).
export const SCRIPTS_DIR =
  process.env.KUNGURU_SCRIPTS_DIR ?? join(REPO_ROOT, "scripts");

// Host name that runs Snikket (target for the snikket profile step).
export const SNIKKET_HOST_NAME = config.snikketHost;

// Public DNS base / private subtree for per-user service hostnames.
export const BASE_DOMAIN = config.domain;
export const PRIVATE_DOMAIN = config.cookieDomain;

// Session cookie Domain: the base domain, so the gateway sees the session on
// every `<label>.<base>` app host and can inject the verified Remote-User /
// Remote-Groups headers. The session cookie is stripped before proxying to
// tenant apps (scripts/nginx/ensure-user-sites.sh); only the auth app sees it.
export const COOKIE_DOMAIN = config.domain;

// Host that runs nginx; per-user site routes are rendered there.
export const GATEWAY_HOST_NAME = config.gatewayHost;

// Source address the gateway's nginx presents to a user host over the VPN. The
// per-user WebUI trusts only this proxy (plus loopback) for the Remote-User
// header, so it must match the gateway's VPN IP.
export const GATEWAY_WG_IP = config.gatewayWgIp;

// ACME contact + certificate name for the shared per-user sites cert.
export const SITES_CERT_NAME = config.sitesCert;

// Deterministic per-account service ports (`base + users.id`). An account is a
// user or a group: every account gets the same two app slots plus a WebUI.
export const PORT_HERMES_WEBUI = 11000;
export const PORT_APP = 12000;
export const PORT_APP_DEV = 13000;

// Static sites are not per-account: every static site owned by accounts on a
// host is served by one nginx listener on that host. The gateway maps
// `<label>.<base>` to `<owner-host>:<PORT_STATIC_SITES>`; the listener is bound
// to the VPN address and only accepts the gateway.
export const PORT_STATIC_SITES = 14000;

export function hostSeeds(): HostSeed[] {
  return config.hosts.map((h) => ({
    name: h.name,
    role: h.role,
    ssh_target: h.sshTarget,
  }));
}

export function getSshTarget(name: string): string {
  return sshTargetForHost(name);
}
