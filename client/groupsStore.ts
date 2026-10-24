import { create } from "zustand";
import { ApiError, del, get, post } from "./api";
import type {
  CommandResult,
  GroupDetail,
  GroupProvisionInfo,
  GroupSummary,
  JobDetail,
} from "./types";

interface CreateReply {
  group: GroupSummary | null;
  members: GroupDetail["members"];
  provisioning: GroupProvisionInfo;
}

interface GroupsState {
  groups: GroupSummary[];
  limit: number;
  owned: number;
  loading: boolean;
  listError: string | null;
  busy: boolean;
  actionError: string | null;
  detail: GroupDetail | null;
  detailLoading: boolean;
  adminGroups: GroupSummary[];
  adminLoading: boolean;
  adminError: string | null;
  /** The group whose agent job is open in the modal. */
  agentJobFor: number | null;
  agentJob: JobDetail | null;
  load: () => Promise<void>;
  create: (name: string) => Promise<GroupProvisionInfo | null>;
  open: (id: number) => Promise<void>;
  closeDetail: () => void;
  addMember: (id: number, username: string) => Promise<CommandResult | null>;
  removeMember: (id: number, userId: number) => Promise<void>;
  disable: (id: number) => Promise<void>;
  enable: (id: number) => Promise<void>;
  provision: (id: number) => Promise<GroupProvisionInfo | null>;
  loadAdmin: () => Promise<void>;
  transfer: (id: number, username: string) => Promise<CommandResult | null>;
  startAgent: (id: number) => Promise<number | null>;
  closeAgentJob: () => void;
  message: (id: number, username: string, message: string) => Promise<CommandResult | null>;
  clearActionError: () => void;
}

async function message(err: unknown, fallback: string): Promise<string> {
  return err instanceof ApiError ? err.message : fallback;
}

