import {
  BASE_DOMAIN,
  PORT_APP,
  PORT_APP_DEV,
  PORT_HERMES_WEBUI,
  PORT_STATIC_SITES,
} from "./inventory";
import type { SiteAccountRow, StaticSiteHostRow } from "./db";

// Host model. Every account — a user, or a group (`users.kind = 'group'`) —
// gets two app slots plus a managed WebUI, all served by the gateway's nginx
// and reverse-proxied over the WireGuard LAN to the account's host:
//
//   app           <account>.<base>        12000 + id
//   app-dev       <account>-dev.<base>    13000 + id
//   hermes-webui  <account>-agent.<base>  11000 + id
//
// Static sites are a separate owner-scoped resource (owner = user or group):
//
//   static site   <label>.<base>          -> <owner-host>:14000
//
// The user-server nginx serves `<label>.<base>` from the owner's
// `~/www/<label>` on that constant port; the gateway only forwards. There are
// no aliases: an extra hostname needs an account name (a group).
//
// `-dev` and `-agent` are reserved suffixes, so `<label>-dev` always means
// account `<label>`'s dev slot and never a static site or account name.

export type SiteSlot = "app" | "app-dev" | "hermes-webui" | "static";
export type AccountSlot = Exclude<SiteSlot, "static">;

export const APP_DEV_SUFFIX = "-dev";
export const AGENT_SUFFIX = "-agent";

export function servicePort(slot: AccountSlot, accountId: number): number {
  switch (slot) {
    case "hermes-webui":
      return PORT_HERMES_WEBUI + accountId;
    case "app":
      return PORT_APP + accountId;
    case "app-dev":
      return PORT_APP_DEV + accountId;
  }
}

// The DB stores the ssh address; nginx wants a literal. `localhost` (the app's
// own host) becomes loopback so variable `proxy_pass` needs no resolver.
export function upstreamHost(sshTarget: string): string {
  const t = sshTarget.trim();
  return t === "localhost" ? "127.0.0.1" : t;
}

export function appHost(name: string): string {
  return `${name}.${BASE_DOMAIN}`;
}

export function appDevHost(name: string): string {
  return `${name}${APP_DEV_SUFFIX}.${BASE_DOMAIN}`;
}

export function webuiHost(name: string): string {
  return `${name}${AGENT_SUFFIX}.${BASE_DOMAIN}`;
}

export function staticSiteHost(label: string): string {
  return `${label}.${BASE_DOMAIN}`;
}

/**
 * Canonical filesystem layout for a static site, relative to the owner's home:
 * the source/build project in `~/sites/<label>` and the served docroot in
 * `~/www/<label>` (the built output the user-server nginx serves).
 */
export function sitePaths(ownerName: string, label: string): {
  source: string;
  served: string;
} {
  const home = `/home/${ownerName}`;
  return { source: `${home}/sites/${label}`, served: `${home}/www/${label}` };
}

export interface SiteRoute {
  hostname: string;
  /** nginx upstream, `host:port`. */
  upstream: string;
  port: number;
  slot: SiteSlot;
  /** Account the host belongs to (the static-site owner for `static`). */
  accountId: number | null;
  accountName: string;
}

/**
 * Every hostname the gateway routes, from the enabled accounts and static
 * sites. Hostnames are unique by construction (labels are unique across
 * accounts and static sites); if an account and a site somehow collide, the
 * account wins.
 */
export function siteRoutes(
  accounts: SiteAccountRow[],
  staticSites: StaticSiteHostRow[] = [],
): SiteRoute[] {
  if (!BASE_DOMAIN) return [];
  const routes: SiteRoute[] = [];
  for (const a of accounts) {
    const host = upstreamHost(a.ssh_target);
    const slots: Array<[AccountSlot, string]> = [
      ["app", appHost(a.username)],
      ["app-dev", appDevHost(a.username)],
      ["hermes-webui", webuiHost(a.username)],
    ];
    for (const [slot, hostname] of slots) {
      const port = servicePort(slot, a.id);
      routes.push({
        hostname,
        upstream: `${host}:${port}`,
        port,
        slot,
        accountId: a.id,
        accountName: a.username,
      });
    }
  }
  const seen = new Set(routes.map((r) => r.hostname));
  for (const s of staticSites) {
    const hostname = staticSiteHost(s.label);
    if (seen.has(hostname)) continue;
    seen.add(hostname);
    routes.push({
      hostname,
      upstream: `${upstreamHost(s.ssh_target)}:${PORT_STATIC_SITES}`,
      port: PORT_STATIC_SITES,
      slot: "static",
      accountId: s.owner_id,
      accountName: s.owner_name,
    });
  }
  return routes;
}

/**
 * What a gateway host means for authentication:
 *
 *   { kind: "account", slot, name }  a slot of an account (app / app-dev / WebUI)
 *   { kind: "label", label }         a bare `<label>.<base>`: an account's app
 *                                    or a static site, resolved against the DB
 *
 * Returns null for anything else: the base domain itself, deeper names
 * (`<a>.<b>.<base>`), the auth host (`users.<base>`), and unconfigured
 * deployments.
 */
export type HostMatch =
  | { kind: "account"; slot: AccountSlot; name: string }
  | { kind: "label"; label: string };

export function resolveHost(host: string | undefined): HostMatch | null {
  if (!host || !BASE_DOMAIN) return null;
  const h = host.split(":")[0].trim().toLowerCase();
  const suffix = `.${BASE_DOMAIN.toLowerCase()}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  // A single label only: no empty label, no deeper names.
  if (!label || label.includes(".")) return null;
  if (label === "users") return null; // the auth app host
  if (label.endsWith(AGENT_SUFFIX)) {
    const name = label.slice(0, -AGENT_SUFFIX.length);
    return name ? { kind: "account", slot: "hermes-webui", name } : null;
  }
  if (label.endsWith(APP_DEV_SUFFIX)) {
    const name = label.slice(0, -APP_DEV_SUFFIX.length);
    return name ? { kind: "account", slot: "app-dev", name } : null;
  }
  return { kind: "label", label };
}

// Labels double as DNS labels (`<label>.<base>`), so they must be valid labels,
// must not end in a reserved suffix (`-dev`, `-agent`), and must not shadow
// infrastructure hostnames.
const RESERVED_LABELS = new Set([
  "chat",
  "groups",
  "share",
  "llm",
  "users",
  "www",
  "admin",
  "api",
  "mail",
  "smtp",
  "imap",
  "pop",
  "ns",
  "vpn",
  "wg",
  "localhost",
]);

const LABEL_RE = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;

function isProvisionableLabel(value: unknown): value is string {
  if (typeof value !== "string" || !LABEL_RE.test(value)) return false;
  if (value.endsWith(AGENT_SUFFIX) || value.endsWith(APP_DEV_SUFFIX)) return false;
  if (RESERVED_LABELS.has(value)) return false;
  return true;
}

/** Account names (users and groups) share the label namespace. */
export function isProvisionableUsername(value: unknown): value is string {
  return isProvisionableLabel(value);
}

/** Static-site labels share the same namespace and rules as account names. */
export function isProvisionableSiteLabel(value: unknown): value is string {
  return isProvisionableLabel(value);
}

/** Human-readable rule text for API validation errors. */
export const LABEL_RULE =
  "lowercase letters/digits/hyphens, starting with a letter, at most 32, not ending in '-dev' or '-agent', not reserved";
