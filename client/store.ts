import { create } from "zustand";

interface PingState {
  ping: { ok: boolean; ts: number } | null;
  error: string | null;
  loading: boolean;
  loadPing: () => Promise<void>;
}

export const usePingStore = create<PingState>((set) => ({
  ping: null,
  error: null,
  loading: false,
  loadPing: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch("/api/ping");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      set({ ping: (await res.json()) as { ok: boolean; ts: number } });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ loading: false });
    }
  },
}));
