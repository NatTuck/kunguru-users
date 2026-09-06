import { useState } from "react";
import type { FormEvent } from "react";
import { useAuthStore } from "./authStore";

export default function Login() {
  const login = useAuthStore((s) => s.login);
  const loggingIn = useAuthStore((s) => s.loggingIn);
  const loginError = useAuthStore((s) => s.loginError);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await login(username, password);
  };

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 360 }}>
      <h1>Kunguru Users</h1>
      <h2>Sign in</h2>
      <form onSubmit={onSubmit}>
        <div style={{ marginBottom: 8 }}>
          <label>
            Username
            <br />
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              style={{ width: "100%", padding: 6 }}
            />
          </label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>
            Password
            <br />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              style={{ width: "100%", padding: 6 }}
            />
          </label>
        </div>
        <button type="submit" disabled={loggingIn}>
          {loggingIn ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {loginError && <p style={{ color: "crimson" }}>{loginError}</p>}
    </main>
  );
}
