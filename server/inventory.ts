import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostSeed, HostRole } from "./db";

// Server-side inventory for the machines the app provisions onto, and how the
// transport reaches them. Dev defaults mirror the bootstrap group (otter/goose);
// override per deployment with env vars (never bake host-specific facts into
// schema data — hosts are seeded idempotently at boot from here).

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SSH_USER = process.env.KUNGURU_SSH_USER ?? "kunguru";

export const SCRIPTS_DIR =
  process.env.KUNGURU_SCRIPTS_DIR ?? join(REPO_ROOT, "scripts");

// Host name that runs Snikket (target for the snikket profile step).
export const SNIKKET_HOST_NAME =
  process.env.KUNGURU_SNIKKET_HOST ?? "otter.ferrus.net";

// Public DNS base for per-user service hostnames (e.g. `ironbeard.com`). Empty
// disables per-user site routing (dev).
export const BASE_DOMAIN = (process.env.KUNGURU_BASE_DOMAIN ?? "")
  .trim()
  .toLowerCase();

// Private (authenticated) subtree: `<user>.users.<base>` and
// `<user>-hermes.users.<base>`. Also the default session-cookie domain.
export const PRIVATE_DOMAIN = BASE_DOMAIN ? `users.${BASE_DOMAIN}` : "";

// Session cookie Domain. Defaults to the private subtree so the browser also
// sends the session to `<user>.users.<base>`; an explicit override wins; empty
// leaves the cookie host-only (dev).
export const COOKIE_DOMAIN =
  (process.env.KUNGURU_COOKIE_DOMAIN ?? "").trim().toLowerCase() || PRIVATE_DOMAIN;

// Host that runs nginx; per-user site routes are rendered there.
export const GATEWAY_HOST_NAME =
  process.env.KUNGURU_GATEWAY_HOST ?? SNIKKET_HOST_NAME;

// Source address the gateway's nginx presents to a user host over the VPN. The
// per-user WebUI trusts only this proxy (plus loopback) for the Remote-User
// header, so it must match the gateway's VPN IP.
export const GATEWAY_WG_IP = process.env.KUNGURU_GATEWAY_WG_IP ?? "10.0.0.1";

// ACME contact + certificate name for the single combined per-user sites cert.
export const ACME_EMAIL = process.env.KUNGURU_ACME_EMAIL ?? "";
export const SITES_CERT_NAME = process.env.KUNGURU_SITES_CERT ?? "kunguru-sites";

// Extra (non-per-user) hostnames to fold into the combined sites certificate,
// so one certbot cert covers the app + Bifrost + per-user/alias hosts. The
// vhosts for these names are static (bootstrap/deploy), not rendered here.
export const EXTRA_CERT_HOSTS = (process.env.KUNGURU_EXTRA_CERT_HOSTS ?? "")
  .trim();

// Deterministic per-user service ports (`base + users.id`).
export const PORT_HERMES_WEBUI = 11000;
export const PORT_PUBLIC_SITE = 12000;
export const PORT_PRIVATE_APP = 13000;

function envKey(name: string): string {
  return `KUNGURU_SSH_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

interface SeedEntry {
  name: string;
  role: HostRole;
  defaultTarget: string;
}

const DEFAULT_HOSTS: SeedEntry[] = [
  {
    name: process.env.KUNGURU_HOST_OTTER ?? "otter.ferrus.net",
    role: "admin",
    defaultTarget: process.env.KUNGURU_HOST_OTTER ?? "otter.ferrus.net",
  },
  {
    name: process.env.KUNGURU_HOST_GOOSE ?? "goose.ferrus.net",
    role: "user-server",
    defaultTarget: process.env.KUNGURU_HOST_GOOSE ?? "goose",
  },
];

export function hostSeeds(): HostSeed[] {
  return DEFAULT_HOSTS.map((h) => ({
    name: h.name,
    role: h.role,
    ssh_target: process.env[envKey(h.name)] ?? h.defaultTarget,
  }));
}

export function getSshTarget(name: string): string {
  return process.env[envKey(name)] ?? name;
}
