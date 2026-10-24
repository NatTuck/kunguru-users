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

// Static sites for one owner. With `userId` it is the admin view of another
// account's sites; without it, the signed-in user's own sites (self-service).
// A site is `<label>.<base>`, served from the owner's `~/www/<label>`; the
// source/build project is `~/sites/<label>` — the source path is shown so the
// owner knows where to build.
export default function StaticSitesPanel({ userId }: { userId?: number }) {
  const config = useConfigStore((s) => s.config);
  const baseDomain = config?.baseDomain ?? "";
  const base =
    userId == null
      ? "/api/me/static-sites"
      : `/api/users/${userId}/static-sites`;

  const [sites, setSites] = useState<StaticSite[] | null>(null);
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState("public");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const d = await get<{ sites: StaticSite[] }>(base);
      setSites(d.sites);
    } catch {
      setSites([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(base, { label, requireAuth: access === "private" });
      setLabel("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to add static site");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    setBusy(true);
    setError(null);
    try {
      await del(`/api/static-sites/${id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to remove static site");
    } finally {
      setBusy(false);
    }
  };

  const setAuth = async (id: number, requireAuth: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/static-sites/${id}`, { requireAuth });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to change access");
    } finally {
      setBusy(false);
    }
  };

  const atLimit = sites != null && sites.length >= 5;

  return (
    <div className="space-y-5">
      {error && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
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
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={busy}
                      onPress={() => void setAuth(s.id, !s.require_auth)}
                    >
                      {s.require_auth ? "Make public" : "Require login"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={busy}
                      onPress={() => void remove(s.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

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
            This owner already has the maximum of 5 static sites.
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
    </div>
  );
}
