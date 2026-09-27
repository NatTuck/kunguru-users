import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAccount,
  createJob,
  createJobStep,
  finishJob,
  finishJobStep,
  generatePassword,
  getAccountByUserHost,
  getAccountForUser,
  getDb,
  getHostById,
  getHostByName,
  getJob,
  setAccountStatus,
  setAccountVkId,
  type Host,
  type JobStatus,
  type User,
} from "./db";
import {
  BASE_DOMAIN,
  GATEWAY_WG_IP,
  PORT_HERMES_WEBUI,
  PRIVATE_DOMAIN,
  SCRIPTS_DIR,
  SNIKKET_HOST_NAME,
  SSH_USER,
} from "./inventory";
import {
  createVirtualKey,
  deleteVirtualKey,
  HERMES_LLM_BASE_URL,
  HERMES_MODEL,
  setVirtualKeyActive,
  XMPP_DOMAIN,
} from "./bifrost";
import { runRemote } from "./transport/run";
import { reconcileUserSites } from "./nginx";

export const STANDARD_ACCOUNT_PROFILE = "standard-account";
// Snikket-only password push (disable neutralizes XMPP; reset rotates the
// tenant web/XMPP password -- the Hermes agent has its own account).
export const PASSWORD_SYNC_PROFILE = "password-sync";

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

