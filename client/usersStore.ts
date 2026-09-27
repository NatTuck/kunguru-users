import { create } from "zustand";
import { ApiError, get, patch, post } from "./api";
import type {
  AdminUser,
  JobDetail,
  MessageResult,
  ModelsRefreshResult,
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
  sendMessage: (id: number, message: string) => Promise<MessageResult | null>;
  refreshModels: () => Promise<ModelsRefreshResult | null>;
  job: (id: number) => Promise<JobDetail>;
  watchJob: (jobId: number) => void;
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

// Polling handle for the currently watched background provisioning job.
let jobPoll: ReturnType<typeof setTimeout> | null = null;

function stopJobPoll() {
  if (jobPoll) {
    clearTimeout(jobPoll);
    jobPoll = null;
  }
}

interface SubmitResult {
  user: AdminUser;
  password: string;
  jobId: number | null;
  message?: string;
}

// A background job's initial (still running) provisioning view, or the
// immediate failure when the server could not even start one.
function pendingProvision(data: SubmitResult): ProvisionInfo {
  return data.jobId != null
    ? { ok: false, jobId: data.jobId, status: "running" }
    : { ok: false, jobId: null, message: data.message };
}

export const useUsersStore = create<UsersState>((set, getState) => ({
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
      const data = await post<SubmitResult>("/api/users", { username, role, hostId });
      set({
        busy: false,
        reveal: {
          user: data.user,
          password: data.password,
          kind: "create",
          provisioning: pendingProvision(data),
        },
      });
      if (data.jobId != null) getState().watchJob(data.jobId);
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
      const data = await post<SubmitResult>(`/api/users/${id}/enable`);
      set({
        busy: false,
        reveal: {
          user: data.user,
          password: data.password,
          kind: "enable",
          provisioning: pendingProvision(data),
        },
      });
      if (data.jobId != null) getState().watchJob(data.jobId);
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
      const data = await post<SubmitResult>(`/api/users/${id}/provision`, { hostId });
      set({
        busy: false,
        reveal: {
          user: data.user,
          password: data.password,
          kind: "provision",
          provisioning: pendingProvision(data),
        },
      });
      if (data.jobId != null) getState().watchJob(data.jobId);
      await refreshUsers(set);
    } catch (err) {
      set({ busy: false, actionError: await msg(err, "failed to provision user") });
    }
  },

  sendMessage: async (id, message) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<MessageResult>(`/api/users/${id}/message`, {
        message,
      });
      set({ busy: false });
      return data;
    } catch (err) {
      set({ busy: false, actionError: await msg(err, "failed to send message") });
      return null;
    }
  },

  refreshModels: async () => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<ModelsRefreshResult>("/api/models/refresh");
      set({ busy: false });
      return data;
    } catch (err) {
      set({ busy: false, actionError: await msg(err, "failed to refresh models") });
      return null;
    }
  },

  job: async (id) => get<JobDetail>(`/api/jobs/${id}`),

  // Poll a background provisioning job to completion, mirroring its status
  // into the open reveal modal and refreshing the user list (account status)
  // once it finishes. Keeps running if the modal is dismissed so the list
  // still updates.
  watchJob: (jobId) => {
    stopJobPoll();
    const tick = async () => {
      let detail: JobDetail;
      try {
        detail = await get<JobDetail>(`/api/jobs/${jobId}`);
      } catch {
        jobPoll = setTimeout(() => void tick(), 3000);
        return;
      }
      if (detail.job.status === "running") {
        set((s) =>
          s.reveal?.provisioning?.jobId === jobId
            ? { reveal: { ...s.reveal, provisioning: { ok: false, jobId, status: "running" } } }
            : {},
        );
        jobPoll = setTimeout(() => void tick(), 2000);
        return;
      }
      const failed = detail.steps.find((st) => st.status === "failed");
      const ok = detail.job.status === "succeeded";
      const tail = (failed?.output_log ?? "")
        .split("\n")
        .filter((line) => line.trim())
        .slice(-4)
        .join("\n")
        .slice(-600);
      set((s) =>
        s.reveal?.provisioning?.jobId === jobId
          ? {
              reveal: {
                ...s.reveal,
                provisioning: {
                  ok,
                  jobId,
                  status: detail.job.status,
                  failedStep: failed?.script,
                  message: ok ? undefined : tail || "provisioning did not fully succeed",
                },
              },
            }
          : {},
      );
      await refreshUsers(set);
      jobPoll = null;
    };
    void tick();
  },

  clearReveal: () => set({ reveal: null }),
  clearActionError: () => set({ actionError: null }),
}));
