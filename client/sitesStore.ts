import { create } from "zustand";
import { get } from "./api";
import type { AccountSites } from "./types";

interface SitesState {
  sites: AccountSites | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

// Liveness of the signed-in user's public/private personal-app slots. Loaded on
// demand from the account page; the page renders immediately and fills the
// status in when this resolves.
export const useSitesStore = create<SitesState>((set) => ({
  sites: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const data = await get<AccountSites>("/api/me/sites");
      set({ sites: data, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "failed to load site status",
      });
    }
  },
}));
