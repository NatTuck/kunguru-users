import { create } from "zustand";
import { get } from "./api";

export interface AppConfig {
  baseDomain: string;
  xmppDomain: string;
}

interface ConfigState {
  config: AppConfig | null;
  load: () => Promise<void>;
}

// Domain names used to build per-account tool URLs (app, app-dev, WebUI, static
// sites) and the XMPP domain. Loaded once at app start; empty values (dev /
// unconfigured) disable the links.
export const useConfigStore = create<ConfigState>((set) => ({
  config: null,

  load: async () => {
    try {
      const data = await get<AppConfig>("/api/config");
      set({ config: data });
    } catch {
      set({ config: { baseDomain: "", xmppDomain: "" } });
    }
  },
}));

// Account host URLs. An account (a user, or a group) gets two app slots plus a
// managed WebUI on the base domain; a static site is its own label there.
// `baseDomain` empty (dev / unconfigured) disables the links.

/** Managed Hermes WebUI for an account: `<account>-agent.<base>`. */
export function agentUrl(baseDomain: string, username: string): string | null {
  if (!baseDomain) return null;
  return `https://${username}-agent.${baseDomain}/`;
}

/** Production app slot for an account: `<account>.<base>`. */
export function appUrl(baseDomain: string, username: string): string | null {
  if (!baseDomain) return null;
  return `https://${username}.${baseDomain}/`;
}

/** Dev app slot for an account: `<account>-dev.<base>`. */
export function appDevUrl(baseDomain: string, username: string): string | null {
  if (!baseDomain) return null;
  return `https://${username}-dev.${baseDomain}/`;
}

/** A static site owned by an account: `<label>.<base>`. */
export function staticSiteUrl(baseDomain: string, label: string): string | null {
  if (!baseDomain) return null;
  return `https://${label}.${baseDomain}/`;
}
