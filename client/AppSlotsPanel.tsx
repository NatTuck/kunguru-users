import { useEffect, useState } from "react";
import { Alert, Button, Spinner } from "@heroui/react";
import { get, post } from "./api";
import { appDevUrl, appUrl, useConfigStore } from "./configStore";
import type { AppSlot, AppSlotStatus, AppStatus } from "./types";
import { StatusChip } from "./ui";

// The two app slots of one account. Works for a user and for a group (the API
// authorizes admins, the account itself, and group members). Each slot is a
// user unit the platform installs; this panel is the control surface:
// state, enable/disable, restart, and logs.

const SLOTS: AppSlot[] = ["app", "app-dev"];

const SLOT_LABEL: Record<AppSlot, string> = {
  app: "App",
  "app-dev": "App (dev)",
};

function urlFor(
  slot: AppSlot,
  baseDomain: string,
  username: string,
): string | null {
  if (!baseDomain || !username) return null;
  return slot === "app"
    ? appUrl(baseDomain, username)
    : appDevUrl(baseDomain, username);
}

function activeTone(
  s: AppSlotStatus,
): "success" | "warning" | "danger" | "neutral" {
  if (!s.installed) return "danger";
  if (s.active === "active") return "success";
  if (s.active === "failed") return "danger";
  if (s.active === "activating" || s.active === "deactivating") return "warning";
  return "neutral";
}

// A slot with no `run` script is installed and enabled but stays inactive; the
// unit reports Result=condition.
function waitingForRun(s: AppSlotStatus): boolean {
  return s.installed && s.active !== "active" && s.result === "condition";
}

export default function AppSlotsPanel({ accountId }: { accountId: number }) {
  const config = useConfigStore((s) => s.config);
  const baseDomain = config?.baseDomain ?? "";

  const [status, setStatus] = useState<AppStatus | null>(null);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logsFor, setLogsFor] = useState<AppSlot | null>(null);
  const [logs, setLogs] = useState("");

  const load = async () => {
    try {
      const d = await get<AppStatus & { account: { username: string } }>(
        `/api/accounts/${accountId}/apps`,
      );
      setStatus({ manager: d.manager, slots: d.slots });
      setUsername(d.account.username);
      setError(null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "failed to read the app slots",
      );
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const act = async (
    slot: AppSlot,
    action: "enable" | "disable" | "restart",
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await post<
        { ok: boolean; output: string } & Partial<AppStatus>
      >(`/api/accounts/${accountId}/apps`, { slot, action });
      if (r.slots) setStatus({ manager: r.manager ?? false, slots: r.slots });
      if (!r.ok) {
        setNotice(
          `${action} did not succeed: ${r.output.trim() || "no output"}`,
        );
      }
      if (logsFor === slot) await showLogs(slot);
    } catch (e) {
      setError(e instanceof Error ? e.message : `${action} failed`);
    } finally {
      setBusy(false);
    }
  };

  const showLogs = async (slot: AppSlot) => {
    try {
      const r = await get<{ ok: boolean; output: string }>(
        `/api/accounts/${accountId}/apps/${slot}/logs?lines=200`,
      );
      setLogs(r.output);
      setLogsFor(slot);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to read the logs");
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {notice && (
        <Alert status="warning">
          <Alert.Content>
            <Alert.Description>{notice}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-500">
          Each slot runs <span className="font-mono">run</span> from its
          directory. The platform installs the units and their port and bind
          address.
        </p>
        <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void load()}>
          Refresh
        </Button>
      </div>

      {status == null ? (
        <Spinner size="sm" />
      ) : (
        <>
          {!status.manager && (
            <Alert status="warning">
              <Alert.Content>
                <Alert.Description>
                  This account&apos;s user manager is not reachable, so the app
                  slots cannot be started or stopped. Provision the account (or
                  re-run its repair) to enable lingering.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          )}

          {SLOTS.map((slot) => {
            const s = status.slots.find((x) => x.slot === slot);
            const url = urlFor(slot, baseDomain, username);
            return (
              <div
                key={slot}
                className="rounded-xl border border-neutral-200 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{SLOT_LABEL[slot]}</span>
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-sm break-all hover:underline"
                      >
                        {url.replace(/^https:\/\//, "").replace(/\/$/, "")}
                      </a>
                    ) : (
                      <span className="font-mono text-sm text-neutral-400">
                        {username}.{baseDomain || "<base>"}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!status.manager ? (
                      <StatusChip label="unavailable" tone="neutral" />
                    ) : s == null || !s.installed ? (
                      <StatusChip label="not installed" tone="danger" />
                    ) : (
                      <>
                        <StatusChip
                          label={s.enabled === "enabled" ? "enabled" : s.enabled}
                          tone={s.enabled === "enabled" ? "success" : "neutral"}
                        />
                        <StatusChip label={s.active} tone={activeTone(s)} />
                        {waitingForRun(s) && (
                          <StatusChip label="waiting for run" tone="warning" />
                        )}
                        {s.active === "failed" && s.exitCode != null && (
                          <span className="text-xs text-neutral-500">
                            exit {s.exitCode}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-1 text-xs text-neutral-500">
                  code <span className="font-mono">~/.local/apps/{slot}</span>
                  {" · "}
                  run <span className="font-mono">~/.local/apps/{slot}/run</span>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={busy || !status.manager}
                    onPress={() => void act(slot, "enable")}
                  >
                    Enable
                  </Button>
                  <Button
                    size="sm"
                    variant="tertiary"
                    isDisabled={busy || !status.manager}
                    onPress={() => void act(slot, "disable")}
                  >
                    Disable
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    isDisabled={busy || !status.manager}
                    onPress={() => void act(slot, "restart")}
                  >
                    Restart
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={busy}
                    onPress={() => void showLogs(slot)}
                  >
                    Logs
                  </Button>
                </div>

                {logsFor === slot && (
                  <div className="mt-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-xs font-medium text-neutral-500">
                        Recent logs
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() => setLogsFor(null)}
                      >
                        Close
                      </Button>
                    </div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 font-mono text-xs">
                      {logs.trim() || "(no output)"}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
