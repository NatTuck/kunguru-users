import { create } from "zustand";
import { ApiError, del, get, post } from "./api";
import type {
  CommandResult,
  GroupDetail,
  GroupProvisionInfo,
  GroupSummary,
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

  clearActionError: () => set({ actionError: null }),
}));
