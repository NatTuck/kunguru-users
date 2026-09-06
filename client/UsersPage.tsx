import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useAuthStore } from "./authStore";
import { useUsersStore } from "./usersStore";
import type { PasswordReveal, Role } from "./types";

export default function UsersPage() {
  const me = useAuthStore((s) => s.user);
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
    clearReveal,
    clearActionError,
  } = useUsersStore();

  useEffect(() => {
    void load();
  }, [load]);

  const [username, setUsername] = useState("");
  const [role, setRoleChoice] = useState<Role>("user");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = username.trim();
    if (!ok) return;
    await create(ok, role);
    setUsername("");
    setRoleChoice("user");
  };

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
        <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            placeholder="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            pattern="[A-Za-z0-9._-]{1,64}"
            title="letters, numbers, dots, dashes, underscores"
          />
          <select value={role} onChange={(e) => setRoleChoice(e.target.value as Role)}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <button type="submit" disabled={busy}>
            Create
          </button>
        </form>
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
                  <td>{u.created_at}</td>
                  <td>
                    <button
                      disabled={busy || isSelf}
                      onClick={() => void setRole(u.id, nextRole)}
                      title={isSelf ? "cannot change your own role" : undefined}
                    >
                      Make {nextRole}
                    </button>{" "}
                    <button
                      disabled={busy}
                      onClick={() => void resetPassword(u.id)}
                    >
                      Reset password
                    </button>{" "}
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

      {reveal && <PasswordModal reveal={reveal} onClose={clearReveal} />}
    </div>
  );
}

function PasswordModal({
  reveal,
  onClose,
}: {
  reveal: PasswordReveal;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ background: "#fff", padding: "1.5rem", maxWidth: 420, borderRadius: 8 }}>
        <h2>
          {reveal.kind === "create" ? "User created" : "Password reset"} —{" "}
          {reveal.user.username}
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
          This is shown <strong>only once</strong>. Share it securely and it will not be
          shown again.
        </p>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(reveal.password);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>{" "}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
