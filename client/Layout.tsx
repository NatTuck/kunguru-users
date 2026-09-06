import { Outlet } from "react-router-dom";
import { useCurrentUser } from "./guards";
import { useAuthStore } from "./authStore";

export default function Layout() {
  const user = useCurrentUser();
  const logout = useAuthStore((s) => s.logout);

  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <header
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          padding: "0.75rem 2rem",
          borderBottom: "1px solid #ddd",
          marginBottom: "1rem",
        }}
      >
        <strong>Kunguru Users</strong>
        <nav style={{ display: "flex", gap: 12 }}>
          <a href="/">My account</a>
          {user?.role === "admin" && <a href="/admin/users">Manage users</a>}
        </nav>
        <span style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
          <span>
            {user?.username} <em>({user?.role})</em>
          </span>
          <button onClick={() => void logout()}>Log out</button>
        </span>
      </header>
      <main style={{ padding: "0 2rem" }}>
        <Outlet />
      </main>
    </div>
  );
}
