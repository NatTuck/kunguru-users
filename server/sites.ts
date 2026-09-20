import {
  BASE_DOMAIN,
  PORT_HERMES_WEBUI,
  PORT_PRIVATE_APP,
  PORT_PUBLIC_SITE,
} from "./inventory";
import type { Alias, SiteUserRow } from "./db";

// Generic per-user site model. Each user gets three slots, all served by the
// gateway's nginx and reverse-proxied over the WireGuard LAN to the user's host:
//
//   hermes-webui  <user>-agent.users.<base>   11000+id  private (self only)
//   private-app   <user>.users.<base>         13000+id  private (self only)
//   public-site   <user>.<base>               12000+id  public
//
// `private` slots live under the session-cookie domain (`users.<base>`), so the
// nginx `auth_request` can see the app session; `public` slots do not.
//
// Users are provisioned as DNS labels, so the hostnames are unambiguous:
// usernames may not end in `-agent` (reserved for the WebUI slot, matching the
// XMPP agent identity `<user>-agent`).
//
// Aliases add admin-managed extra hostnames for a user: a `proxy` alias points
// at one of the user's service ports, a `static` alias serves files from a
// root. Public aliases are `<label>.<base>`; private aliases are
// `<label>.users.<base>` (so the auth subrequest can gate them).

export type SiteAccess = "private" | "public";
export type SiteService = "hermes-webui" | "private-app" | "public-site";
export type SiteKind = "proxy" | "static";

export interface SiteRoute {
  userId: number;
  username: string;
  service: SiteService | "alias";
  hostname: string;
  port: number;
  access: SiteAccess;
  kind: SiteKind;
  /** nginx upstream, `host:port` (proxy routes only). */
  upstream: string;
  /** docroot (static routes only). */
  root: string;
}

export function servicePort(service: SiteService, userId: number): number {
  switch (service) {
    case "hermes-webui":
      return PORT_HERMES_WEBUI + userId;
    case "private-app":
      return PORT_PRIVATE_APP + userId;
    case "public-site":
      return PORT_PUBLIC_SITE + userId;
  }
}

// The DB stores the ssh address; nginx wants a literal. `localhost` (the app's
// own host) becomes loopback so variable `proxy_pass` needs no resolver.
function upstreamHost(sshTarget: string): string {
  const t = sshTarget.trim();
  return t === "localhost" ? "127.0.0.1" : t;
}

// Suffix reserved for the tenant's Hermes WebUI slot, matching the XMPP agent
// identity `<user>-agent`. Usernames and alias labels may not end in it (a
// label `foo-agent` would otherwise shadow user `foo`'s WebUI host).
const AGENT_SUFFIX = "-agent";

export function hermesWebuiHost(username: string): string {
  return `${username}${AGENT_SUFFIX}.users.${BASE_DOMAIN}`;
}

export function privateAppHost(username: string): string {
  return `${username}.users.${BASE_DOMAIN}`;
}

export function publicSiteHost(username: string): string {
  return `${username}.${BASE_DOMAIN}`;
}

export function aliasHostname(label: string, access: SiteAccess): string {
  return access === "public"
    ? `${label}.${BASE_DOMAIN}`
    : `${label}.users.${BASE_DOMAIN}`;
}

export function siteRoutes(
  users: SiteUserRow[],
  aliases: Alias[] = [],
): SiteRoute[] {
  if (!BASE_DOMAIN) return [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const routes: SiteRoute[] = [];
  for (const u of users) {
    const host = upstreamHost(u.ssh_target);
    const slots: Array<[SiteService, string, SiteAccess]> = [
      ["hermes-webui", hermesWebuiHost(u.username), "private"],
      ["private-app", privateAppHost(u.username), "private"],
      ["public-site", publicSiteHost(u.username), "public"],
    ];
    for (const [service, hostname, access] of slots) {
      const port = servicePort(service, u.id);
      routes.push({
        userId: u.id,
        username: u.username,
        service,
        hostname,
        port,
        access,
        kind: "proxy",
        upstream: `${host}:${port}`,
        root: "",
      });
    }
  }
  for (const a of aliases) {
    const owner = byId.get(a.user_id);
    const hostname = aliasHostname(a.label, a.access);
    if (a.kind === "static") {
      // Static aliases serve a docroot on the gateway, so they don't need the
      // owner to have an account/host.
      routes.push({
        userId: a.user_id,
        username: owner?.username ?? "",
        service: "alias",
        hostname,
        port: 0,
        access: a.access,
        kind: "static",
        upstream: "",
        root: a.root ?? "",
      });
      continue;
    }
    if (!owner) continue; // proxy alias for a disabled/absent user: skip
    const host = upstreamHost(owner.ssh_target);
    if (!a.service) continue; // proxy alias without a target service
    const port = servicePort(a.service, a.user_id);
    routes.push({
      userId: a.user_id,
      username: owner.username,
      service: "alias",
      hostname,
      port,
      access: a.access,
      kind: "proxy",
      upstream: `${host}:${port}`,
      root: "",
    });
  }
  return routes;
}

/**
 * Resolve the owning username for a private host under `users.<base>`
 * (`<user>.users.<base>` or `<user>-agent.users.<base>`). Returns null for the
 * base domain, public hosts, deeper names, or when unconfigured. Private
 * *alias* labels are resolved separately (via the aliases table).
 */
export function privateUsernameFromHost(host: string | undefined): string | null {
  if (!host || !BASE_DOMAIN) return null;
  const h = host.split(":")[0].trim().toLowerCase();
  const suffix = `.users.${BASE_DOMAIN}`;
  if (!h.endsWith(suffix)) return null;
  let label = h.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  if (label.endsWith(AGENT_SUFFIX)) label = label.slice(0, -AGENT_SUFFIX.length);
  return label || null;
}

/** Extract the bare label from a private host under `users.<base>`, or null. */
export function privateLabelFromHost(host: string | undefined): string | null {
  if (!host || !BASE_DOMAIN) return null;
  const h = host.split(":")[0].trim().toLowerCase();
  const suffix = `.users.${BASE_DOMAIN}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  return label;
}

// Labels double as DNS labels (`<label>.<base>` / `<label>.users.<base>`), so
// they must be valid labels, must not collide with the reserved `-agent`
// suffix, and must not shadow infrastructure hostnames.
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
  if (value.endsWith(AGENT_SUFFIX)) return false;
  if (RESERVED_LABELS.has(value)) return false;
  return true;
}

export function isProvisionableAliasLabel(value: unknown): value is string {
  if (typeof value !== "string" || !USERNAME_RE.test(value)) return false;
  if (value.endsWith(AGENT_SUFFIX)) return false;
  if (RESERVED_LABELS.has(value)) return false;
  return true;
}
