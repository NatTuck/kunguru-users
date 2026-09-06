import { useEffect } from "react";
import { usePingStore } from "./store";

export default function App() {
  const { ping, error, loading, loadPing } = usePingStore();

  useEffect(() => {
    void loadPing();
  }, [loadPing]);

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>Kunguru Users</h1>
      {loading && <p>pinging…</p>}
      {error && <p style={{ color: "crimson" }}>error: {error}</p>}
      {ping && (
        <p>
          api ok: <code>{String(ping.ok)}</code> · ts:{" "}
          <code>{new Date(ping.ts).toISOString()}</code>
        </p>
      )}
    </main>
  );
}
