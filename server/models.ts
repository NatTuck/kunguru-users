import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb, listActiveAccountUsers } from "./db";
import { SCRIPTS_DIR, SSH_USER } from "./inventory";
import {
  BIFROST_PROVIDERS,
  listCatalogModels,
  refreshProviderModels,
  type CatalogModel,
} from "./bifrost";
import { runRemote } from "./transport/run";

export interface ProviderRefreshResult {
  provider: string;
  ok: boolean;
  error?: string;
}

export interface WebuiRestartResult {
  username: string;
  ok: boolean;
  error?: string;
}

export interface ModelsRefreshResult {
  providers: ProviderRefreshResult[];
  models: CatalogModel[];
  webuis: WebuiRestartResult[];
  ok: boolean;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tail(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** Re-lists every configured upstream provider's models in Bifrost. */
async function refreshUpstreamModels(): Promise<ProviderRefreshResult[]> {
  const results: ProviderRefreshResult[] = [];
  for (const provider of BIFROST_PROVIDERS) {
    try {
      await refreshProviderModels(provider);
      results.push({ provider, ok: true });
    } catch (err) {
      results.push({ provider, ok: false, error: errText(err) });
    }
  }
  return results;
}

/**
 * Restarts every active tenant's Hermes WebUI so it drops its cached model
 * catalog and re-fetches `/v1/models` from the gateway. Runs the shipped
 * `webui/restart.sh` over the app's ssh transport, as the provisioning steps do.
 */
async function restartAllWebuis(): Promise<WebuiRestartResult[]> {
  const users = listActiveAccountUsers(getDb());
  if (users.length === 0) return [];

  let script: string;
  try {
    script = await readFile(join(SCRIPTS_DIR, "webui/restart.sh"), "utf8");
  } catch {
    return users.map((u) => ({
      username: u.username,
      ok: false,
      error: "webui/restart.sh is missing from the deployment",
    }));
  }

  const results: WebuiRestartResult[] = [];
  for (const u of users) {
    try {
      const res = await runRemote({
        sshUser: SSH_USER,
        sshTarget: u.ssh_target,
        script,
        env: { USERNAME: u.username },
        timeoutMs: 60_000,
      });
      const ok = res.exitCode === 0;
      results.push({
        username: u.username,
        ok,
        error: ok ? undefined : res.timedOut ? "timed out" : tail(res.output),
      });
    } catch (err) {
      results.push({ username: u.username, ok: false, error: errText(err) });
    }
  }
  return results;
}

/**
 * Admin "refresh models" operation: re-list the gateway's upstream provider
 * models (so renames at a self-hosted upstream show up for every virtual key),
 * then restart every active tenant's WebUI to drop its cached catalog.
 */
export async function refreshModelsAndRestartWebuis(): Promise<ModelsRefreshResult> {
  const providers = await refreshUpstreamModels();

  let models: CatalogModel[] = [];
  try {
    models = await listCatalogModels();
  } catch {
    // Best-effort: provider refresh results still convey what happened.
  }

  const webuis = await restartAllWebuis();
  const ok = providers.every((p) => p.ok) && webuis.every((w) => w.ok);
  return { providers, models, webuis, ok };
}
