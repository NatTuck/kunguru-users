import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  Alert,
  Button,
  Card,
  Input,
  Label,
  ListBox,
  Select,
  Spinner,
  TextArea,
} from "@heroui/react";
import { appDevUrl, appUrl, useConfigStore } from "./configStore";
import { useGroupsStore } from "./groupsStore";
import AppSlotsPanel from "./AppSlotsPanel";
import GroupAgentModal from "./GroupAgentModal";
import StaticSitesPanel from "./StaticSitesPanel";
import type { CommandResult, GroupSummary } from "./types";
import { ModalShell, StatusChip } from "./ui";

// Groups are shared accounts: an owner manages the group, members use it (its
// app slots and hosts) and can read it. This page is the self-service surface:
// create, members, app slots, static sites, provision/repair, disable/enable.

export default function GroupsPage() {
  const config = useConfigStore((s) => s.config);
  const baseDomain = config?.baseDomain ?? "";
  const {
    groups,
    limit,
    owned,
    loading,
    listError,
    busy,
    actionError,
    detail,
    detailLoading,
    load,
    create,
    open,
    closeDetail,
    addMember,
    removeMember,
    disable,
    enable,
    provision,
    startAgent,
    setAgent,
    agentJobFor,
    message,
    clearActionError,
  } = useGroupsStore();

  const [name, setName] = useState("");
  const [memberName, setMemberName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [appsFor, setAppsFor] = useState<GroupSummary | null>(null);
  const [sitesFor, setSitesFor] = useState<GroupSummary | null>(null);
  const [messageFor, setMessageFor] = useState<GroupSummary | null>(null);
  const [messageTo, setMessageTo] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [messageResult, setMessageResult] = useState<CommandResult | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const atLimit = owned >= limit;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setNotice(null);
    const r = await create(name.trim());
    if (r) {
      setName("");
      if (!r.ok) {
        setNotice(
          `Created, but provisioning did not finish: ${
            r.output.trim() || r.failedStep || "unknown error"
          }`,
        );
      }
    }
  };

  const repair = async (id: number) => {
    setNotice(null);
    const r = await provision(id);
    if (r && !r.ok) {
      setNotice(
        `Provisioning did not finish: ${r.output.trim() || r.failedStep || "unknown error"}`,
      );
    }
  };

  const submitMember = async (e: FormEvent, id: number) => {
    e.preventDefault();
    if (!memberName.trim()) return;
    setNotice(null);
    const r = await addMember(id, memberName.trim());
    if (r) {
      setMemberName("");
      if (!r.ok) setNotice(`Membership did not converge: ${r.output.trim() || "unknown error"}`);
    }
  };

  const openMessage = (g: GroupSummary) => {
    setMessageFor(g);
    setMessageTo(null);
    setMessageText("");
    setMessageResult(null);
    if (detail?.group.id !== g.id) void open(g.id);
  };

  const sendMessage = async () => {
    if (!messageFor || !messageTo || !messageText.trim()) return;
    const r = await message(messageFor.id, messageTo, messageText);
    if (r) {
      setMessageResult(r);
      if (r.ok) setMessageText("");
    }
  };

  const showMembers = (g: GroupSummary) => {
    if (detail?.group.id === g.id) {
      closeDetail();
    } else {
      void open(g.id);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Groups</h1>
      <p className="mb-6 text-sm text-neutral-500">
        A group is a shared account: its own app slots, hosts, and static sites.
        Members can use it; the owner manages it. Up to {limit} groups per owner
        ({owned} used).
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

      <Card className="mb-6 p-6">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="group-name">New group</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ops"
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            isDisabled={busy || !name.trim() || atLimit}
          >
            Create group
          </Button>
        </form>
        {atLimit && (
          <p className="mt-3 text-xs text-neutral-500">
            You own the maximum of {limit} groups.
          </p>
        )}
      </Card>

      {listError && (
        <Alert status="danger" className="mb-4">
          <Alert.Content>
            <Alert.Description>{listError}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {loading && groups.length === 0 ? (
        <Spinner size="sm" />
      ) : groups.length === 0 ? (
        <p className="text-sm text-neutral-500">
          You are not in any groups yet.
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const app = appUrl(baseDomain, g.username);
            const appDev = appDevUrl(baseDomain, g.username);
            const isOwner = g.role === "owner";
            const expanded = detail?.group.id === g.id;
            return (
              <Card key={g.id} className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{g.username}</span>
                    <StatusChip
                      label={g.role}
                      tone={g.role === "owner" ? "accent" : "neutral"}
                    />
                    {!g.enabled && <StatusChip label="disabled" tone="danger" />}
                    {g.agent && (
                      <StatusChip
                        label={g.agent_enabled ? "agent on" : "agent off"}
                        tone={g.agent_enabled ? "success" : "neutral"}
                      />
                    )}
                    {!g.provisioned ? (
                      <StatusChip label="not provisioned" tone="warning" />
                    ) : g.status === "active" ? (
                      <StatusChip label={g.host ?? "provisioned"} tone="success" />
                    ) : g.status === "failed" ? (
                      <StatusChip label="failed" tone="danger" />
                    ) : (
                      <StatusChip label="pending" tone="warning" />
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {app && (
                      <a
                        href={app}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-sm hover:underline"
                      >
                        app
                      </a>
                    )}
                    {appDev && (
                      <a
                        href={appDev}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-sm hover:underline"
                      >
                        dev
                      </a>
                    )}
                  </div>
                </div>
                <div className="mt-1 text-xs text-neutral-500">
                  {g.owner_username && g.role !== "owner"
                    ? `owner ${g.owner_username} · `
                    : ""}
                  {g.member_count} member{g.member_count === 1 ? "" : "s"}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    isDisabled={busy}
                    onPress={() => showMembers(g)}
                  >
                    {expanded ? "Hide members" : "Members"}
                  </Button>
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
                    Static sites
                  </Button>
                  {isOwner && (
                    <Button
                      size="sm"
                      variant="outline"
                      isDisabled={busy || !g.provisioned}
                      onPress={() => void setAgent(g.id, !g.agent_enabled)}
                    >
                      {g.agent_enabled
                        ? "Stop agent"
                        : g.agent
                          ? "Start agent"
                          : "Enable agent"}
                    </Button>
                  )}
                  {isOwner && g.agent && (
                    <Button
                      size="sm"
                      variant="outline"
                      isDisabled={busy}
                      onPress={() => void startAgent(g.id)}
                    >
                      Update agent
                    </Button>
                  )}
                  {isOwner && g.agent && (
                    <Button
                      size="sm"
                      variant="outline"
                      isDisabled={busy}
                      onPress={() => openMessage(g)}
                    >
                      Message
                    </Button>
                  )}
                  {isOwner && (
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() => void repair(g.id)}
                    >
                      {g.provisioned ? "Repair" : "Provision"}
                    </Button>
                  )}
                  {isOwner &&
                    (g.enabled ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={busy}
                        onPress={() => void disable(g.id)}
                      >
                        Disable
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        isDisabled={busy}
                        onPress={() => void enable(g.id)}
                      >
                        Enable
                      </Button>
                    ))}
                </div>

                {expanded && (
                  <div className="mt-4 border-t border-neutral-100 pt-4">
                    {detailLoading ? (
                      <Spinner size="sm" />
                    ) : detail ? (
                      <>
                        <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
                          {detail.members.map((m) => (
                            <li
                              key={m.user_id}
                              className="flex items-center justify-between gap-3 px-3 py-2"
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-sm">{m.username}</span>
                                <StatusChip
                                  label={m.role}
                                  tone={m.role === "owner" ? "accent" : "neutral"}
                                />
                              </div>
                              {detail.canManage && m.role !== "owner" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  isDisabled={busy}
                                  onPress={() => void removeMember(g.id, m.user_id)}
                                >
                                  Remove
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                        {detail.canManage && (
                          <form
                            onSubmit={(e) => void submitMember(e, g.id)}
                            className="mt-3 flex flex-wrap items-end gap-2"
                          >
                            <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                              <Label htmlFor={`member-${g.id}`}>Add a member</Label>
                              <Input
                                id={`member-${g.id}`}
                                value={memberName}
                                onChange={(e) => setMemberName(e.target.value)}
                                placeholder="username"
                              />
                            </div>
                            <Button
                              type="submit"
                              variant="secondary"
                              isDisabled={busy || !memberName.trim()}
                            >
                              Add
                            </Button>
                          </form>
                        )}
                      </>
                    ) : null}
                  </div>
                )}
              </Card>
            );
          })}
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

      {agentJobFor != null && (
        <GroupAgentModal
          groupName={groups.find((g) => g.id === agentJobFor)?.username ?? ""}
        />
      )}

      {messageFor && (
        <ModalShell
          open
          onClose={() => setMessageFor(null)}
          title={`Message as ${messageFor.username}-agent`}
          width="sm:max-w-[560px]"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" onPress={() => setMessageFor(null)}>
                Close
              </Button>
              <Button
                variant="primary"
                isDisabled={busy || !messageTo || !messageText.trim()}
                onPress={() => void sendMessage()}
              >
                Send
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            {detailLoading && detail?.group.id !== messageFor.id ? (
              <Spinner size="sm" />
            ) : (
              <>
                <Select
                  value={messageTo}
                  onChange={(v) => setMessageTo(v == null ? null : String(v))}
                  placeholder="Choose a member"
                >
                  <Label>To</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {(detail?.group.id === messageFor.id
                        ? detail.members
                        : []
                      ).map((m) => (
                        <ListBox.Item
                          key={m.user_id}
                          id={m.username}
                          textValue={m.username}
                        >
                          {m.username}
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
                <TextArea
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  rows={4}
                  placeholder="Message from the group's agent"
                />
                {messageResult && (
                  <Alert status={messageResult.ok ? "success" : "danger"}>
                    <Alert.Content>
                      <Alert.Description>
                        {messageResult.ok
                          ? "Sent."
                          : messageResult.output.trim() || "Send failed."}
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}
              </>
            )}
          </div>
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
          <StaticSitesPanel
            accountId={sitesFor.id}
            canManage={sitesFor.role !== "member"}
          />
        </ModalShell>
      )}
    </div>
  );
}
