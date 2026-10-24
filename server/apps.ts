import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SCRIPTS_DIR, SSH_USER } from "./inventory";
import { runRemote, type RunRemoteResult } from "./transport/run";

// The two app slots every account gets (a user, or a group's Linux user). The
// units are **user units**, installed by scripts/account/ensure-apps.sh and
// driven as root through the account's user manager (scripts/account/
// app-control.sh). This module is the transport + parser; authorization lives
// in the routes.

export type AppSlot = "app" | "app-dev";
export const APP_SLOTS: AppSlot[] = ["app", "app-dev"];

export type AppAction = "enable" | "disable" | "restart";

export interface AppSlotStatus {
  slot: AppSlot;
  unit: string;
  /** systemd LoadState: loaded | not-found | error | unknown */
  load: string;
  /** UnitFileState: enabled | disabled | static | masked | unknown */
  enabled: string;
  /** ActiveState: active | inactive | failed | activating | unknown */
  active: string;
  sub: string;
  exitCode: number | null;
  result: string;
  installed: boolean;
}

export interface AppStatus {
  manager: boolean;
  slots: AppSlotStatus[];
}

interface Target {
  username: string;
  ssh_target: string;
}

function finalize(partial: Partial<AppSlotStatus>): AppSlotStatus {
  const slot = (partial.slot ?? "app") as AppSlot;
  const load = partial.load ?? "unknown";
  return {
    slot,
    unit: partial.unit ?? `${slot}.service`,
    load,
    enabled: partial.enabled ?? "unknown",
    active: partial.active ?? "unknown",
    sub: partial.sub ?? "unknown",
    exitCode: partial.exitCode ?? null,
    result: partial.result ?? "unknown",
    installed: load === "loaded",
  };
}

/**
 * Parse the `KEY=value` blocks printed by scripts/account/app-control.sh
 * (`MANAGER=`, then one `SLOT=` block per slot).
 */
export function parseAppStatus(output: string): AppStatus {
  let manager = false;
  const slots: AppSlotStatus[] = [];
  let current: Partial<AppSlotStatus> | null = null;

  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "MANAGER") {
      manager = value === "1";
      continue;
    }
    if (key === "SLOT") {
      if (current) slots.push(finalize(current));
      current = { slot: value as AppSlot, unit: `${value}.service` };
      continue;
    }
    if (!current) continue;
    switch (key) {
      case "UNIT":
        current.unit = value;
        break;
      case "LOAD":
        current.load = value;
        break;
      case "ENABLED":
        current.enabled = value;
        break;
      case "ACTIVE":
        current.active = value;
        break;
      case "SUB":
        current.sub = value;
        break;
      case "EXIT":
        current.exitCode = value === "" ? null : Number(value);
        break;
      case "RESULT":
        current.result = value;
        break;
    }
  }
  if (current) slots.push(finalize(current));
  return { manager, slots };
}

async function runControl(
  target: Target,
  env: Record<string, string>,
): Promise<RunRemoteResult> {
  const script = await readFile(
    join(SCRIPTS_DIR, "account/app-control.sh"),
    "utf8",
  );
  return runRemote({
    sshUser: SSH_USER,
    sshTarget: target.ssh_target,
    script,
    env: { USERNAME: target.username, ...env },
    timeoutMs: 60_000,
  });
}

/** Current state of both app slots for an account. */
export async function getAppStatus(target: Target): Promise<AppStatus> {
  const res = await runControl(target, {
    KUNGURU_APP_SLOT: "all",
    KUNGURU_APP_ACTION: "status",
  });
  if (res.exitCode !== 0) {
    throw new Error(
      res.output.trim() || `could not read app slots (exit ${res.exitCode})`,
    );
  }
  return parseAppStatus(res.output);
}

/** Enable (start at boot + now), disable (stop + no boot), or restart one slot. */
export async function controlApp(
  target: Target,
  slot: AppSlot,
  action: AppAction,
): Promise<{ ok: boolean; output: string }> {
  const res = await runControl(target, {
    KUNGURU_APP_SLOT: slot,
    KUNGURU_APP_ACTION: action,
  });
  return { ok: res.exitCode === 0, output: res.output };
}

/** Recent journal lines for one slot. */
export async function getAppLogs(
  target: Target,
  slot: AppSlot,
  lines: number,
): Promise<{ ok: boolean; output: string }> {
  const res = await runControl(target, {
    KUNGURU_APP_SLOT: slot,
    KUNGURU_APP_ACTION: "logs",
    KUNGURU_APP_LINES: String(lines),
  });
  return { ok: res.exitCode === 0, output: res.output };
}
