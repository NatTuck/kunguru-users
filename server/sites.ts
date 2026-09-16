import {
  BASE_DOMAIN,
  PORT_HERMES_WEBUI,
  PORT_PRIVATE_APP,
  PORT_PUBLIC_SITE,
} from "./inventory";
import type { SiteUserRow } from "./db";

// Generic per-user site model. Each user gets three slots, all served by the
// gateway's nginx and reverse-proxied over the WireGuard LAN to the user's host:
//
//   hermes-webui  <user>-hermes.users.<base>  11000+id  private (self only)
//   private-app   <user>.users.<base>         13000+id  private (self only)
//   public-site   <user>.<base>               12000+id  public
//
// `private` slots live under the session-cookie domain (`users.<base>`), so the
// nginx `auth_request` can see the app session; `public` slots do not.
//
// Users are provisioned as DNS labels, so the hostnames are unambiguous:
// usernames may not end in `-hermes` (reserved for the WebUI slot).

export type SiteAccess = "private" | "public";
export type SiteService = "hermes-webui" | "private-app" | "public-site";

export interface SiteRoute {
  userId: number;
  username: string;
  service: SiteService;
  hostname: string;
  port: number;
  access: SiteAccess;
  /** nginx upstream, `host:port` (the user's host as reachable from the gateway). */
  upstream: string;
}

// The DB stores the ssh address; nginx wants a literal. `localhost` (the app's
// own host) becomes loopback so variable `proxy_pass` needs no resolver.
function upstreamHost(sshTarget: string): string {
  const t = sshTarget.trim();
  return t === "localhost" ? "127.0.0.1" : t;
}

export function hermesWebuiHost(username: string): string {
  return `${username}-hermes.users.${BASE_DOMAIN}`;
}

export function privateAppHost(username: string): string {
  return `${username}.users.${BASE_DOMAIN}`;
}

export function publicSiteHost(username: string): string {
  return `${username}.${BASE_DOMAIN}`;
}

export function siteRoutes(users: SiteUserRow[]): SiteRoute[] {
  if (!BASE_DOMAIN) return [];
  const routes: SiteRoute[] = [];
  for (const u of users) {
    const host = upstreamHost(u.ssh_target);
    const slots: Array<[SiteService, string, number, SiteAccess]> = [
      ["hermes-webui", hermesWebuiHost(u.username), PORT_HERMES_WEBUI + u.id, "private"],
      ["private-app", privateAppHost(u.username), PORT_PRIVATE_APP + u.id, "private"],
      ["public-site", publicSiteHost(u.username), PORT_PUBLIC_SITE + u.id, "public"],
    ];
    for (const [service, hostname, port, access] of slots) {
      routes.push({
        userId: u.id,
        username: u.username,
        service,
        hostname,
        port,
        access,
        upstream: `${host}:${port}`,
      });
    }
  }
  return routes;
}

/**
 * Resolve the owning username for a private host under `users.<base>`
 * (`<user>.users.<base>` or `<user>-hermes.users.<base>`). Returns null for the
 * base domain, public hosts, deeper names, or when unconfigured.
 */
export function privateUsernameFromHost(host: string | undefined): string | null {
  if (!host || !BASE_DOMAIN) return null;
  const h = host.split(":")[0].trim().toLowerCase();
  const suffix = `.users.${BASE_DOMAIN}`;
  if (!h.endsWith(suffix)) return null;
  let label = h.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  if (label.endsWith("-hermes")) label = label.slice(0, -"-hermes".length);
  return label || null;
}

// Usernames double as DNS labels (`<user>.<base>` and `<user>.users.<base>`),
// so they must be valid labels, must not collide with the reserved `-hermes`
// WebUI suffix, and must not shadow infrastructure hostnames.
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

const USERNAME_RE = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;

export function isProvisionableUsername(value: unknown): value is string {
  if (typeof value !== "string" || !USERNAME_RE.test(value)) return false;
  if (value.endsWith("-hermes")) return false;
  if (RESERVED_LABELS.has(value)) return false;
  return true;
}
