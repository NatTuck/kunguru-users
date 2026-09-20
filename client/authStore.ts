import { create } from "zustand";
import { ApiError, get, post } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | null;
  initializing: boolean;
  loginError: string | null;
  loggingIn: boolean;
  changing: boolean;
  changeError: string | null;
  initialize: () => Promise<void>;
  login: (username: string, password: string, next?: string) => Promise<boolean>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  initializing: true,
  loginError: null,
  loggingIn: false,
  changing: false,
  changeError: null,

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

  login: async (username, password, next) => {
    set({ loggingIn: true, loginError: null });
    try {
      const data = await post<{ user: User; redirectTo?: string | null }>(
        "/api/auth/login",
        { username, password, next },
      );
      if (data.redirectTo) {
        // Validated server-side (same-origin path or a per-tenant WebUI host).
        // Full navigation, so the GuestOnly guard can't bounce us to "/" first.
        window.location.replace(data.redirectTo);
        return true;
      }
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

  changePassword: async (currentPassword, newPassword) => {
    set({ changing: true, changeError: null });
    try {
      await post<{ ok: boolean }>("/api/auth/password", {
        currentPassword,
        newPassword,
      });
      set({ changing: false });
      return true;
    } catch (err) {
      set({
        changing: false,
        changeError:
          err instanceof ApiError ? err.message : "failed to change password",
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
