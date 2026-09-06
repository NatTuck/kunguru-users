import { create } from "zustand";
import { ApiError, get, patch, post } from "./api";
import type {
  AdminUser,
  JobDetail,
  PasswordReveal,
  ProvisionInfo,
  Role,
} from "./types";

interface UsersState {
  users: AdminUser[];
  loading: boolean;
  listError: string | null;
  busy: boolean;
  actionError: string | null;
  reveal: PasswordReveal | null;
  load: () => Promise<void>;
  create: (username: string, role: Role, hostId: number) => Promise<void>;
  setRole: (id: number, role: Role) => Promise<void>;
  disable: (id: number) => Promise<void>;
  enable: (id: number) => Promise<void>;
  resetPassword: (id: number) => Promise<void>;
  provision: (id: number, hostId: number) => Promise<void>;
  job: (id: number) => Promise<JobDetail>;
  clearReveal: () => void;
  clearActionError: () => void;
}

async function msg(err: unknown, fallback: string): Promise<string> {
  return err instanceof ApiError ? err.message : fallback;
}

async function refreshUsers(set: (p: Partial<UsersState>) => void) {
  const data = await get<{ users: AdminUser[] }>("/api/users").catch(() => null);
  if (data) set({ users: data.users });
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
      const data = await get<{ users: AdminUser[] }>("/api/users");
      set({ users: data.users, loading: false });
    } catch (err) {
      set({
        loading: false,
        listError: err instanceof ApiError ? err.message : "failed to load users",
      });
    }
  },

  create: async (username, role, hostId) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<{
        user: AdminUser;
        password: string;
        provisioning: ProvisionInfo | null;
      }>("/api/users", { username, role, hostId });
      set({
        busy: false,
        reveal: {
          user: data.user,
          password: data.password,
          kind: "create",
          provisioning: data.provisioning,
        },
      });
      await refreshUsers(set);
    } catch (err) {
      set({
        busy: false,
        actionError: await msg(err, "failed to create user"),
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
      set({ busy: false, actionError: await msg(err, "failed to change role") });
    }
  },

  disable: async (id) => {
    set({ busy: true, actionError: null });
    try {
      await post<{ provisioning: ProvisionInfo | null }>(`/api/users/${id}/disable`);
      set({ busy: false });
      await refreshUsers(set);
    } catch (err) {
      set({ busy: false, actionError: await msg(err, "failed to disable user") });
    }
  },

  enable: async (id) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<{
        user: AdminUser;
        password: string;
        provisioning: ProvisionInfo | null;
      }>(`/api/users/${id}/enable`);
      set({
        busy: false,
        reveal: {
          user: data.user,
          password: data.password,
          kind: "enable",
          provisioning: data.provisioning,
        },
      });
      await refreshUsers(set);
    } catch (err) {
      set({ busy: false, actionError: await msg(err, "failed to enable user") });
    }
  },

  resetPassword: async (id) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<{
        user: AdminUser;
        password: string;
        provisioning: ProvisionInfo | null;
      }>(`/api/users/${id}/reset-password`);
      set({
        busy: false,
        reveal: {
          user: data.user,
          password: data.password,
          kind: "reset",
          provisioning: data.provisioning,
        },
      });
      await refreshUsers(set);
    } catch (err) {
      set({ busy: false, actionError: await msg(err, "failed to reset password") });
    }
  },

  provision: async (id, hostId) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<{
        user: AdminUser;
        password: string;
        provisioning: ProvisionInfo | null;
      }>(`/api/users/${id}/provision`, { hostId });
      set({
        busy: false,
        reveal: {
          user: data.user,
          password: data.password,
          kind: "provision",
          provisioning: data.provisioning,
        },
      });
      await refreshUsers(set);
    } catch (err) {
      set({ busy: false, actionError: await msg(err, "failed to provision user") });
    }
  },

  job: async (id) => get<JobDetail>(`/api/jobs/${id}`),

  clearReveal: () => set({ reveal: null }),
  clearActionError: () => set({ actionError: null }),
}));
