import { create } from "zustand";
import { ApiError, get, post } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | null;
  initializing: boolean;
  loginError: string | null;
  loggingIn: boolean;
  initialize: () => Promise<void>;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  initializing: true,
  loginError: null,
  loggingIn: false,

  initialize: async () => {
    try {
      const data = await get<{ user: User }>("/api/auth/me");
      set({ user: data.user });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) {
        set({ user: null });
      }
    } finally {
      set({ initializing: false });
    }
  },

  login: async (username, password) => {
    set({ loggingIn: true, loginError: null });
    try {
      const data = await post<{ user: User }>("/api/auth/login", {
        username,
        password,
      });
      set({ user: data.user, loggingIn: false });
      return true;
    } catch (err) {
      set({
        loggingIn: false,
        loginError:
          err instanceof ApiError ? err.message : "an unexpected error occurred",
      });
      return false;
    }
  },

  logout: async () => {
    try {
      await post("/api/auth/logout");
    } finally {
      set({ user: null });
    }
  },
}));
