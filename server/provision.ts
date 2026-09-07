import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAccount,
  createJob,
  createJobStep,
  finishJob,
  finishJobStep,
  getAccountByUserHost,
  getAccountForUser,
  getDb,
  getHostById,
  getHostByName,
  setAccountStatus,
  setAccountVkId,
  type Host,
  type JobStatus,
  type User,
} from "./db";
import { SCRIPTS_DIR, SNIKKET_HOST_NAME, SSH_USER } from "./inventory";
import {
  createVirtualKey,
  HERMES_LLM_BASE_URL,
  HERMES_MODEL,
  setVirtualKeyActive,
  XMPP_DOMAIN,
} from "./bifrost";
import { runRemote } from "./transport/run";

export const STANDARD_ACCOUNT_PROFILE = "standard-account";
// Snikket-only password push (used when disabling, to neutralize XMPP).
export const PASSWORD_SYNC_PROFILE = "password-sync";
// Snikket + Hermes XMPP credential push (used on password reset; Hermes LLM key
// is left untouched so the existing gateway key keeps working).
export const SHARED_CREDENTIALS_PROFILE = "shared-credentials";

type StepTarget = "user-host" | "snikket-host";

interface ProfileStepDef {
  name: string;
  scriptRel: string;
  target: StepTarget;
}

interface StepRuntime {
  def: ProfileStepDef;
  host: Host;
}

