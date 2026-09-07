import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

// App-side client for the Bifrost LLM gateway (see notes/initial-setup.md §4).
// The app issues one scoped virtual key per managed account so the tenant's
// Hermes agent can call the LLM through the gateway, where usage/quota are
// tracked per key. Only the virtual-key id is persisted (accounts.bifrost_vk_id);
// the key secret travels in memory to the agent's config on the host and is
// never stored by this app.
//
// Defaults match the kunguru hub deployment. Override per instance via env in
// ~/.config/kunguru-users.env (never in the repo).

// Management API origin. The web app runs on the same host as the Bifrost
// container, so the loopback URL is used for admin operations (no TLS needed).
export const BIFROST_API_URL =
  process.env.BIFROST_API_URL ?? "http://127.0.0.1:8181";

// Providers a per-user key is scoped to (whitespace-separated names as shown
// in the Bifrost dashboard). Agents may use any model those providers serve.
export const BIFROST_PROVIDERS = (
  process.env.BIFROST_PROVIDERS ?? "deepseek"
)
  .split(/\s+/)
  .filter(Boolean);

// OpenAI-compatible endpoint + default model the tenant Hermes agents are
// pointed at (Hermes model.base_url needs the /v1 suffix).
export const HERMES_LLM_BASE_URL =
  process.env.HERMES_LLM_BASE_URL ?? "https://llm.ironbeard.com/v1";
export const HERMES_MODEL = process.env.HERMES_MODEL ?? "deepseek-v4-flash";

// XMPP domain agents bridge into (their Snikket account lives on this domain).
export const XMPP_DOMAIN = process.env.XMPP_DOMAIN ?? "chat.ironbeard.com";

const ENV_FILE = "/etc/bifrost/env";

const pexec = promisify(execFile);

interface Creds {
  username: string;
  password: string;
}

function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

// Admin credentials come from instance env when set; otherwise they are read
// from /etc/bifrost/env on the gateway host (root-owned; the app process user
// has passwordless sudo, mirroring how it reaches hosts for provisioning).
async function creds(): Promise<Creds> {
  const u = process.env.BIFROST_ADMIN_USERNAME;
  const p = process.env.BIFROST_ADMIN_PASSWORD;
  if (u && p) return { username: u, password: p };
  const { stdout } = await pexec("sudo", ["-n", "cat", ENV_FILE], {
    timeout: 15_000,
  });
  const env = parseEnvFile(stdout);
  const username = env.get("BIFROST_ADMIN_USERNAME");
  const password = env.get("BIFROST_ADMIN_PASSWORD");
  if (!username || !password) {
    throw new Error(
      `could not load Bifrost admin credentials from ${ENV_FILE} (set BIFROST_ADMIN_USERNAME/PASSWORD to override)`,
    );
  }
  return { username, password };
}

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const c = await creds();
  const res = await fetch(`${BIFROST_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`bifrost ${method} ${path}: HTTP ${res.status} ${text.slice(0, 400)}`);
  }
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return {} as T;
  }
}

export interface VirtualKey {
  id: string;
  value: string;
}

/** Creates an active per-user virtual key covering the configured providers. */
export async function createVirtualKey(opts: {
  name: string;
}): Promise<VirtualKey> {
  // Virtual key names are unique even after deactivation, so make each
  // issuance unique (a re-provision rotates the key).
  const attempts: string[] = [opts.name];
  for (let i = 0; i < 5; i++) {
    attempts.push(`${opts.name}-${randomBytes(3).toString("hex")}`);
  }
  let lastErr: unknown;
  for (const name of attempts) {
    const body = {
      name,
      is_active: true,
      provider_configs: BIFROST_PROVIDERS.map((provider) => ({
        provider,
        weight: 1,
        allowed_models: ["*"],
        key_ids: ["*"],
      })),
    };
    try {
      const data = await api<{ virtual_key?: { id?: string; value?: string } }>(
        "POST",
        "/api/governance/virtual-keys",
        body,
      );
      const vk = data?.virtual_key;
      if (!vk?.id || !vk?.value) {
        throw new Error("bifrost create virtual key: unexpected response (no id/value)");
      }
      return { id: vk.id, value: vk.value };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists")) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("bifrost create virtual key failed");
}

/** Enables/disables an existing virtual key (deactivate on disable/rotate). */
export async function setVirtualKeyActive(
  id: string,
  active: boolean,
): Promise<void> {
  await api(
    "PUT",
    `/api/governance/virtual-keys/${encodeURIComponent(id)}`,
    { is_active: active },
  );
}
