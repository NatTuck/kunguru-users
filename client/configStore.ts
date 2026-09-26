import { create } from "zustand";
import { get } from "./api";

export interface AppConfig {
  baseDomain: string;
  privateDomain: string;
  xmppDomain: string;
}

interface ConfigState {
  config: AppConfig | null;
  load: () => Promise<void>;
}

// Domain names used to build per-user tool URLs (agent WebUI host, XMPP domain).
// Loaded once at app start; empty values (dev / unconfigured) disable the links.
export const useConfigStore = create<ConfigState>((set) => ({
  config: null,

  load: async () => {
    try {
      const data = await get<AppConfig>("/api/config");
      set({ config: data });
    } catch {
      set({ config: { baseDomain: "", privateDomain: "", xmppDomain: "" } });
    }
  },
}));

/** Agent WebUI URL for a user, or null when the base domain is unconfigured. */
export function agentUrl(baseDomain: string, username: string): string | null {
  if (!baseDomain) return null;
  return `https://${username}-agent.users.${baseDomain}/`;
}

/** Public personal-app URL for a user, or null when the base domain is unset. */
export function publicSiteUrl(baseDomain: string, username: string): string | null {
  if (!baseDomain) return null;
  return `https://${username}.${baseDomain}/`;
}

/** Private personal-app URL (session-gated), or null when unconfigured. */
export function privateAppUrl(privateDomain: string, username: string): string | null {
  if (!privateDomain) return null;
  return `https://${username}.${privateDomain}/`;
}
