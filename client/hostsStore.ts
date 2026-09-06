import { create } from "zustand";
import { ApiError, get } from "./api";
import type { Host } from "./types";

interface HostsState {
  hosts: Host[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export const useHostsStore = create<HostsState>((set) => ({
  hosts: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const data = await get<{ hosts: Host[] }>("/api/hosts");
      set({ hosts: data.hosts, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof ApiError ? err.message : "failed to load hosts",
      });
    }
  },
}));
