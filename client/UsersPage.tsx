import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  Alert,
  Button,
  Input,
  Label,
  ListBox,
  Radio,
  RadioGroup,
  Select,
  Spinner,
  Table,
} from "@heroui/react";
import type { Key } from "@heroui/react";
import { useAuthStore } from "./authStore";
import { useHostsStore } from "./hostsStore";
import { useUsersStore } from "./usersStore";
import type {
  AdminUser,
  Host,
  JobDetail,
  PasswordReveal,
  Role,
} from "./types";
import { ModalShell, Mono, StatusChip } from "./ui";

export default function UsersPage() {
  const me = useAuthStore((s) => s.user);
  const { hosts, loading: hostsLoading, error: hostsError, load: loadHosts } = useHostsStore();
  const {
    users,
    loading,
    listError,
    busy,
    actionError,
    reveal,
    load,
    create,
    setRole,
    disable,
    enable,
    resetPassword,
    provision,
    clearReveal,
  } = useUsersStore();

  useEffect(() => {
    void load();
    void loadHosts();
  }, [load, loadHosts]);

  const [username, setUsername] = useState("");
  const [roleKey, setRoleKey] = useState<Key | null>("user");
  const [hostKey, setHostKey] = useState<Key | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<number | null>(null);
  const [provisionFor, setProvisionFor] = useState<AdminUser | null>(null);
  const [provisionHost, setProvisionHost] = useState<string | null>(null);
  const [jobOpen, setJobOpen] = useState<JobDetail | null>(null);

  useEffect(() => {
    if (hostKey == null && hosts.length > 0) setHostKey(hosts[0].id);
  }, [hosts, hostKey]);

  const provisionable = (u: AdminUser) => !u.account || u.account.status !== "active";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || hostKey == null) return;
    await create(username.trim(), (roleKey ?? "user") as Role, Number(hostKey));
    setUsername("");
    setRoleKey("user");
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Manage users</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Creating a user provisions a Linux account on the chosen machine and a matching XMPP
          account on Snikket, sharing one password.
        </p>
      </div>

      {actionError && (
        <div className="mb-4">
          <Alert status="danger">
            <Alert.Content>
              <Alert.Description>{actionError}</Alert.Description>
            </Alert.Content>
          </Alert>
        </div>
      )}

      {/* Create user */}
      <form
        onSubmit={onSubmit}
        className="mb-8 flex flex-wrap items-end gap-3 rounded-2xl border border-neutral-200 bg-white p-4"
      >
        <div className="flex min-w-52 flex-col gap-1.5">
          <label htmlFor="new-username" className="text-sm font-medium">
            Username
          </label>
          <Input
            id="new-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="jane"
            pattern="[a-z][a-z0-9._-]{0,31}"
            required
          />
        </div>
        <Select
          className="min-w-36"
          value={roleKey}
          onChange={(v) => setRoleKey(v)}
          placeholder="Role"
        >
          <Label>Role</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id="user" textValue="user">
                user
              </ListBox.Item>
              <ListBox.Item id="admin" textValue="admin">
                admin
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
        <Select
          className="min-w-56"
          value={hostKey}
          onChange={(v) => setHostKey(v)}
          placeholder="Machine"
          isDisabled={hostsLoading || hostsError != null}
        >
          <Label>Target machine</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {hosts.map((h) => (
                <ListBox.Item key={h.id} id={h.id} textValue={`${h.name} (${h.role})`}>
                  {h.name} ({h.role})
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <Button type="submit" variant="primary" isDisabled={busy || hostKey == null}>
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Spinner size="sm" /> Creating…
            </span>
          ) : (
            "Create"
          )}
        </Button>
      </form>

      {loading ? (
        <div className="flex items-center gap-2 text-neutral-500">
          <Spinner size="sm" /> Loading users…
        </div>
      ) : listError ? (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{listError}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
          <Table className="w-full">
            <Table.ScrollContainer>
              <Table.Content aria-label="Users">
                <Table.Header>
                  <Table.Column isRowHeader>User</Table.Column>
                  <Table.Column>Role</Table.Column>
                  <Table.Column>Provisioned</Table.Column>
                  <Table.Column>Created</Table.Column>
                  <Table.Column>Actions</Table.Column>
                </Table.Header>
                <Table.Body>
                  {users.map((u) => (
                    <UserRow
                      key={u.id}
                      user={u}
                      meId={me?.id}
                      busy={busy}
                      provisionable={provisionable(u)}
                      confirmDisable={confirmDisable === u.id}
                      onRequestDisable={() => setConfirmDisable(u.id)}
                      onCancelDisable={() => setConfirmDisable(null)}
                      onDisable={() => {
                        void disable(u.id);
                        setConfirmDisable(null);
                      }}
                      onEnable={() => void enable(u.id)}
                      onRole={() => void setRole(u.id, u.role === "admin" ? "user" : "admin")}
                      onReset={() => void resetPassword(u.id)}
                      onProvision={() => {
                        setProvisionFor(u);
                        const firstHost = hosts[0]?.id;
                        setProvisionHost(u.account ? String(u.account.hostId) : firstHost != null ? String(firstHost) : null);
                      }}
                    />
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </div>
      )}

      {reveal && (
        <RevealModal
          reveal={reveal}
          onClose={clearReveal}
          onViewJob={(id) => {
            void useUsersStore
              .getState()
              .job(id)
              .then(setJobOpen)
              .catch(() => setJobOpen(null));
          }}
        />
      )}
      {provisionFor && (
        <ProvisionModal
          user={provisionFor}
          hosts={hosts}
          hostKey={provisionHost}
          onHost={(id) => setProvisionHost(id)}
          onClose={() => setProvisionFor(null)}
          onConfirm={() => {
            if (provisionFor && provisionHost != null) {
              void provision(provisionFor.id, Number(provisionHost));
              setProvisionFor(null);
            }
          }}
        />
      )}
      {jobOpen && (
        <JobLogModal detail={jobOpen} onClose={() => setJobOpen(null)} />
      )}
    </div>
  );
}

function UserRow({
  user: u,
  meId,
  busy,
  provisionable: canProvision,
  confirmDisable,
  onRequestDisable,
  onCancelDisable,
  onDisable,
  onEnable,
  onRole,
  onReset,
  onProvision,
}: {
  user: AdminUser;
  meId?: number;
  busy: boolean;
  provisionable: boolean;
  confirmDisable: boolean;
  onRequestDisable: () => void;
  onCancelDisable: () => void;
  onDisable: () => void;
  onEnable: () => void;
  onRole: () => void;
  onReset: () => void;
  onProvision: () => void;
}) {
  const isSelf = meId === u.id;
  const disabled = !u.enabled;
  return (
    <Table.Row>
      <Table.Cell>
        <div className="flex items-center gap-2">
          <span className={disabled ? "text-neutral-400 line-through" : undefined}>
            {u.username}
          </span>
          {isSelf && <StatusChip label="you" tone="accent" />}
          {disabled && <StatusChip label="disabled" tone="danger" />}
        </div>
      </Table.Cell>
      <Table.Cell>
        <StatusChip label={u.role} tone={u.role === "admin" ? "accent" : "neutral"} />
      </Table.Cell>
      <Table.Cell>
        {u.account ? (
          <div className="flex items-center gap-2">
            <span className="text-sm">{u.account.hostName}</span>
            <StatusChip
              label={u.account.status}
              tone={
                u.account.status === "active"
                  ? "success"
                  : u.account.status === "failed"
                    ? "danger"
                    : "warning"
              }
            />
          </div>
        ) : (
          <span className="text-sm text-neutral-400">— not provisioned</span>
        )}
      </Table.Cell>
      <Table.Cell>
        <span className="text-sm text-neutral-600">{u.created_at}</span>
      </Table.Cell>
      <Table.Cell>
        {disabled ? (
          <Button size="sm" variant="primary" isDisabled={busy} onPress={onEnable}>
            Enable
          </Button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              isDisabled={busy || isSelf}
              onPress={onRole}
            >
              Make {u.role === "admin" ? "user" : "admin"}
            </Button>
            <Button size="sm" variant="outline" isDisabled={busy} onPress={onReset}>
              Reset password
            </Button>
            {canProvision && (
              <Button size="sm" variant="secondary" isDisabled={busy} onPress={onProvision}>
                {u.account ? "Repair" : "Provision"}
              </Button>
            )}
            {confirmDisable ? (
              <span className="flex items-center gap-1">
                <Button size="sm" variant="danger" isDisabled={busy} onPress={onDisable}>
                  Confirm disable
                </Button>
                <Button size="sm" variant="tertiary" onPress={onCancelDisable}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                isDisabled={busy || isSelf}
                onPress={onRequestDisable}
              >
                Disable
              </Button>
            )}
          </div>
        )}
      </Table.Cell>
    </Table.Row>
  );
}

function RevealModal({
  reveal,
  onClose,
  onViewJob,
}: {
  reveal: PasswordReveal;
  onClose: () => void;
  onViewJob: (jobId: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const prov = reveal.provisioning;
  const title =
    reveal.kind === "create"
      ? `User created — ${reveal.user.username}`
      : reveal.kind === "reset"
        ? `Password reset — ${reveal.user.username}`
        : reveal.kind === "enable"
          ? `User enabled — ${reveal.user.username}`
          : `User provisioned — ${reveal.user.username}`;

  return (
    <ModalShell open onClose={onClose} title={title} width="sm:max-w-[440px]">
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">
          Password for <strong>{reveal.user.username}</strong> — shown only once:
        </p>
        <Mono>{reveal.password}</Mono>
        {prov?.ok ? (
          <Alert status="success">
            <Alert.Content>
              <Alert.Description>Provisioning succeeded (Linux + XMPP).</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : prov && !prov.ok ? (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Title>Provisioning did not fully succeed</Alert.Title>
              <Alert.Description>
                {prov.failedStep ? `Failed at step "${prov.failedStep}". ` : ""}
                {prov.message ? `${prov.message} ` : ""}
                The Linux/XMPP accounts may be partially applied; use Repair once things are
                reachable.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            onPress={() => {
              void navigator.clipboard.writeText(reveal.password);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy password"}
          </Button>
          {prov?.jobId != null && (
            <Button size="sm" variant="outline" onPress={() => onViewJob(prov.jobId as number)}>
              View log
            </Button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function ProvisionModal({
  user: u,
  hosts,
  hostKey,
  onHost,
  onClose,
  onConfirm,
}: {
  user: AdminUser;
  hosts: Host[];
  hostKey: string | null;
  onHost: (id: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell
      open
      onClose={onClose}
      title={`${u.account ? "Repair provisioning" : "Provision"} — ${u.username}`}
      width="sm:max-w-[460px]"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isDisabled={hostKey == null} onPress={onConfirm}>
            Provision on selected machine
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {u.account && (
          <Alert status="warning">
            <Alert.Content>
              <Alert.Description>
                Re-provisioning rotates the password (the old value is not retained), then
                re-applies the Linux + XMPP accounts.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        {hosts.length === 0 ? (
          <p className="text-sm text-neutral-500">No machines available.</p>
        ) : (
          <>
            <div className="text-sm font-medium">Target machine</div>
            <RadioGroup
              value={hostKey}
              onChange={(v) => onHost(v ?? "")}
              className="gap-2"
            >
              {hosts.map((h) => (
                <Radio key={h.id} value={String(h.id)}>
                  <Radio.Content>
                    {h.name} <span className="text-neutral-400">({h.role})</span>
                  </Radio.Content>
                </Radio>
              ))}
            </RadioGroup>
          </>
        )}
      </div>
    </ModalShell>
  );
}

function JobLogModal({ detail, onClose }: { detail: JobDetail; onClose: () => void }) {
  return (
    <ModalShell open onClose={onClose} title={`Job #${detail.job.id} — ${detail.job.profile}`} width="sm:max-w-[720px]">
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-neutral-500">Host:</span>
          <span>{detail.job.host_name ?? "—"}</span>
          <StatusChip label={detail.job.status} tone={detail.job.status === "succeeded" ? "success" : "danger"} />
        </div>
        {detail.steps.map((s) => (
          <div key={s.id} className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">
                {s.script} → {s.target_ssh}
              </span>
              <StatusChip
                label={s.status}
                tone={s.status === "succeeded" ? "success" : "danger"}
              />
              {s.exit_code != null && (
                <span className="text-neutral-400">exit {s.exit_code}</span>
              )}
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 font-mono text-xs">
              {s.output_log || "(no output)"}
            </pre>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}
