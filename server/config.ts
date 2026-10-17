import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Per-instance configuration. This app has NO built-in instance defaults: every
// deployment-specific value (domains, endpoints, providers, hosts) is read from
// a per-instance JSON file, and the process refuses to start if any required
// value is missing. That is deliberate — a fallback would let one deployment
// silently adopt another's identity (e.g. pointing agents at a different
// gateway). See notes/initial-setup.md and deploy/instances/.
//
// The file is selected by KUNGURU_INSTANCE (name -> deploy/instances/<name>.json)
// or KUNGURU_CONFIG (explicit path). Secrets are NOT read here; they stay on the
// host (e.g. /etc/bifrost/env, or env overrides like BIFROST_ADMIN_PASSWORD).

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type HostRole = "user-server" | "gateway" | "admin";
const HOST_ROLES: readonly HostRole[] = ["user-server", "gateway", "admin"];

export interface InstanceHost {
  name: string;
  role: HostRole;
  sshTarget: string;
}

export interface InstanceConfig {
  domain: string;
  cookieDomain: string;
  acmeEmail: string;
  sitesCert: string;
  gatewayWgIp: string;
  snikketHost: string;
  gatewayHost: string;
  sshUser: string;
  xmppDomain: string;
  llm: {
    apiUrl: string;
    baseUrl: string;
    providers: string[];
    model: string;
  };
  hosts: InstanceHost[];
  runtime: { port: number; host: string };
  // Absolute path the config was loaded from (useful in diagnostics).
  source: string;
}

function resolveConfigPath(): string {
  const explicit = process.env.KUNGURU_CONFIG?.trim();
  if (explicit) {
    return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  }
  const instance = process.env.KUNGURU_INSTANCE?.trim();
  if (!instance) {
    throw new Error(
      "no instance config: set KUNGURU_INSTANCE=<name> (reads deploy/instances/<name>.json) " +
        "or KUNGURU_CONFIG=<path>. This app has no built-in instance defaults.",
    );
  }
  return join(REPO_ROOT, "deploy", "instances", `${instance}.json`);
}

type Problem = string;

function str(raw: Record<string, unknown>, key: string, problems: Problem[]): string {
  const v = raw[key];
  if (typeof v !== "string" || !v.trim()) {
    problems.push(`"${key}" must be a non-empty string`);
    return "";
  }
  return v.trim();
}

function validate(raw: unknown, source: string): InstanceConfig {
  const problems: Problem[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`instance config ${source} must be a JSON object`);
  }
  const r = raw as Record<string, unknown>;

  const domain = str(r, "domain", problems);
  const acmeEmail = str(r, "acmeEmail", problems);
  const sitesCert = str(r, "sitesCert", problems);
  const gatewayWgIp = str(r, "gatewayWgIp", problems);
  const snikketHost = str(r, "snikketHost", problems);
  const gatewayHost = str(r, "gatewayHost", problems);
  const xmppDomain = str(r, "xmppDomain", problems);

  // cookieDomain is optional; when absent it derives from domain (no literal).
  const cookieDomain =
    typeof r.cookieDomain === "string" && r.cookieDomain.trim()
      ? r.cookieDomain.trim()
      : domain
        ? `users.${domain}`
        : "";

  const sshUser =
    typeof r.sshUser === "string" && r.sshUser.trim() ? r.sshUser.trim() : "kunguru";

  const llmRaw = r.llm;
  const llm = { apiUrl: "", baseUrl: "", providers: [] as string[], model: "" };
  if (typeof llmRaw !== "object" || llmRaw === null) {
    problems.push(`"llm" must be an object with apiUrl/baseUrl/providers/model`);
  } else {
    const l = llmRaw as Record<string, unknown>;
    llm.apiUrl = str(l, "apiUrl", problems);
    llm.baseUrl = str(l, "baseUrl", problems);
    llm.model = str(l, "model", problems);
    if (!Array.isArray(l.providers) || l.providers.length === 0 || l.providers.some((p) => typeof p !== "string" || !p.trim())) {
      problems.push(`"llm.providers" must be a non-empty array of strings`);
    } else {
      llm.providers = (l.providers as string[]).map((p) => p.trim());
    }
  }

  const hosts: InstanceHost[] = [];
  if (!Array.isArray(r.hosts) || r.hosts.length === 0) {
    problems.push(`"hosts" must be a non-empty array`);
  } else {
    r.hosts.forEach((h, i) => {
      if (typeof h !== "object" || h === null) {
        problems.push(`hosts[${i}] must be an object`);
        return;
      }
      const hh = h as Record<string, unknown>;
      const name = typeof hh.name === "string" ? hh.name.trim() : "";
      const role = typeof hh.role === "string" ? hh.role.trim() : "";
      const sshTarget = typeof hh.sshTarget === "string" ? hh.sshTarget.trim() : "";
      if (!name) problems.push(`hosts[${i}].name is required`);
      if (!HOST_ROLES.includes(role as HostRole)) {
        problems.push(`hosts[${i}].role must be one of ${HOST_ROLES.join(", ")}`);
      }
      if (!sshTarget) problems.push(`hosts[${i}].sshTarget is required`);
      if (name && sshTarget && HOST_ROLES.includes(role as HostRole)) {
        hosts.push({ name, role: role as HostRole, sshTarget });
      }
    });
  }

  const runtimeRaw = (r.runtime ?? {}) as Record<string, unknown>;
  const port =
    runtimeRaw.port === undefined ? 3030 : typeof runtimeRaw.port === "number" ? runtimeRaw.port : NaN;
  const host =
    typeof runtimeRaw.host === "string" && runtimeRaw.host.trim() ? runtimeRaw.host.trim() : "127.0.0.1";
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    problems.push(`"runtime.port" must be a valid port number`);
  }

  if (problems.length > 0) {
    throw new Error(
      `instance config ${source} is incomplete:\n  - ${problems.join("\n  - ")}`,
    );
  }

  return {
    domain,
    cookieDomain,
    acmeEmail,
    sitesCert,
    gatewayWgIp,
    snikketHost,
    gatewayHost,
    sshUser,
    xmppDomain,
    llm,
    hosts,
    runtime: { port, host },
    source,
  };
}

function load(): InstanceConfig {
  const source = resolveConfigPath();
  if (!existsSync(source)) {
    throw new Error(
      `instance config not found: ${source}\n` +
        `Set KUNGURU_INSTANCE to an existing deploy/instances/<name>.json, or KUNGURU_CONFIG to a path.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(source, "utf8"));
  } catch (err) {
    throw new Error(
      `instance config ${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validate(parsed, source);
}

// Loaded once at module import: any process that pulls in config (directly or via
// bifrost/inventory) validates before doing anything else.
export const config: InstanceConfig = load();

export function sshTargetForHost(name: string): string {
  return config.hosts.find((h) => h.name === name)?.sshTarget ?? name;
}
