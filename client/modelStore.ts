import { create } from "zustand";
import { ApiError, get, post } from "./api";
import type { ModelInfo } from "./types";

interface ModelState {
  info: ModelInfo | null;
  loading: boolean;
  loadError: string | null;
  applying: boolean;
  actionError: string | null;
  // Model id applied (and gateway restarted) most recently, for the success alert.
  applied: string | null;
  load: () => Promise<void>;
  apply: (model: string) => Promise<void>;
  clearActionError: () => void;
  clearApplied: () => void;
}

async function msg(err: unknown, fallback: string): Promise<string> {
  return err instanceof ApiError ? err.message : fallback;
}

// The signed-in user's Hermes default model + the gateway catalog. Applying a
// model rewrites model.default on the tenant host and restarts the agent
// gateway and WebUI, so it can take a few seconds.
export const useModelStore = create<ModelState>((set) => ({
  info: null,
  loading: false,
  loadError: null,
  applying: false,
  actionError: null,
  applied: null,

  load: async () => {
    set({ loading: true, loadError: null });
    try {
      const data = await get<ModelInfo>("/api/me/model");
      set({ info: data, loading: false });
    } catch (err) {
      set({
        loading: false,
        loadError: await msg(err, "failed to load the model catalog"),
      });
    }
  },

  apply: async (model) => {
    set({ applying: true, actionError: null, applied: null });
    try {
      await post("/api/me/model", { model });
      set((s) => ({
        applying: false,
        applied: model,
        info: s.info ? { ...s.info, current: model } : s.info,
      }));
    } catch (err) {
      set({ applying: false, actionError: await msg(err, "failed to set model") });
    }
  },

  clearActionError: () => set({ actionError: null }),
  clearApplied: () => set({ applied: null }),
}));
