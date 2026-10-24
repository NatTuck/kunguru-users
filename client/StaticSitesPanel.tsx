import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Input,
  Label,
  Radio,
  RadioGroup,
  Spinner,
} from "@heroui/react";
import { del, get, patch, post } from "./api";
import { useConfigStore, staticSiteUrl } from "./configStore";
import type { StaticSite } from "./types";
import { Mono, StatusChip } from "./ui";

// Static sites for one account (a user, or a group). The same panel is used on
// the Account page, in the admin per-account modal, and on the Groups page
// (where `canManage` is false for a group member: members can read the list but
// only the group's owner creates/removes sites).
// A site is `<label>.<base>`, served from the owner's `~/www/<label>`; the
// source/build project is `~/sites/<label>`.
export default function StaticSitesPanel({
  accountId,
  canManage = true,
}: {
  accountId: number;
  canManage?: boolean;
}) {
  const config = useConfigStore((s) => s.config);
  const baseDomain = config?.baseDomain ?? "";
  const base = `/api/accounts/${accountId}/static-sites`;

  const [sites, setSites] = useState<StaticSite[] | null>(null);
  const [limit, setLimit] = useState(5);
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState("public");
  const [error, setError] = useState<string | null>(null);
  // The site was saved but the nginx/gateway reconcile did not fully converge.
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);

  const load = async () => {
    try {
      const d = await get<{ sites: StaticSite[]; limit?: number }>(base);
      setSites(d.sites);
      if (typeof d.limit === "number") setLimit(d.limit);
    } catch (e) {
      setSites([]);
      setError(
        e instanceof Error ? e.message : "failed to load static sites",
      );
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  type Reconcile = { ok: boolean; output: string };
  type MutationReply = { sites?: Reconcile };

  // Every mutation returns the reconcile result. A failed reconcile means the
  // database is right but the route may not be live yet, so say so instead of
  // pretending the site works.
  const mutate = async (fn: () => Promise<MutationReply>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const reply = await fn();
      if (reply.sites && !reply.sites.ok) {
        setNotice(
          `Saved, but the route did not converge: ${
            reply.sites.output.trim() || "no output"
          }`,
        );
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    mutate(async () => {
      const reply = await post<MutationReply>(base, {
        label,
        requireAuth: access === "private",
      });
      setLabel("");
      return reply;
    });

  const remove = (id: number) =>
    mutate(() => del<MutationReply>(`/api/static-sites/${id}`));

  const setAuth = (id: number, requireAuth: boolean) =>
    mutate(() => patch<MutationReply>(`/api/static-sites/${id}`, { requireAuth }));

  const atLimit = sites != null && sites.length >= limit;

  return (
    <div className="space-y-5">
      {error && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {notice && (
        <Alert status="warning">
          <Alert.Content>
            <Alert.Description>{notice}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <div className="space-y-2">
        {sites == null ? (
          <Spinner size="sm" />
        ) : sites.length === 0 ? (
          <p className="text-sm text-neutral-500">No static sites yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
            {sites.map((s) => {
              const url = s.hostname
                ? `https://${s.hostname}/`
                : staticSiteUrl(baseDomain, s.label);
              return (
                <li key={s.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-sm break-all hover:underline"
                        >
                          {s.hostname || s.label}
                        </a>
                      ) : (
                        <Mono>{s.label}</Mono>
                      )}
                      <StatusChip
                        label={s.require_auth ? "login required" : "public"}
                        tone={s.require_auth ? "accent" : "neutral"}
                      />
                    </div>
                    <div className="text-xs text-neutral-500">
                      source <span className="font-mono">{s.source_root}</span>
                      {" · "}
                      served <span className="font-mono">{s.served_root}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={busy}
                        onPress={() => void setAuth(s.id, !s.require_auth)}
                      >
                        {s.require_auth ? "Make public" : "Require login"}
                      </Button>
                    )}
                    {canManage && confirming === s.id ? (
                      <>
                        <Button
                          size="sm"
                          variant="danger"
                          isDisabled={busy}
                          onPress={() => {
                            setConfirming(null);
                            void remove(s.id);
                          }}
                        >
                          Confirm
                        </Button>
                        <Button
                          size="sm"
                          variant="tertiary"
                          onPress={() => setConfirming(null)}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : canManage ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={busy}
                        onPress={() => setConfirming(s.id)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {canManage && sites != null && sites.length > 0 && (
          <p className="text-xs text-neutral-500">
            Removing a site drops its route; the files in{" "}
            <span className="font-mono">~/sites</span> and{" "}
            <span className="font-mono">~/www</span> are kept.
          </p>
        )}
      </div>

      {canManage && (
      <div className="space-y-3 border-t border-neutral-100 pt-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="site-label">Label</Label>
          <Input
            id="site-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="docs"
          />
          <p className="text-xs text-neutral-500">
            The site is served at{" "}
            <span className="font-mono">
              {label || "<label>"}.{baseDomain || "<base>"}
            </span>
            . Build its output into{" "}
            <span className="font-mono">~/www/{label || "<label>"}</span>.
          </p>
        </div>

        <div className="text-sm font-medium">Access</div>
        <RadioGroup
          value={access}
          onChange={(v) => setAccess(v ?? "public")}
          className="gap-2"
        >
          <Radio value="public">
            <Radio.Content>
              <Radio.Control>
                <Radio.Indicator />
              </Radio.Control>
              Public — anyone can load it
            </Radio.Content>
          </Radio>
          <Radio value="private">
            <Radio.Content>
              <Radio.Control>
                <Radio.Indicator />
              </Radio.Control>
              Require login — the gateway redirects visitors to the login page
            </Radio.Content>
          </Radio>
        </RadioGroup>

        {atLimit && (
          <p className="text-xs text-neutral-500">
            This owner already has the maximum of {limit} static sites.
          </p>
        )}

        <div className="flex justify-end">
          <Button
            variant="primary"
            isDisabled={busy || !label || atLimit}
            onPress={() => void add()}
          >
            Add static site
          </Button>
        </div>
      </div>
      )}
    </div>
  );
}
