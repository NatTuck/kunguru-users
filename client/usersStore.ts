import { create } from "zustand";
import { ApiError, del, get, patch, post } from "./api";
import type { PasswordReveal, Role, User } from "./types";

interface UsersState {
  users: User[];
  loading: boolean;
  listError: string | null;
  busy: boolean;
  actionError: string | null;
  reveal: PasswordReveal | null;
  load: () => Promise<void>;
  create: (username: string, role: Role) => Promise<void>;
  setRole: (id: number, role: Role) => Promise<void>;
  remove: (id: number) => Promise<void>;
  resetPassword: (id: number) => Promise<void>;
  clearReveal: () => void;
  clearActionError: () => void;
}

export const useUsersStore = create<UsersState>((set) => ({
  users: [],
  loading: false,
  listError: null,
  busy: false,
  actionError: null,
  reveal: null,

  load: async () => {
    set({ loading: true, listError: null });
    try {
      const data = await get<{ users: User[] }>("/api/users");
      set({ users: data.users, loading: false });
    } catch (err) {
      set({
        loading: false,
        listError:
          err instanceof ApiError ? err.message : "failed to load users",
      });
    }
  },

  create: async (username, role) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<{ user: User; password: string }>("/api/users", {
        username,
        role,
      });
      set((s) => ({
        users: [...s.users, data.user],
        reveal: { user: data.user, password: data.password, kind: "create" },
        busy: false,
      }));
    } catch (err) {
      set({
        busy: false,
        actionError:
          err instanceof ApiError ? err.message : "failed to create user",
      });
    }
  },

  setRole: async (id, role) => {
    set({ busy: true, actionError: null });
    try {
      await patch(`/api/users/${id}/role`, { role });
      set((s) => ({
        users: s.users.map((u) => (u.id === id ? { ...u, role } : u)),
        busy: false,
      }));
    } catch (err) {
      set({
        busy: false,
        actionError:
          err instanceof ApiError ? err.message : "failed to change role",
      });
    }
  },

  remove: async (id) => {
    set({ busy: true, actionError: null });
    try {
      await del(`/api/users/${id}`);
      set((s) => ({
        users: s.users.filter((u) => u.id !== id),
        busy: false,
      }));
    } catch (err) {
      set({
        busy: false,
        actionError:
          err instanceof ApiError ? err.message : "failed to delete user",
      });
    }
  },

  resetPassword: async (id) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<{ user: User; password: string }>(
        `/api/users/${id}/reset-password`,
      );
      set({
        reveal: {
          user: data.user,
          password: data.password,
          kind: "reset",
        },
        busy: false,
      });
    } catch (err) {
      set({
        busy: false,
        actionError:
          err instanceof ApiError ? err.message : "failed to reset password",
      });
    }
  },

  clearReveal: () => set({ reveal: null }),
  clearActionError: () => set({ actionError: null }),
}));
