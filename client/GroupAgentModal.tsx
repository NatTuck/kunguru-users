import { Button, Spinner } from "@heroui/react";
import { useGroupsStore } from "./groupsStore";
import { ModalShell, StatusChip } from "./ui";

// The live log of a group agent provisioning job (started from the Groups page
// or the admin groups view). The store polls /api/jobs/:id; this only renders.
export default function GroupAgentModal({ groupName }: { groupName: string }) {
  const agentJob = useGroupsStore((s) => s.agentJob);
  const closeAgentJob = useGroupsStore((s) => s.closeAgentJob);

  return (
    <ModalShell
      open
      onClose={closeAgentJob}
      title={`Agent — ${groupName}`}
      width="sm:max-w-[720px]"
      footer={
        <div className="flex justify-end">
          <Button variant="tertiary" onPress={closeAgentJob}>
            Close
          </Button>
        </div>
      }
    >
      {agentJob ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">Job {agentJob.job.id}</span>
            <StatusChip
              label={agentJob.job.status}
              tone={
                agentJob.job.status === "succeeded"
                  ? "success"
                  : agentJob.job.status === "failed"
                    ? "danger"
                    : "warning"
              }
            />
          </div>
          {agentJob.steps.map((s) => (
            <div
              key={s.id}
              className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">
                  {s.script} → {s.target_ssh}
                </span>
                <StatusChip
                  label={s.status}
                  tone={
                    s.status === "succeeded"
                      ? "success"
                      : s.status === "running"
                        ? "warning"
                        : "danger"
                  }
                />
                {s.exit_code != null && (
                  <span className="text-neutral-400">exit {s.exit_code}</span>
                )}
              </div>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 font-mono text-xs">
                {s.output_log ||
                  (s.status === "running"
                    ? "(running — output appears when the step finishes)"
                    : "(no output)")}
              </pre>
            </div>
          ))}
        </div>
      ) : (
        <Spinner size="sm" />
      )}
    </ModalShell>
  );
}