// Ordered steps. Hermes runs on the account's user-host; its LLM key + XMPP
// credentials are injected as step env (never persisted by the app).
export const PROFILES: Record<string, ProfileStepDef[]> = {
  [STANDARD_ACCOUNT_PROFILE]: [
    { name: "linux-account", scriptRel: "account/ensure.sh", target: "user-host" },
    { name: "snikket-account", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
    { name: "hermes", scriptRel: "hermes/ensure.sh", target: "user-host" },
  ],
  [PASSWORD_SYNC_PROFILE]: [
    { name: "snikket-password", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
  ],
  [SHARED_CREDENTIALS_PROFILE]: [
    { name: "snikket-password", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
    { name: "hermes", scriptRel: "hermes/ensure.sh", target: "user-host" },
  ],
};

export interface ProvisionResult {
  jobId: number;
  status: JobStatus;
  failedStep?: string;
}

function snikketHost(db: ReturnType<typeof getDb>): Host {
  const h = getHostByName(db, SNIKKET_HOST_NAME);
  if (!h || !h.enabled) throw new Error(`snikket host '${SNIKKET_HOST_NAME}' not configured`);
  return h;
}

interface RunJobOpts {
  user: Pick<User, "id" | "username">;
  password: string;
  createdBy: number | null;
  profile: string;
  jobHostId: number;
  steps: StepRuntime[];
  // Hermes step configuration. apiKey omitted/empty => leave the existing key
  // in the agent's config alone (used by password reset).
  llm?: { baseUrl: string; model: string; apiKey?: string };
  xmppEnabled?: boolean;
  // Optional extra env exported to every step (e.g. HERMES_ACTION=stop).
  action?: string;
}

/** Runs an ordered set of steps inline, persisting an audit job + step logs. */
async function runJob(opts: RunJobOpts): Promise<ProvisionResult> {
  const db = getDb();
  const { user, password, createdBy, profile, jobHostId, steps } = opts;
  const job = createJob(db, { hostId: jobHostId, profile, createdBy });

  const stepRows = steps.map((s, seq) =>
    createJobStep(db, {
      jobId: job.id,
      seq,
      script: s.def.scriptRel,
      targetHostId: s.host.id,
      targetSsh: s.host.ssh_target,
    }),
  );

  let status: JobStatus = "succeeded";
  let failedStep: string | undefined;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const stepRow = stepRows[i];
    let exitCode = 0;
    let output = "";
    let ok = true;
    try {
      const script = await readFile(join(SCRIPTS_DIR, s.def.scriptRel), "utf8");
      const env: Record<string, string> = { USERNAME: user.username };
      if (opts.action) env.HERMES_ACTION = opts.action;
      if (s.def.target === "snikket-host") {
        env.SNIKKET_ACCOUNT_USERNAME = user.username;
        env.SNIKKET_ACCOUNT_PASSWORD = password;
      }
      if (s.def.name === "hermes") {
        const jid = `${user.username}@${XMPP_DOMAIN}`;
        env.HERMES_LLM_BASE_URL = opts.llm?.baseUrl ?? HERMES_LLM_BASE_URL;
        env.HERMES_MODEL = opts.llm?.model ?? HERMES_MODEL;
        if (opts.llm?.apiKey) env.HERMES_LLM_API_KEY = opts.llm.apiKey;
        if (opts.xmppEnabled) {
          env.XMPP_JID = jid;
          env.XMPP_PASSWORD = password;
          env.XMPP_ALLOWED_USERS = jid;
          env.XMPP_HOME_CHANNEL = jid;
          env.XMPP_HOST = XMPP_DOMAIN;
        }
      }
      const res = await runRemote({
        sshUser: SSH_USER,
        sshTarget: s.host.ssh_target,
        script,
        env,
        // hermes install/config pulls a python stack + browser the first time.
        timeoutMs: s.def.name === "hermes" ? 900_000 : 120_000,
      });
      exitCode = res.exitCode ?? 1;
      output = res.output;
      ok = res.exitCode === 0;
    } catch (err) {
      exitCode = 1;
      output = err instanceof Error ? err.message : String(err);
      ok = false;
    }
    finishJobStep(db, stepRow.id, ok ? "succeeded" : "failed", exitCode, output);
    if (!ok) {
      status = "failed";
      failedStep = s.def.name;
      break;
    }
  }
  finishJob(db, job.id, status);
  return { jobId: job.id, status, failedStep };
}

function stepsFor(
  db: ReturnType<typeof getDb>,
  profile: string,
  userHost: Host,
): StepRuntime[] {
  return PROFILES[profile].map((def) => ({
    def,
    host: def.target === "user-host" ? userHost : snikketHost(db),
  }));
}

/** Issues a per-user Bifrost virtual key and returns its id + one-time secret. */
async function issueVirtualKey(username: string) {
  return createVirtualKey({ name: username });
}

/**
 * Linux account on the chosen host + Snikket account (shared password) + Hermes
 * agent (Bifrost LLM key, XMPP) for the user. A fresh virtual key is issued for
 * the run and persisted (id only) on success; the previous key is deactivated.
 */
export async function provisionStandardAccount(opts: {
  user: Pick<User, "id" | "username">;
  hostId: number;
  password: string;
  createdBy: number | null;
}): Promise<ProvisionResult> {
  const db = getDb();
  const target = getHostById(db, opts.hostId);
  if (!target || !target.enabled) throw new Error("target host not found or disabled");

  let account = getAccountByUserHost(db, opts.user.id, target.id);
  if (!account) account = createAccount(db, opts.user.id, target.id);
  const previousVkId = account.bifrost_vk_id;

  const vk = await issueVirtualKey(opts.user.username);

  const result = await runJob({
    ...opts,
    profile: STANDARD_ACCOUNT_PROFILE,
    jobHostId: target.id,
    steps: stepsFor(db, STANDARD_ACCOUNT_PROFILE, target),
    llm: {
      baseUrl: HERMES_LLM_BASE_URL,
      model: HERMES_MODEL,
      apiKey: vk.value,
    },
    xmppEnabled: true,
  });

  if (result.status === "succeeded") {
    setAccountVkId(db, account.id, vk.id);
    if (previousVkId) {
      await setVirtualKeyActive(previousVkId, false).catch(() => undefined);
    }
    setAccountStatus(db, account.id, "active", result.jobId);
  } else {
    // The fresh key was never used by a successful run; retire it.
    await setVirtualKeyActive(vk.id, false).catch(() => undefined);
    setAccountStatus(db, account.id, "failed", result.jobId);
  }
  return result;
}

/**
 * Pushes the shared password to Snikket and to the user's Hermes XMPP config
 * (rotating the app/web password). The Hermes LLM key is NOT rotated -- only
 * reset-password uses this, and keeping the key avoids churn on the gateway.
 */
export async function syncSharedPassword(opts: {
  user: Pick<User, "id" | "username">;
  password: string;
  createdBy: number | null;
}): Promise<ProvisionResult> {
  const db = getDb();
  const host = snikketHost(db);
  const account = getAccountForUser(db, opts.user.id);
  if (!account) {
    throw new Error("account not provisioned; cannot sync Hermes credentials");
  }
  const steps = stepsFor(db, SHARED_CREDENTIALS_PROFILE, account.host);
  return runJob({
    ...opts,
    profile: SHARED_CREDENTIALS_PROFILE,
    jobHostId: host.id,
    steps,
    llm: { baseUrl: HERMES_LLM_BASE_URL, model: HERMES_MODEL },
    xmppEnabled: true,
  });
}

/** Re-pushes the shared password to Snikket only (used on disable). */
export async function syncSnikketPassword(opts: {
  user: Pick<User, "id" | "username">;
  password: string;
  createdBy: number | null;
}): Promise<ProvisionResult> {
  const db = getDb();
  const host = snikketHost(db);
  const steps: StepRuntime[] = PROFILES[PASSWORD_SYNC_PROFILE].map((def) => ({
    def,
    host,
  }));
  return runJob({ ...opts, profile: PASSWORD_SYNC_PROFILE, jobHostId: host.id, steps });
}

/**
 * Deactivates the user's Bifrost virtual key (blocks LLM access for their agent)
 * and stops the Hermes gateway on their host. Idempotent: safe to call even if
 * never provisioned.
 */
export async function deactivateUserAccess(opts: {
  user: Pick<User, "id" | "username">;
  createdBy: number | null;
}): Promise<void> {
  const db = getDb();
  const account = getAccountForUser(db, opts.user.id);
  if (account?.bifrost_vk_id) {
    await setVirtualKeyActive(account.bifrost_vk_id, false).catch(() => undefined);
  }
  if (account) {
    const step: StepRuntime = {
      def: { name: "hermes", scriptRel: "hermes/ensure.sh", target: "user-host" },
      host: account.host,
    };
    await runJob({
      user: opts.user,
      password: "",
      createdBy: opts.createdBy,
      profile: "hermes-stop",
      jobHostId: account.host_id,
      steps: [step],
      action: "stop",
    });
  }
}