export const useGroupsStore = create<GroupsState>((set, getState) => ({
  groups: [],
  limit: 5,
  owned: 0,
  loading: false,
  listError: null,
  busy: false,
  actionError: null,
  detail: null,
  detailLoading: false,
  adminGroups: [],
  adminLoading: false,
  adminError: null,
  agentJobFor: null,
  agentJob: null,

  load: async () => {
    set({ loading: true, listError: null });
    try {
      const data = await get<{
        groups: GroupSummary[];
        limit: number;
        owned: number;
      }>("/api/groups");
      set({
        groups: data.groups,
        limit: data.limit,
        owned: data.owned,
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        listError: await message(err, "failed to load groups"),
      });
    }
  },

  create: async (name) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<CreateReply>("/api/groups", { name });
      set((s) => ({
        busy: false,
        owned: s.owned + 1,
        detail: data.group
          ? { group: data.group, members: data.members, canManage: true }
          : s.detail,
      }));
      await getState().load();
      return data.provisioning;
    } catch (err) {
      set({ busy: false, actionError: await message(err, "failed to create group") });
      return null;
    }
  },

  open: async (id) => {
    set({ detailLoading: true, actionError: null });
    try {
      const data = await get<GroupDetail>(`/api/groups/${id}`);
      set({ detail: data, detailLoading: false });
    } catch (err) {
      set({
        detailLoading: false,
        actionError: await message(err, "failed to load the group"),
      });
    }
  },

  closeDetail: () => set({ detail: null }),

  addMember: async (id, username) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<{
        members: GroupDetail["members"];
        membership: CommandResult;
      }>(`/api/groups/${id}/members`, { username });
      set((s) => ({
        busy: false,
        detail: s.detail
          ? {
              ...s.detail,
              members: data.members,
              group: {
                ...s.detail.group,
                member_count: data.members.length,
              },
            }
          : s.detail,
      }));
      await getState().load();
      return data.membership;
    } catch (err) {
      set({ busy: false, actionError: await message(err, "failed to add the member") });
      return null;
    }
  },

  removeMember: async (id, userId) => {
    set({ busy: true, actionError: null });
    try {
      const data = await del<{
        members: GroupDetail["members"];
        membership: CommandResult;
      }>(`/api/groups/${id}/members/${userId}`);
      set((s) => ({
        busy: false,
        detail: s.detail
          ? {
              ...s.detail,
              members: data.members,
              group: {
                ...s.detail.group,
                member_count: data.members.length,
              },
            }
          : s.detail,
      }));
      await getState().load();
    } catch (err) {
      set({
        busy: false,
        actionError: await message(err, "failed to remove the member"),
      });
    }
  },

  disable: async (id) => {
    set({ busy: true, actionError: null });
    try {
      await post(`/api/groups/${id}/disable`);
      set({ busy: false });
      await getState().load();
      if (getState().detail?.group.id === id) await getState().open(id);
    } catch (err) {
      set({ busy: false, actionError: await message(err, "failed to disable the group") });
    }
  },

  enable: async (id) => {
    set({ busy: true, actionError: null });
    try {
      await post(`/api/groups/${id}/enable`);
      set({ busy: false });
      await getState().load();
      if (getState().detail?.group.id === id) await getState().open(id);
    } catch (err) {
      set({ busy: false, actionError: await message(err, "failed to enable the group") });
    }
  },

  provision: async (id) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<{
        group: GroupSummary | null;
        members: GroupDetail["members"];
        provisioning: GroupProvisionInfo;
      }>(`/api/groups/${id}/provision`);
      set((s) => ({
        busy: false,
        detail:
          data.group && s.detail?.group.id === id
            ? {
                group: data.group,
                members: data.members,
                canManage: s.detail.canManage,
              }
            : s.detail,
      }));
      await getState().load();
      return data.provisioning;
    } catch (err) {
      set({ busy: false, actionError: await message(err, "failed to provision the group") });
      return null;
    }
  },

  loadAdmin: async () => {
    set({ adminLoading: true, adminError: null });
    try {
      const data = await get<{ groups: GroupSummary[]; limit: number }>(
        "/api/admin/groups",
      );
      set({ adminGroups: data.groups, adminLoading: false });
    } catch (err) {
      set({
        adminLoading: false,
        adminError: await message(err, "failed to load groups"),
      });
    }
  },

  transfer: async (id, username) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<{
        group: GroupSummary;
        members: GroupDetail["members"];
        membership: CommandResult;
      }>(`/api/groups/${id}/owner`, { username });
      set({ busy: false });
      await getState().loadAdmin();
      await getState().load();
      return data.membership;
    } catch (err) {
      set({ busy: false, actionError: await message(err, "failed to transfer ownership") });
      return null;
    }
  },

  // Start (or re-run) a group's agent; poll its job so the page can show the
  // log and refresh the group when it finishes.
  startAgent: async (id) => {
    set({ busy: true, actionError: null, agentJobFor: id, agentJob: null });
    try {
      const data = await post<{ jobId: number }>(`/api/groups/${id}/hermes`);
      set({ busy: false });
      pollAgentJob(id, data.jobId);
      return data.jobId;
    } catch (err) {
      set({ busy: false, agentJobFor: null, actionError: await message(err, "could not start the agent") });
      return null;
    }
  },

  closeAgentJob: () => {
    // Keep polling in the background; only the modal closes.
    set({ agentJobFor: null, agentJob: null });
  },

  message: async (id, username, text) => {
    set({ busy: true, actionError: null });
    try {
      const data = await post<CommandResult>(`/api/groups/${id}/message`, {
        username,
        message: text,
      });
      set({ busy: false });
      return data;
    } catch (err) {
      set({ busy: false, actionError: await message(err, "failed to send the message") });
      return null;
    }
  },

  clearActionError: () => set({ actionError: null }),
}));

// Polling handle for the currently watched group agent job.
let agentPoll: ReturnType<typeof setTimeout> | null = null;

function pollAgentJob(groupId: number, jobId: number): void {
  if (agentPoll) {
    clearTimeout(agentPoll);
    agentPoll = null;
  }
  const tick = async () => {
    let detail: JobDetail;
    try {
      detail = await get<JobDetail>(`/api/jobs/${jobId}`);
    } catch {
      agentPoll = setTimeout(() => void tick(), 3000);
      return;
    }
    useGroupsStore.setState({ agentJob: detail });
    if (detail.job.status === "running") {
      agentPoll = setTimeout(() => void tick(), 2000);
      return;
    }
    agentPoll = null;
    await useGroupsStore.getState().load();
    const state = useGroupsStore.getState();
    if (state.detail?.group.id === groupId) await state.open(groupId);
  };
  void tick();
}
