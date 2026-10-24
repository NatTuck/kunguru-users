import { useEffect, useState } from "react";
import { Alert, Button, Card, Input, Label, Spinner } from "@heroui/react";
import AppSlotsPanel from "./AppSlotsPanel";
import StaticSitesPanel from "./StaticSitesPanel";
import { useGroupsStore } from "./groupsStore";
import type { GroupSummary } from "./types";
import { ModalShell, StatusChip } from "./ui";

// Admin view of every group (the admin user list only shows people): state,
// owner, members, app slots, static sites, disable/enable, ownership transfer.

export default function AdminGroupsPage() {
  const {
    adminGroups,
    adminLoading,
    adminError,
    busy,
    actionError,
    loadAdmin,
    transfer,
    disable,
    enable,
    clearActionError,
  } = useGroupsStore();

  const [appsFor, setAppsFor] = useState<GroupSummary | null>(null);
  const [sitesFor, setSitesFor] = useState<GroupSummary | null>(null);
  const [transferFor, setTransferFor] = useState<GroupSummary | null>(null);
  const [ownerName, setOwnerName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void loadAdmin();
  }, [loadAdmin]);

  const after = async (p: Promise<void>) => {
    await p;
    await loadAdmin();
  };

  const submitTransfer = async () => {
    if (!transferFor || !ownerName.trim()) return;
    setNotice(null);
    const r = await transfer(transferFor.id, ownerName.trim());
    if (r && !r.ok) {
      setNotice(`Ownership changed, but membership did not converge: ${r.output.trim() || "unknown error"}`);
    }
    setTransferFor(null);
    setOwnerName("");
  };

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Manage groups</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Every group account on this instance. Groups are disabled, never
        deleted; ownership transfer keeps the previous owner as a member.
      </p>

      {(actionError || notice) && (
        <Alert status={actionError ? "danger" : "warning"} className="mb-4">
          <Alert.Content>
            <Alert.Description>{actionError ?? notice}</Alert.Description>
          </Alert.Content>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              clearActionError();
              setNotice(null);
            }}
          >
            Dismiss
          </Button>
        </Alert>
      )}

      {adminError && (
        <Alert status="danger" className="mb-4">
          <Alert.Content>
            <Alert.Description>{adminError}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {adminLoading && adminGroups.length === 0 ? (
        <Spinner size="sm" />
      ) : adminGroups.length === 0 ? (
        <p className="text-sm text-neutral-500">No groups yet.</p>
      ) : (
        <div className="space-y-3">
          {adminGroups.map((g) => (
            <Card key={g.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{g.username}</span>
                  <StatusChip
                    label={`owner ${g.owner_username ?? "?"}`}
                    tone="accent"
                  />
                  {!g.enabled && <StatusChip label="disabled" tone="danger" />}
                  {!g.provisioned ? (
                    <StatusChip label="not provisioned" tone="warning" />
                  ) : g.status === "active" ? (
                    <StatusChip label={g.host ?? "provisioned"} tone="success" />
                  ) : g.status === "failed" ? (
                    <StatusChip label="failed" tone="danger" />
                  ) : (
                    <StatusChip label="pending" tone="warning" />
                  )}
                  <span className="text-xs text-neutral-500">
                    {g.member_count} member{g.member_count === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    isDisabled={busy || !g.provisioned}
                    onPress={() => setAppsFor(g)}
                  >
                    Apps
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    isDisabled={busy || !g.provisioned}
                    onPress={() => setSitesFor(g)}
                  >
                    Sites
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={busy}
                    onPress={() => {
                      setTransferFor(g);
                      setOwnerName("");
                    }}
                  >
                    Transfer
                  </Button>
                  {g.enabled ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={busy}
                      onPress={() => void after(disable(g.id))}
                    >
                      Disable
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      isDisabled={busy}
                      onPress={() => void after(enable(g.id))}
                    >
                      Enable
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {appsFor && (
        <ModalShell
          open
          onClose={() => setAppsFor(null)}
          title={`Apps — ${appsFor.username}`}
          width="sm:max-w-[640px]"
          footer={
            <div className="flex justify-end">
              <Button variant="tertiary" onPress={() => setAppsFor(null)}>
                Close
              </Button>
            </div>
          }
        >
          <AppSlotsPanel accountId={appsFor.id} />
        </ModalShell>
      )}

      {sitesFor && (
        <ModalShell
          open
          onClose={() => setSitesFor(null)}
          title={`Static sites — ${sitesFor.username}`}
          width="sm:max-w-[640px]"
          footer={
            <div className="flex justify-end">
              <Button variant="tertiary" onPress={() => setSitesFor(null)}>
                Close
              </Button>
            </div>
          }
        >
          <StaticSitesPanel accountId={sitesFor.id} />
        </ModalShell>
      )}

      {transferFor && (
        <ModalShell
          open
          onClose={() => setTransferFor(null)}
          title={`Transfer ownership — ${transferFor.username}`}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" onPress={() => setTransferFor(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                isDisabled={busy || !ownerName.trim()}
                onPress={() => void submitTransfer()}
              >
                Transfer
              </Button>
            </div>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitTransfer();
            }}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-neutral-500">
              The new owner must be an enabled user account. The previous owner
              stays a member of the group.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-owner">New owner</Label>
              <Input
                id="group-owner"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="username"
              />
            </div>
          </form>
        </ModalShell>
      )}
    </div>
  );
}
