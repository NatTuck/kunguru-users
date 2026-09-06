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
