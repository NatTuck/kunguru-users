import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAccount,
  createJob,
  createJobStep,
  finishJob,
  finishJobStep,
  getAccountByUserHost,
  getDb,
  getHostById,
  getHostByName,
  setAccountStatus,
  type AccountStatus,
  type Host,
  type JobStatus,
  type User,
} from "./db";
import { SCRIPTS_DIR, SNIKKET_HOST_NAME, SSH_USER } from "./inventory";
import { runRemote } from "./transport/run";

export const STANDARD_ACCOUNT_PROFILE = "standard-account";
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

// Ordered steps. Extend later with hermes/webui/xmpp steps by editing this
// profile, not the runner.
export const PROFILES: Record<string, ProfileStepDef[]> = {
  [STANDARD_ACCOUNT_PROFILE]: [
    { name: "linux-account", scriptRel: "account/ensure.sh", target: "user-host" },
    { name: "snikket-account", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
  ],
  [PASSWORD_SYNC_PROFILE]: [
    { name: "snikket-password", scriptRel: "snikket/ensure-account.sh", target: "snikket-host" },
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

/** Runs an ordered set of steps inline, persisting an audit job + step logs. */
async function runJob(
  opts: {
    user: Pick<User, "id" | "username">;
    password: string;
    createdBy: number | null;
    profile: string;
    jobHostId: number;
    steps: StepRuntime[];
  },
): Promise<ProvisionResult> {
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
      if (s.def.target === "snikket-host") {
        env.SNIKKET_ACCOUNT_USERNAME = user.username;
        env.SNIKKET_ACCOUNT_PASSWORD = password;
      }
      const res = await runRemote({
        sshUser: SSH_USER,
        sshTarget: s.host.ssh_target,
        script,
        env,
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

/** Linux account on the chosen host + Snikket account (shared password). */
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

  const steps: StepRuntime[] = PROFILES[STANDARD_ACCOUNT_PROFILE].map((def) => ({
    def,
    host: def.target === "user-host" ? target : snikketHost(db),
  }));

  const result = await runJob({
    ...opts,
    profile: STANDARD_ACCOUNT_PROFILE,
    jobHostId: target.id,
    steps,
  });

  const accountStatus: AccountStatus = result.status === "succeeded" ? "active" : "failed";
  setAccountStatus(db, account.id, accountStatus, result.jobId);
  return result;
}

/** Re-pushes the shared password to Snikket only (used on password reset). */
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