// Ordered steps. The tenant gets a Linux account + Snikket account (their chat
// identity). A separate Snikket account ("<user>-agent") is the Hermes agent's
// XMPP identity -- tenants message it from their own account. Hermes runs on
// the account's user-host; its LLM key + agent XMPP creds are injected as step
// env (never persisted by the app).
export const PROFILES: Record<string, ProfileStepDef[]> = {
  [STANDARD_ACCOUNT_PROFILE]: [
    { name: "linux-account", scriptRel: "account/ensure.sh", target: "user-host" },
    { name: "snikket-account", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
    { name: "snikket-agent-account", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
    { name: "hermes", scriptRel: "hermes/ensure.sh", target: "user-host" },
    { name: "webui", scriptRel: "webui/ensure.sh", target: "user-host" },
  ],
  [PASSWORD_SYNC_PROFILE]: [
    { name: "snikket-password", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
  ],
};

/** XMPP identity for the tenant's Hermes agent (separate from the tenant). */
export function agentUsername(username: string): string {
  return `${username}-agent`;
}

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
  // Tenant web/XMPP password. Omitted on a repair that only needs to converge
  // the remaining steps: the tenant Snikket step then leaves an existing
  // account's password untouched.
  password?: string;
  // Force the tenant Snikket step to (re)set the password even when the account
  // already exists (explicit reset / enable after disable randomized it).
  forceTenantPassword?: boolean;
  createdBy: number | null;
  profile: string;
  jobHostId: number;
  steps: StepRuntime[];
  // When set, the job row was created up front (so a caller can return its id
  // and poll it while the run executes in the background); otherwise runJob
  // creates the row itself.
  jobId?: number;
  // Hermes agent configuration (user-host step). LLM apiKey is the freshly
  // issued per-user Bifrost key; agent = the agent's own XMPP account, which
  // the tenant (allowed user) messages.
  llm?: { apiKey: string };
  agent?: { username: string; password: string };
  // Optional extra env exported to every step (e.g. HERMES_ACTION=stop).
  action?: string;
}

/** Runs an ordered set of steps inline, persisting an audit job + step logs. */
async function runJob(opts: RunJobOpts): Promise<ProvisionResult> {
  const db = getDb();
  const { user, password, createdBy, profile, jobHostId, steps } = opts;
  const jobId =
    opts.jobId ??
    createJob(db, { hostId: jobHostId, profile, createdBy }).id;

  const stepRows = steps.map((s, seq) =>
    createJobStep(db, {
      jobId,
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
      if (s.def.name === "snikket-account" || s.def.name === "snikket-password") {
        env.SNIKKET_ACCOUNT_USERNAME = user.username;
        if (password) env.SNIKKET_ACCOUNT_PASSWORD = password;
        if (opts.forceTenantPassword || s.def.name === "snikket-password") {
          env.SNIKKET_ACCOUNT_FORCE = "1";
        }
      }
      if (s.def.name === "snikket-agent-account") {
        env.SNIKKET_ACCOUNT_USERNAME = opts.agent?.username ?? agentUsername(user.username);
        env.SNIKKET_ACCOUNT_PASSWORD = opts.agent?.password ?? password ?? "";
        // The agent's XMPP identity is internal; always converge it to the
        // password Hermes is configured with in this run.
        env.SNIKKET_ACCOUNT_FORCE = "1";
      }
      if (s.def.name === "hermes") {
        env.HERMES_LLM_BASE_URL = HERMES_LLM_BASE_URL;
        env.HERMES_MODEL = HERMES_MODEL;
        if (opts.llm?.apiKey) env.HERMES_LLM_API_KEY = opts.llm.apiKey;
        if (opts.agent) {
          env.XMPP_JID = `${opts.agent.username}@${XMPP_DOMAIN}`;
          env.XMPP_PASSWORD = opts.agent.password;
          env.XMPP_ALLOWED_USERS = `${user.username}@${XMPP_DOMAIN}`;
          env.XMPP_HOME_CHANNEL = `${user.username}@${XMPP_DOMAIN}`;
          env.XMPP_HOST = XMPP_DOMAIN;
        }
        // Tenant site-deployment facts for the kunguru-sites skill: the three
        // slot hostnames/ports (12000/13000/11000 + id; see server/sites.ts)
        // and the bind/trusted-proxy addresses for private slots.
        env.KUNGURU_USER_ID = String(user.id);
        if (BASE_DOMAIN) env.KUNGURU_BASE_DOMAIN = BASE_DOMAIN;
        env.KUNGURU_GATEWAY_WG_IP = GATEWAY_WG_IP;
        const coLocated = s.host.ssh_target === "localhost";
        env.KUNGURU_BIND_ADDR = coLocated ? "127.0.0.1" : s.host.ssh_target;
        env.KUNGURU_TRUSTED_PROXY = coLocated
          ? "127.0.0.1/32"
          : `${GATEWAY_WG_IP}/32`;
      }
      if (s.def.name === "webui") {
        // Per-user WebUI on `<user>-agent.users.<base>`: bound to the address
        // the gateway's nginx reaches (loopback when co-located), trusting only
        // the gateway as a proxy for the Remote-User header.
        const coLocated = s.host.ssh_target === "localhost";
        env.WEBUI_PORT = String(PORT_HERMES_WEBUI + user.id);
        env.WEBUI_HOST = coLocated ? "127.0.0.1" : s.host.ssh_target;
        env.WEBUI_TRUSTED_PROXIES = coLocated ? "127.0.0.1/32" : `${GATEWAY_WG_IP}/32`;
        if (PRIVATE_DOMAIN) env.WEBUI_LOGOUT_URL = `https://${PRIVATE_DOMAIN}/`;
      }
      const res = await runRemote({
        sshUser: SSH_USER,
        sshTarget: s.host.ssh_target,
        script,
        env,
        // hermes install/config pulls a python stack + browser the first time;
        // the webui step clones the WebUI repo on first run. Provisioning is a
        // background job now, so give the first install generous headroom: an
        // interrupted (timed-out) hermes install leaves a partial tree that
        // looks "installed" but cannot run.
        timeoutMs:
          s.def.name === "hermes"
            ? 3_600_000
            : s.def.name === "webui"
              ? 900_000
              : 120_000,
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
      // An aborted job never runs the remaining steps; settle their rows so
      // the UI shows "failed" instead of a spinner stuck on "running".
      for (let j = i + 1; j < steps.length; j++) {
        finishJobStep(db, stepRows[j].id, "failed", 1, "skipped: an earlier step failed");
      }
      break;
    }
  }
  finishJob(db, jobId, status);
  return { jobId, status, failedStep };
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

// Users with a standard-account run in flight (same process). Guards against a
// double-submit starting a second run that would race the first over ssh.
const inFlight = new Set<number>();

/**
 * Starts a standard-account profile (Linux account + Snikket tenant/agent +
 * Hermes + WebUI) for the user on the chosen host and returns its job id
 * immediately. The run continues in the background, updating the account
 * status when it finishes; callers poll GET /api/jobs/:id for progress.
 *
 * The whole profile always runs: every step is an idempotent `ensure`, so an
 * already-configured host is left alone and only missing pieces are completed.
 * Repair passes no tenant password, so the tenant Snikket step leaves the
 * existing password untouched; create/enable pass one (and enable forces it,
 * since disable intentionally randomized the XMPP credential).
 */
export function startStandardAccountProvision(opts: {
  user: Pick<User, "id" | "username">;
  hostId: number;
  createdBy: number | null;
  password?: string;
  forceTenantPassword?: boolean;
}): { jobId: number } {
  if (inFlight.has(opts.user.id)) {
    throw new Error("a provisioning run is already in progress for this user");
  }
  const db = getDb();
  const target = getHostById(db, opts.hostId);
  if (!target || !target.enabled) throw new Error("target host not found or disabled");

  let account = getAccountByUserHost(db, opts.user.id, target.id);
  if (!account) account = createAccount(db, opts.user.id, target.id);
  const previousVkId = account.bifrost_vk_id;

  const jobId = createJob(db, {
    hostId: target.id,
    profile: STANDARD_ACCOUNT_PROFILE,
    createdBy: opts.createdBy,
  }).id;

  inFlight.add(opts.user.id);
  void runStandardAccountProvision({
    user: opts.user,
    password: opts.password,
    forceTenantPassword: opts.forceTenantPassword,
    createdBy: opts.createdBy,
    target,
    accountId: account.id,
    previousVkId,
    jobId,
    steps: stepsFor(db, STANDARD_ACCOUNT_PROFILE, target),
  }).finally(() => inFlight.delete(opts.user.id));

  return { jobId };
}

/**
 * Background body of a standard-account run. Never throws: an unexpected
 * failure marks the (pre-created) job failed so polling observers terminate,
 * and the account failed so the UI offers Repair.
 */
async function runStandardAccountProvision(opts: {
  user: Pick<User, "id" | "username">;
  password?: string;
  forceTenantPassword?: boolean;
  createdBy: number | null;
  target: Host;
  accountId: number;
  previousVkId: string | null;
  jobId: number;
  steps: StepRuntime[];
}): Promise<void> {
  const db = getDb();
  let vk: { id: string; value: string } | null = null;
  try {
    vk = await issueVirtualKey(opts.user.username);
    const result = await runJob({
      user: opts.user,
      password: opts.password,
      forceTenantPassword: opts.forceTenantPassword,
      createdBy: opts.createdBy,
      profile: STANDARD_ACCOUNT_PROFILE,
      jobHostId: opts.target.id,
      jobId: opts.jobId,
      steps: opts.steps,
      llm: { apiKey: vk.value },
      agent: {
        username: agentUsername(opts.user.username),
        password: generatePassword(),
      },
    });

    if (result.status === "succeeded") {
      setAccountVkId(db, opts.accountId, vk.id);
      if (opts.previousVkId) {
        await setVirtualKeyActive(opts.previousVkId, false).catch(() => undefined);
      }
      setAccountStatus(db, opts.accountId, "active", result.jobId);
    } else {
      // The fresh key was never used by a successful run; remove it so failed
      // provisions do not leave deactivated orphans behind.
      await deleteVirtualKey(vk.id).catch(() => undefined);
      setAccountStatus(db, opts.accountId, "failed", result.jobId);
    }
  } catch (err) {
    if (vk) await deleteVirtualKey(vk.id).catch(() => undefined);
    const job = getJob(db, opts.jobId);
    if (job?.status === "running") finishJob(db, opts.jobId, "failed");
    setAccountStatus(db, opts.accountId, "failed", opts.jobId);
    console.error(`provision job ${opts.jobId} failed:`, err);
  }

  // Per-user site routes are derived from DB state; reconcile after every run
  // so a new/updated account's hostnames appear. Failure is not fatal.
  try {
    await reconcileUserSites();
  } catch (err) {
    console.error(`site reconcile after job ${opts.jobId} failed:`, err);
  }
}

/**
 * Pushes a literal XMPP message from the tenant's Hermes agent account
 * (`<user>-agent@<domain>`) to the tenant's own account, using the agent's
 * already-configured XMPP credentials on the user-host. This is a plain
 * `hermes send` -- the XMPP plugin's one-shot standalone sender, so there is no
 * LLM turn and the gateway need not be running. Runs inline (not an audit job)
 * and returns the captured output.
 */
export async function sendAgentXmppMessage(opts: {
  user: Pick<User, "id" | "username">;
  message: string;
}): Promise<{ ok: boolean; output: string }> {
  const db = getDb();
  const account = getAccountForUser(db, opts.user.id);
  if (!account) throw new Error("user has no provisioned account");
  const script = await readFile(join(SCRIPTS_DIR, "hermes/message.sh"), "utf8");
  const res = await runRemote({
    sshUser: SSH_USER,
    sshTarget: account.host.ssh_target,
    script,
    env: {
      USERNAME: opts.user.username,
      XMPP_MESSAGE: opts.message,
      XMPP_TARGET: `${opts.user.username}@${XMPP_DOMAIN}`,
    },
    // XMPP connect can take a while on a slow link (XMPP_CONNECT_TIMEOUT_SECS
    // defaults to 180s); allow headroom over that.
    timeoutMs: 240_000,
  });
  return { ok: res.exitCode === 0, output: res.output };
}

/** Re-pushes the shared password to Snikket only (used on reset/disable). */
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
