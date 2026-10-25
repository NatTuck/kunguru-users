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
  getJobSteps,
  getUserById,
  listActiveAccountUsers,
  listGroupMembers,
  setAccountAgentInfo,
  setAccountModel,
  setAccountStatus,
  setAccountVkId,
  type Account,
  type Host,
  type JobStatus,
  type User,
} from "./db";
import {
  BASE_DOMAIN,
  GATEWAY_WG_IP,
  PORT_APP,
  PORT_APP_DEV,
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
import { getIdentitySigner } from "./identity";
import { runRemote } from "./transport/run";
import { reconcileSites } from "./nginx";
import { APP_SLOTS, controlApp } from "./apps";

export const STANDARD_ACCOUNT_PROFILE = "standard-account";
// Lean standardize/upgrade: force the agent to the stable channel, update it,
// repoint/refresh the WebUI, and (on the hermes step) install plugin deps,
// reconcile the model, and retire the legacy venv. Deliberately excludes the
// account/snikket steps so credentials and XMPP identities are untouched.
export const AGENT_UPDATE_PROFILE = "agent-update";
// Snikket-only password push (disable neutralizes XMPP; reset rotates the
// tenant web/XMPP password -- the Hermes agent has its own account).
export const PASSWORD_SYNC_PROFILE = "password-sync";
// Switch a tenant's default model and restart the agent gateway + WebUI.
export const MODEL_SET_PROFILE = "model-set";
// Create/converge a group account: the Linux user+group that backs a group and
// its two app slots. Group Hermes (root profile, SOUL.md, WebUI map) is a
// separate, explicit run (`GROUP_HERMES_PROFILE`); membership converges
// separately after any membership change.
export const GROUP_ACCOUNT_PROFILE = "group-account";
// Provision a group's agent: the agent XMPP account, Hermes (root profile in
// the group home), the WebUI pinned to the root profile, and the SOUL.md
// roster. Slow (first Hermes install), so it runs as a background job.
export const GROUP_HERMES_PROFILE = "group-hermes";

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
    // The two app slots (code dirs + user units) are per account, not per
    // service: install them as soon as the Linux account exists.
    { name: "app-slots", scriptRel: "account/ensure-apps.sh", target: "user-host" },
    { name: "snikket-account", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
    { name: "snikket-agent-account", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
    { name: "hermes", scriptRel: "hermes/ensure.sh", target: "user-host" },
    { name: "webui", scriptRel: "webui/ensure.sh", target: "user-host" },
  ],
  [PASSWORD_SYNC_PROFILE]: [
    { name: "snikket-password", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
  ],
  [MODEL_SET_PROFILE]: [
    { name: "hermes-model", scriptRel: "hermes/set-model.sh", target: "user-host" },
  ],
  [GROUP_ACCOUNT_PROFILE]: [
    { name: "linux-group", scriptRel: "account/ensure-group.sh", target: "user-host" },
    { name: "app-slots", scriptRel: "account/ensure-apps.sh", target: "user-host" },
  ],
  [GROUP_HERMES_PROFILE]: [
    { name: "snikket-agent-account", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
    { name: "hermes", scriptRel: "hermes/ensure.sh", target: "user-host" },
    { name: "webui", scriptRel: "webui/ensure.sh", target: "user-host" },
    { name: "soul", scriptRel: "hermes/ensure-soul.sh", target: "user-host" },
  ],
  [AGENT_UPDATE_PROFILE]: [
    { name: "hermes", scriptRel: "hermes/ensure.sh", target: "user-host" },
    { name: "webui", scriptRel: "webui/ensure.sh", target: "user-host" },
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
  // Per-tenant default Hermes model. Omitted falls back to the instance-wide
  // HERMES_MODEL. Only consumed by the `hermes` and `hermes-model` steps.
  model?: string;
  // When true, the `hermes` step runs in update mode (HERMES_UPDATE=1): record
  // the stable channel, upgrade the agent, and retire the legacy venv.
  update?: boolean;
  // Optional extra env exported to every step (e.g. HERMES_ACTION=stop).
  action?: string;
  // Account kind (user | group). A group's hermes step installs the
  // shared-session identity hook plugin; a user's does not.
  accountKind?: "user" | "group";
  // Group agents: the JIDs the agent answers, the JID for proactive messages
  // (normally the group owner), the member usernames for SOUL.md, and the
  // WebUI profile map pinning sessions to the root profile.
  xmppAllowed?: string[];
  xmppHome?: string;
  groupMembers?: string[];
  webuiGroupMap?: string;
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
      if (s.def.name === "app-slots") {
        // The account's app slots: deterministic ports, and the address the
        // gateway reaches (loopback when co-located, else the host's VPN/LAN
        // address). Host-agnostic: one-host and gateway+user-server both work.
        const coLocated = s.host.ssh_target === "localhost";
        env.KUNGURU_APP_PORT = String(PORT_APP + user.id);
        env.KUNGURU_APP_DEV_PORT = String(PORT_APP_DEV + user.id);
        env.KUNGURU_BIND_ADDR = coLocated ? "127.0.0.1" : s.host.ssh_target;
      }
      if (s.def.name === "hermes") {
        env.HERMES_LLM_BASE_URL = HERMES_LLM_BASE_URL;
        env.HERMES_MODEL = opts.model ?? HERMES_MODEL;
        if (opts.update) env.HERMES_UPDATE = "1";
        if (opts.llm?.apiKey) env.HERMES_LLM_API_KEY = opts.llm.apiKey;
        if (opts.agent) {
          env.XMPP_JID = `${opts.agent.username}@${XMPP_DOMAIN}`;
          env.XMPP_PASSWORD = opts.agent.password;
          env.XMPP_ALLOWED_USERS = (
            opts.xmppAllowed && opts.xmppAllowed.length > 0
              ? opts.xmppAllowed
              : [`${user.username}@${XMPP_DOMAIN}`]
          ).join(" ");
          env.XMPP_HOME_CHANNEL =
            opts.xmppHome ?? `${user.username}@${XMPP_DOMAIN}`;
          env.XMPP_HOST = XMPP_DOMAIN;
        }
        // Tenant site-deployment facts for the kunguru-sites skill: the two app
        // slots + WebUI (12000/13000/11000 + id; see server/sites.ts) and the
        // bind/trusted-proxy addresses.
        env.KUNGURU_USER_ID = String(user.id);
        // Groups install the shared-session identity hook plugin; users do not.
        env.KUNGURU_ACCOUNT_KIND = opts.accountKind ?? "user";
        if (BASE_DOMAIN) env.KUNGURU_BASE_DOMAIN = BASE_DOMAIN;
        env.KUNGURU_GATEWAY_WG_IP = GATEWAY_WG_IP;
        // Public verification key for X-Kunguru-Identity (not a secret).
        env.KUNGURU_IDENTITY_PUBKEY_DER = getIdentitySigner().publicKeyDer;
        const coLocated = s.host.ssh_target === "localhost";
        env.KUNGURU_BIND_ADDR = coLocated ? "127.0.0.1" : s.host.ssh_target;
        env.KUNGURU_TRUSTED_PROXY = coLocated
          ? "127.0.0.1/32"
          : `${GATEWAY_WG_IP}/32`;
      }
      if (s.def.name === "hermes-model") {
        env.HERMES_MODEL = opts.model ?? HERMES_MODEL;
      }
      if (s.def.name === "soul") {
        env.KUNGURU_GROUP_MEMBERS = (opts.groupMembers ?? []).join(" ");
        env.KUNGURU_XMPP_DOMAIN = XMPP_DOMAIN;
      }
      if (s.def.name === "webui") {
        // Per-account WebUI on `<account>-agent.<base>`: bound to the address
        // the gateway's nginx reaches (loopback when co-located), trusting only
        // the gateway as a proxy for the Remote-User header.
        const coLocated = s.host.ssh_target === "localhost";
        env.WEBUI_PORT = String(PORT_HERMES_WEBUI + user.id);
        env.WEBUI_HOST = coLocated ? "127.0.0.1" : s.host.ssh_target;
        env.WEBUI_TRUSTED_PROXIES = coLocated ? "127.0.0.1/32" : `${GATEWAY_WG_IP}/32`;
        // The WebUI keeps its own model selection (per session + browser), so it
        // does not follow the agent's model.default. Export the account's model
        // as HERMES_WEBUI_DEFAULT_MODEL or the WebUI would stay on the
        // instance-wide default.
        env.WEBUI_DEFAULT_MODEL = opts.model ?? HERMES_MODEL;
        if (PRIVATE_DOMAIN) env.WEBUI_LOGOUT_URL = `https://${PRIVATE_DOMAIN}/`;
        // A group WebUI pins every member's session to the root profile.
        if (opts.webuiGroupMap) env.WEBUI_GROUP_PROFILE_MAP = opts.webuiGroupMap;
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
    model: account.hermes_model ?? undefined,
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
  model?: string;
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
      model: opts.model,
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
      // Reconcile the stored model + fleet view from the run's markers.
      reconcileFromJobOutput(db, opts.accountId, result.jobId);
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

  // Site routing (account hosts + every host's static listener) is derived
  // from DB state; reconcile after every run so a new/updated account's
  // hostnames and static sites appear. Failure is not fatal.
  try {
    await reconcileSites();
  } catch (err) {
    console.error(`site reconcile after job ${opts.jobId} failed:`, err);
  }
}

export interface GroupProvisionResult {
  ok: boolean;
  jobId: number;
  status: JobStatus;
  failedStep?: string;
  output: string;
}

/**
 * Creates/converges a group account on a host: the Linux user+group, the shared
 * home, and the two app slots. Runs inline (a group converge is seconds, not
 * the minutes a Hermes install takes) and returns the step log so the caller
 * can surface a failure. Membership is converged afterwards.
 */
export async function provisionGroup(opts: {
  group: Pick<User, "id" | "username">;
  hostId: number;
  createdBy: number | null;
}): Promise<GroupProvisionResult> {
  const db = getDb();
  const host = getHostById(db, opts.hostId);
  if (!host || !host.enabled) throw new Error("target host not found or disabled");

  let account = getAccountByUserHost(db, opts.group.id, host.id);
  if (!account) account = createAccount(db, opts.group.id, host.id);

  const jobId = createJob(db, {
    hostId: host.id,
    profile: GROUP_ACCOUNT_PROFILE,
    createdBy: opts.createdBy,
  }).id;
  const steps = PROFILES[GROUP_ACCOUNT_PROFILE].map((def) => ({
    def,
    host,
  }));
  const result = await runJob({
    user: opts.group,
    createdBy: opts.createdBy,
    profile: GROUP_ACCOUNT_PROFILE,
    jobHostId: host.id,
    jobId,
    steps,
  });
  setAccountStatus(
    db,
    account.id,
    result.status === "succeeded" ? "active" : "failed",
    result.jobId,
  );

  let membership: { ok: boolean; output: string } | null = null;
  if (result.status === "succeeded") {
    membership = await ensureGroupMembership(opts.group);
  }

  const output = getJobSteps(db, result.jobId)
    .map((s) => `[${s.script}]\n${(s.output_log ?? "").trim()}`)
    .join("\n");
  try {
    await reconcileSites();
  } catch (err) {
    console.error(`site reconcile after group job ${result.jobId} failed:`, err);
  }
  return {
    ok: result.status === "succeeded" && (membership?.ok ?? true),
    jobId: result.jobId,
    status: result.status,
    failedStep: result.failedStep,
    output: membership
      ? `${output}\n[membership]\n${membership.output.trim()}`
      : output,
  };
}

/**
 * Converges the Linux group membership to the app's `group_members` rows. Safe
 * to call after any membership change; a failure is returned, not thrown.
 */
export async function ensureGroupMembership(
  group: Pick<User, "id" | "username">,
): Promise<{ ok: boolean; output: string }> {
  const db = getDb();
  const account = getAccountForUser(db, group.id);
  if (!account) {
    return { ok: false, output: "group has no provisioned account" };
  }
  const members = listGroupMembers(db, group.id).map((m) => m.username);
  const script = await readFile(
    join(SCRIPTS_DIR, "account/ensure-membership.sh"),
    "utf8",
  );
  const res = await runRemote({
    sshUser: SSH_USER,
    sshTarget: account.host.ssh_target,
    script,
    env: {
      USERNAME: group.username,
      KUNGURU_GROUP_MEMBERS: members.join(" "),
    },
    timeoutMs: 120_000,
  });

  // If the group agent is provisioned, membership changes also converge its
  // roster (SOUL.md) and XMPP allowlist, and restart the gateway.
  let soul: { ok: boolean; output: string } | null = null;
  if (account.bifrost_vk_id) {
    try {
      const soulScript = await readFile(
        join(SCRIPTS_DIR, "hermes/ensure-soul.sh"),
        "utf8",
      );
      const soulRes = await runRemote({
        sshUser: SSH_USER,
        sshTarget: account.host.ssh_target,
        script: soulScript,
        env: {
          USERNAME: group.username,
          KUNGURU_GROUP_MEMBERS: members.join(" "),
          KUNGURU_XMPP_DOMAIN: XMPP_DOMAIN,
        },
        timeoutMs: 120_000,
      });
      soul = { ok: soulRes.exitCode === 0, output: soulRes.output };
    } catch (err) {
      soul = {
        ok: false,
        output: err instanceof Error ? err.message : "SOUL converge failed",
      };
    }
  }

  return {
    ok: res.exitCode === 0 && (soul?.ok ?? true),
    output: res.output + (soul ? `\n[soul]\n${soul.output}` : ""),
  };
}

/**
 * Starts (or re-runs) a group's agent: agent XMPP account, Hermes root profile,
 * WebUI pinned to the root profile, and the SOUL.md roster. Heavy (a first
 * Hermes install), so it runs as a background job the caller polls.
 */
export function startGroupAgent(opts: {
  group: Pick<User, "id" | "username">;
  createdBy: number | null;
}): { jobId: number } {
  const db = getDb();
  const account = getAccountForUser(db, opts.group.id);
  if (!account) {
    throw new Error("group has no provisioned account; provision it first");
  }
  if (account.status !== "active") {
    throw new Error("group account is not active; provision it first");
  }
  const host = getHostById(db, account.host_id);
  if (!host) throw new Error("host not found");
  if (inFlight.has(opts.group.id)) {
    throw new Error("a provisioning run is already in progress for this group");
  }
  const jobId = createJob(db, {
    hostId: host.id,
    profile: GROUP_HERMES_PROFILE,
    createdBy: opts.createdBy,
  }).id;
  inFlight.add(opts.group.id);
  void runGroupAgent(db, opts.group, account, host, opts.createdBy, jobId)
    .catch((err) => console.error(`group-hermes job ${jobId} failed:`, err))
    .finally(() => inFlight.delete(opts.group.id));
  return { jobId };
}

async function runGroupAgent(
  db: ReturnType<typeof getDb>,
  group: Pick<User, "id" | "username">,
  account: Account,
  host: Host,
  createdBy: number | null,
  jobId: number,
): Promise<void> {
  const members = listGroupMembers(db, group.id);
  const groupRow = getUserById(db, group.id);
  const owner =
    groupRow?.owner_user_id != null
      ? getUserById(db, groupRow.owner_user_id)
      : undefined;
  const ownerJid = owner ? `${owner.username}@${XMPP_DOMAIN}` : undefined;

  let vk: { id: string; value: string } | null = null;
  try {
    vk = await issueVirtualKey(group.username);
    const steps: StepRuntime[] = PROFILES[GROUP_HERMES_PROFILE].map((def) => ({
      def,
      host: def.target === "user-host" ? host : snikketHost(db),
    }));
    const result = await runJob({
      user: group,
      createdBy,
      profile: GROUP_HERMES_PROFILE,
      jobHostId: host.id,
      jobId,
      steps,
      accountKind: "group",
      model: account.hermes_model ?? undefined,
      llm: { apiKey: vk.value },
      agent: {
        username: agentUsername(group.username),
        password: generatePassword(),
      },
      xmppAllowed: members.map((m) => `${m.username}@${XMPP_DOMAIN}`),
      xmppHome: ownerJid,
      groupMembers: members.map((m) => m.username),
      webuiGroupMap: JSON.stringify({ [group.username]: "default" }),
    });
    if (result.status === "succeeded") {
      setAccountVkId(db, account.id, vk.id);
      if (account.bifrost_vk_id) {
        await setVirtualKeyActive(account.bifrost_vk_id, false).catch(
          () => undefined,
        );
      }
      reconcileFromJobOutput(db, account.id, result.jobId);
    } else {
      await deleteVirtualKey(vk.id).catch(() => undefined);
    }
  } catch (err) {
    if (vk) await deleteVirtualKey(vk.id).catch(() => undefined);
    const job = getJob(db, jobId);
    if (job?.status === "running") finishJob(db, jobId, "failed");
    console.error(`group-hermes job ${jobId} failed:`, err);
  }
}

/**
 * Sends a literal XMPP message from a group's agent account to one member.
 * Used by the app's message-as-agent action (a member picker), since a group
 * agent has no single home channel.
 */
export async function sendGroupAgentMessage(opts: {
  group: Pick<User, "id" | "username">;
  target: string;
  message: string;
}): Promise<{ ok: boolean; output: string }> {
  const db = getDb();
  const account = getAccountForUser(db, opts.group.id);
  if (!account) throw new Error("group has no provisioned account");
  const script = await readFile(join(SCRIPTS_DIR, "hermes/message.sh"), "utf8");
  const res = await runRemote({
    sshUser: SSH_USER,
    sshTarget: account.host.ssh_target,
    script,
    env: {
      USERNAME: opts.group.username,
      XMPP_MESSAGE: opts.message,
      XMPP_TARGET: `${opts.target}@${XMPP_DOMAIN}`,
    },
    timeoutMs: 240_000,
  });
  return { ok: res.exitCode === 0, output: res.output };
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
 * Best-effort restart of a tenant's Hermes WebUI. When `model` is given it also
 * drops the tenant's cached model catalog, persists the new default and
 * repoints existing WebUI sessions (the WebUI resolves its own per-session
 * model ahead of the configured default). Failures are logged only: the model
 * change (and its persistence) must not be undone by a WebUI hiccup.
 */
async function restartWebui(
  user: Pick<User, "username">,
  host: Host,
  model: string,
): Promise<void> {
  let script: string;
  try {
    script = await readFile(join(SCRIPTS_DIR, "webui/restart.sh"), "utf8");
  } catch {
    return;
  }
  const res = await runRemote({
    sshUser: SSH_USER,
    sshTarget: host.ssh_target,
    script,
    env: { USERNAME: user.username, WEBUI_DEFAULT_MODEL: model },
    timeoutMs: 60_000,
  });
  if (res.exitCode !== 0) {
    console.error(`webui restart for ${user.username} failed: ${res.output.trim()}`);
  }
}

/**
 * Switches a provisioned tenant's default Hermes model (a Bifrost
 * `provider/name` id) and restarts their agent gateway + WebUI so the change
 * takes effect. Runs inline and records an audit job; the account's stored
 * model is updated only on success, so a failed run leaves the previous choice
 * intact (a later Repair also re-applies the stored value).
 */
export async function applyUserModel(opts: {
  user: Pick<User, "id" | "username">;
  model: string;
  createdBy: number | null;
}): Promise<ProvisionResult> {
  if (inFlight.has(opts.user.id)) {
    throw new Error("a provisioning run is already in progress for this user");
  }
  const db = getDb();
  const account = getAccountForUser(db, opts.user.id);
  if (!account) throw new Error("user has no provisioned account");
  if (account.status !== "active") {
    throw new Error("account is not active; provision it first");
  }

  const steps: StepRuntime[] = PROFILES[MODEL_SET_PROFILE].map((def) => ({
    def,
    host: account.host,
  }));

  inFlight.add(opts.user.id);
  try {
    const result = await runJob({
      user: opts.user,
      createdBy: opts.createdBy,
      profile: MODEL_SET_PROFILE,
      jobHostId: account.host_id,
      steps,
      model: opts.model,
    });
    if (result.status === "succeeded") {
      setAccountModel(db, account.id, opts.model);
      // Drop the WebUI's cached catalog and repoint its sessions too; a failure
      // here does not undo the model change or block persistence.
      await restartWebui(opts.user, account.host, opts.model);
    }
    return result;
  } finally {
    inFlight.delete(opts.user.id);
  }
}

// --- Standardize / agent update (stable channel + PM venv) ---

function marker(text: string, key: string): string | null {
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  const v = m?.[1]?.trim();
  return v ? v : null;
}

// Reconcile an account's stored model + fleet view from the machine-readable
// markers a hermes/ensure.sh run prints (`KEY=value` lines).
function reconcileFromJobOutput(
  db: ReturnType<typeof getDb>,
  accountId: number,
  jobId: number,
): void {
  const output = getJobSteps(db, jobId)
    .map((s) => s.output_log ?? "")
    .join("\n");
  const actualModel = marker(output, "HERMES_MODEL_ACTUAL");
  if (actualModel) setAccountModel(db, accountId, actualModel);
  const channel = marker(output, "HERMES_CHANNEL");
  const version = marker(output, "HERMES_AGENT_VERSION");
  const venvKind = marker(output, "HERMES_VENV_KIND");
  if (channel || version || venvKind) {
    setAccountAgentInfo(db, accountId, {
      ...(channel ? { channel } : {}),
      ...(version ? { version } : {}),
      ...(venvKind ? { venvKind } : {}),
    });
  }
}

async function runAgentUpdate(
  db: ReturnType<typeof getDb>,
  user: Pick<User, "id" | "username">,
  account: Account,
  host: Host,
  createdBy: number | null,
  jobId: number,
): Promise<ProvisionResult> {
  const steps: StepRuntime[] = PROFILES[AGENT_UPDATE_PROFILE].map((def) => ({
    def,
    host,
  }));
  const result = await runJob({
    user,
    createdBy,
    profile: AGENT_UPDATE_PROFILE,
    jobHostId: host.id,
    jobId,
    steps,
    update: true,
    // ensure.sh only seeds model.default when the host has none, so this is the
    // fallback for a host that has never had one; otherwise it is reconciled.
    model: account.hermes_model ?? undefined,
  });
  reconcileFromJobOutput(db, account.id, jobId);
  return result;
}

/**
 * Starts the lean agent-update profile for one tenant: force the stable update
 * channel, upgrade the agent, repoint/refresh the WebUI, install plugin deps,
 * reconcile the model, and retire the legacy venv. Runs in the background;
 * callers poll GET /api/jobs/:id. Refuses if a run is already in flight.
 */
export function startAgentUpdate(opts: {
  user: Pick<User, "id" | "username">;
  createdBy: number | null;
}): { jobId: number } {
  const db = getDb();
  const account = getAccountForUser(db, opts.user.id);
  if (!account) throw new Error("user has no provisioned account");
  if (account.status !== "active") {
    throw new Error("account is not active; provision it first");
  }
  const host = getHostById(db, account.host_id);
  if (!host) throw new Error("host not found");
  if (inFlight.has(opts.user.id)) {
    throw new Error("a provisioning run is already in progress for this user");
  }
  const jobId = createJob(db, {
    hostId: host.id,
    profile: AGENT_UPDATE_PROFILE,
    createdBy: opts.createdBy,
  }).id;
  inFlight.add(opts.user.id);
  void runAgentUpdate(db, opts.user, account, host, opts.createdBy, jobId)
    .catch((err) => console.error(`agent-update job ${jobId} failed:`, err))
    .finally(() => inFlight.delete(opts.user.id));
  return { jobId };
}

export interface FleetUpdateState {
  running: boolean;
  total: number;
  done: number;
  current: string | null;
  startedAt: number | null;
  results: { username: string; jobId: number | null; status: string }[];
}

let fleetUpdate: FleetUpdateState = {
  running: false,
  total: 0,
  done: 0,
  current: null,
  startedAt: null,
  results: [],
};

export function getFleetUpdateState(): FleetUpdateState {
  return fleetUpdate;
}

/**
 * Starts a serialized fleet-wide agent update: one tenant at a time (each is a
 * heavy git pull + restart). Returns immediately; progress is exposed via
 * getFleetUpdateState(). Refuses if a fleet run is already in progress.
 */
export function startFleetAgentUpdate(opts: { createdBy: number | null }): {
  started: boolean;
  total: number;
} {
  if (fleetUpdate.running) throw new Error("a fleet update is already running");
  const db = getDb();
  const targets = listActiveAccountUsers(db);
  fleetUpdate = {
    running: true,
    total: targets.length,
    done: 0,
    current: null,
    startedAt: Date.now(),
    results: [],
  };
  void (async () => {
    for (const t of targets) {
      const account = getAccountForUser(db, t.id);
      const host = account ? getHostById(db, account.host_id) : undefined;
      if (!account || !host || account.status !== "active") {
        fleetUpdate.results.push({ username: t.username, jobId: null, status: "skipped" });
        fleetUpdate.done += 1;
        continue;
      }
      fleetUpdate.current = t.username;
      if (inFlight.has(t.id)) {
        fleetUpdate.results.push({ username: t.username, jobId: null, status: "busy" });
        fleetUpdate.done += 1;
        continue;
      }
      let jobId: number | null = null;
      try {
        jobId = createJob(db, {
          hostId: host.id,
          profile: AGENT_UPDATE_PROFILE,
          createdBy: opts.createdBy,
        }).id;
        inFlight.add(t.id);
        const res = await runAgentUpdate(
          db,
          { id: t.id, username: t.username },
          account,
          host,
          opts.createdBy,
          jobId,
        );
        fleetUpdate.results.push({ username: t.username, jobId, status: res.status });
      } catch (err) {
        fleetUpdate.results.push({ username: t.username, jobId, status: "error" });
        console.error(`fleet agent-update ${t.username} failed:`, err);
      } finally {
        inFlight.delete(t.id);
        fleetUpdate.done += 1;
      }
    }
    fleetUpdate.running = false;
    fleetUpdate.current = null;
  })();
  return { started: true, total: targets.length };
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
    // A disabled account must not keep serving its app slots. `disable` also
    // drops the boot enablement, so a host reboot cannot bring them back.
    for (const slot of APP_SLOTS) {
      try {
        await controlApp(
          { username: opts.user.username, ssh_target: account.host.ssh_target },
          slot,
          "disable",
        );
      } catch (err) {
        console.error(
          `could not stop the ${slot} slot for ${opts.user.username}:`,
          err,
        );
      }
    }
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
