import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
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
    remove,
    resetPassword,
    provision,
    clearReveal,
    clearActionError,
  } = useUsersStore();

  useEffect(() => {
    void load();
    void loadHosts();
  }, [load, loadHosts]);

  const [username, setUsername] = useState("");
  const [role, setRoleChoice] = useState<Role>("user");
  const [hostId, setHostId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [provisionFor, setProvisionFor] = useState<AdminUser | null>(null);
  const [provisionHost, setProvisionHost] = useState<number | null>(null);
  const [jobOpen, setJobOpen] = useState<JobDetail | null>(null);

  useEffect(() => {
    if (hostId == null && hosts.length > 0) setHostId(hosts[0].id);
  }, [hosts, hostId]);

  const defaultHostLabel = useMemo(
    () => (hosts.length ? `${hosts[0].name} (${hosts[0].role})` : ""),
    [hosts],
  );

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    await create(username.trim(), role, hostId ?? hosts[0]?.id ?? 0);
    setUsername("");
    setRoleChoice("user");
    if (hostId != null) setHostId(hostId);
  };

  const provisionable = (u: AdminUser) => !u.account || u.account.status !== "active";

  return (
    <div>
      <h1>Manage users</h1>
      {actionError && (
        <p style={{ color: "crimson" }}>
          {actionError}{" "}
          <button onClick={clearActionError} type="button">
            dismiss
          </button>
        </p>
      )}

      <section style={{ marginBottom: "1.5rem" }}>
        <h2>Create user</h2>
        <form onSubmit={onSubmit}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              placeholder="username (lowercase)"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              pattern="[a-z][a-z0-9._-]{0,31}"
              title="lowercase letters/digits/._- , starting with a letter"
            />
            <select value={role} onChange={(e) => setRoleChoice(e.target.value as Role)}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
            <select
              value={hostId ?? hosts[0]?.id ?? ""}
              onChange={(e) => setHostId(Number(e.target.value))}
              disabled={hostsLoading || hostsError != null}
            >
              {hostsError && <option value="">hosts unavailable</option>}
              {!hostsError &&
                hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} ({h.role})
                  </option>
                ))}
            </select>
            <button type="submit" disabled={busy || hostsError != null}>
              Create &amp; provision
            </button>
          </div>
          {hostsLoading && <p style={{ fontSize: ".85rem" }}>loading machines…</p>}
        </form>
        <p style={{ fontSize: ".85rem", color: "#666" }}>
          First machine shown is a user-server; machines with other roles sort later. Creating
          a user provisions a Linux account on the chosen machine and a matching XMPP account
          on Snikket, sharing one password.
        </p>
      </section>

      {loading && <p>Loading users…</p>}
      {listError && <p style={{ color: "crimson" }}>{listError}</p>}

      {!loading && !listError && (
        <table border={1} cellPadding={8} style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th>ID</th>
              <th>Username</th>
              <th>Role</th>
              <th>Provisioned</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = me?.id === u.id;
              const nextRole: Role = u.role === "admin" ? "user" : "admin";
              return (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td>
                    {u.username} {isSelf ? "(you)" : ""}
                  </td>
                  <td>{u.role}</td>
                  <td>
                    {u.account ? (
                      <>
                        {u.account.hostName}{" "}
                        <em style={{ color: u.account.status === "active" ? "green" : "crimson" }}>
                          ({u.account.status})
                        </em>
                      </>
                    ) : (
                      <em>— not provisioned</em>
                    )}
                  </td>
                  <td>{u.created_at}</td>
                  <td>
                    <button
                      disabled={busy || isSelf}
                      onClick={() => void setRole(u.id, nextRole)}
                      title={isSelf ? "cannot change your own role" : undefined}
                    >
                      Make {nextRole}
                    </button>{" "}
                    <button disabled={busy} onClick={() => void resetPassword(u.id)}>
                      Reset password
                    </button>{" "}
                    {provisionable(u) && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          setProvisionFor(u);
                          setProvisionHost(u.account?.hostId ?? hosts[0]?.id ?? null);
                        }}
                      >
                        {u.account ? "Repair" : "Provision"}
                      </button>
                    )}{" "}
                    {confirmDelete === u.id ? (
                      <span>
                        Sure?{" "}
                        <button disabled={busy} onClick={() => void remove(u.id)}>
                          Delete
                        </button>{" "}
                        <button onClick={() => setConfirmDelete(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button
                        disabled={busy || isSelf}
                        onClick={() => setConfirmDelete(u.id)}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {reveal && <PasswordModal reveal={reveal} onClose={clearReveal} onViewJob={openJob} />}
      {provisionFor && (
        <ProvisionModal
          user={provisionFor}
          hosts={hosts}
          hostId={provisionHost}
          onHost={(id) => setProvisionHost(id)}
          onClose={() => setProvisionFor(null)}
          onConfirm={() => {
            if (provisionFor && provisionHost != null) {
              void provision(provisionFor.id, provisionHost);
              setProvisionFor(null);
            }
          }}
        />
      )}
      {jobOpen && <JobLogModal detail={jobOpen} onClose={() => setJobOpen(null)} />}

      {defaultHostLabel && !hosts.length && null}
    </div>
  );

  function openJob(id: number) {
    void useUsersStore
      .getState()
      .job(id)
      .then(setJobOpen)
      .catch(() => setJobOpen(null));
  }
}

function PasswordModal({
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
  const failed = prov && !prov.ok;
  return (
    <Overlay>
      <h2>
        {reveal.kind === "create"
          ? "User created"
          : reveal.kind === "reset"
            ? "Password reset"
            : "User provisioned"}{" "}
        — {reveal.user.username}
      </h2>
      <p>
        Password for <strong>{reveal.user.username}</strong>:
      </p>
      <p>
        <code
          style={{
            display: "block",
            padding: 8,
            background: "#f4f4f4",
            userSelect: "all",
            fontSize: "1.1rem",
          }}
        >
          {reveal.password}
        </code>
      </p>
      <p>
        This is shown <strong>only once</strong>. Share it securely; it will not be shown again.
      </p>
      {prov && prov.ok && (
        <p style={{ color: "green" }}>Provisioning succeeded (Linux + XMPP).</p>
      )}
      {failed && (
        <p style={{ color: "crimson" }}>
          Provisioning did not fully succeed{prov.failedStep ? ` at step "${prov.failedStep}"` : ""}
          {prov.message ? `: ${prov.message}` : ""}.
          {prov.jobId != null && (
            <>
              {" "}
              <button onClick={() => onViewJob(prov.jobId as number)}>View log</button>
            </>
          )}
        </p>
      )}
      <button
        onClick={() => {
          void navigator.clipboard.writeText(reveal.password);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>{" "}
      <button onClick={onClose}>Close</button>
    </Overlay>
  );
}

function ProvisionModal({
  user,
  hosts,
  hostId,
  onHost,
  onClose,
  onConfirm,
}: {
  user: AdminUser;
  hosts: Host[];
  hostId: number | null;
  onHost: (id: number) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Overlay>
      <h2>{user.account ? "Repair provisioning" : "Provision"} — {user.username}</h2>
      {user.account && (
        <p>
          Re-provisioning rotates the password (the old value is not retained), then re-applies
          the Linux + XMPP accounts.
        </p>
      )}
      {hosts.length === 0 ? (
        <p>No machines available.</p>
      ) : (
        <div>
          {hosts.map((h) => (
            <label key={h.id} style={{ display: "block", marginBottom: 4 }}>
              <input
                type="radio"
                name="host"
                checked={hostId === h.id}
                onChange={() => onHost(h.id)}
              />
              {h.name} ({h.role})
            </label>
          ))}
        </div>
      )}
      <button disabled={hostId == null} onClick={onConfirm}>
        Provision on selected machine
      </button>{" "}
      <button onClick={onClose}>Cancel</button>
    </Overlay>
  );
}

function JobLogModal({ detail, onClose }: { detail: JobDetail; onClose: () => void }) {
  return (
    <Overlay wide>
      <h2>
        Job #{detail.job.id} — {detail.job.profile} ({detail.job.status})
      </h2>
      {detail.job.host_name && <p>host: {detail.job.host_name}</p>}
      {detail.steps.map((s) => (
        <div key={s.id} style={{ marginBottom: 12 }}>
          <strong>
            #{s.seq + 1} {s.script} → {s.target_ssh} ({s.status}
            {s.exit_code != null ? `, exit ${s.exit_code}` : ""})
          </strong>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              background: "#f4f4f4",
              padding: 8,
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {s.output_log || "(no output)"}
          </pre>
        </div>
      ))}
      <button onClick={onClose}>Close</button>
    </Overlay>
  );
}

function Overlay({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10,
      }}
    >
      <div
        style={{
          background: "#fff",
          padding: "1.5rem",
          maxWidth: wide ? 760 : 460,
          width: wide ? "90vw" : undefined,
          borderRadius: 8,
        }}
      >
        {children}
      </div>
    </div>
  );
}
