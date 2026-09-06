import { spawn } from "node:child_process";

export interface RunRemoteOptions {
  sshUser: string;
  sshTarget: string;
  script: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunRemoteResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs a script on a remote host as root: feeds the script (plus exported env
 * vars) to `ssh <user>@<target> 'sudo -n bash -s'`, streaming stdout/stderr
 * into a single captured log. Env vars travel only in the script stdin stream
 * (never argv and never logged), so secrets may be passed this way.
 */
export function runRemote(opts: RunRemoteOptions): Promise<RunRemoteResult> {
  const {
    sshUser,
    sshTarget,
    script,
    env = {},
    timeoutMs = 120_000,
  } = opts;

  return new Promise((resolve) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        `${sshUser}@${sshTarget}`,
        "sudo",
        "-n",
        "bash",
        "-s",
      ],
      { stdio: ["pipe", "pipe", "pipe"], detached: true },
    );

    const chunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        output: Buffer.concat(chunks).toString("utf8") + `\nssh error: ${err.message}`,
        timedOut,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        output: Buffer.concat(chunks).toString("utf8"),
        timedOut,
      });
    });

    // Feed env + script on stdin.
    const input: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      input.push(`export ${k}=${shq(v)}`);
    }
    input.push(script);
    child.stdin.write(input.join("\n"));
    child.stdin.end();
  });
}
