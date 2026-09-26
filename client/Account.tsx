import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Alert, Button, Card, Input, Spinner } from "@heroui/react";
import { Link } from "react-router-dom";
import { useCurrentUser } from "./guards";
import { useAuthStore } from "./authStore";
import {
  agentUrl,
  privateAppUrl,
  publicSiteUrl,
  useConfigStore,
} from "./configStore";
import { useSitesStore } from "./sitesStore";
import { StatusChip } from "./ui";

export default function Account() {
  const user = useCurrentUser();
  const config = useConfigStore((s) => s.config);
  const sites = useSitesStore((s) => s.sites);
  const sitesError = useSitesStore((s) => s.error);
  const loadSites = useSitesStore((s) => s.load);

  useEffect(() => {
    loadSites();
  }, [loadSites]);

  if (!user) return null;

  const baseDomain = config?.baseDomain ?? "";
  const privateDomain = config?.privateDomain ?? "";
  const agent = agentUrl(baseDomain, user.username);
  const publicApp = publicSiteUrl(baseDomain, user.username);
  const privateApp = privateAppUrl(privateDomain, user.username);

  const siteStatus = (slot: "public" | "private"): SiteCardStatus => {
    if (!sites) return sitesError ? "down" : "loading";
    if (!sites.provisioned) return "unavailable";
    return sites[slot].up ? "up" : "down";
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Kunguru Tools</h1>
      <div className="grid gap-4 sm:grid-cols-2">
        <ToolCard
          title="Your agent"
          description="Open your agent's web interface to see its chats and activity."
          href={agent}
        />
        <ToolCard
          title="Setting up XMPP"
          description="Chat with your agent from a phone or desktop XMPP app."
          to="/xmpp"
        />
        <SiteCard
          title="Public personal app"
          description={
            publicApp
              ? `Your own public site at ${user.username}.${baseDomain}.`
              : "Your own public site."
          }
          href={publicApp}
          status={siteStatus("public")}
        />
        <SiteCard
          title="Private personal app"
          description={
            privateApp
              ? `Only you can see it, at ${user.username}.${privateDomain}.`
              : "A private app only you can see."
          }
          href={privateApp}
          status={siteStatus("private")}
        />
      </div>

      <h2 className="mt-10 mb-4 text-2xl font-semibold tracking-tight">My account</h2>
      <Card className="p-6">
        <dl className="space-y-3">
          <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
            <dt className="text-sm text-neutral-500">Username</dt>
            <dd className="font-medium">{user.username}</dd>
          </div>
          <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
            <dt className="text-sm text-neutral-500">Role</dt>
            <dd>
              <StatusChip label={user.role} tone={user.role === "admin" ? "accent" : "neutral"} />
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-sm text-neutral-500">Created</dt>
            <dd className="text-sm">{user.created_at}</dd>
          </div>
        </dl>
        {user.role === "admin" && (
          <div className="mt-6">
            <Link to="/admin/users">
              <Button variant="secondary">Manage users</Button>
            </Link>
          </div>
        )}
      </Card>

      <h2 className="mt-10 mb-4 text-2xl font-semibold tracking-tight">Change password</h2>
      <ChangePasswordCard />
    </div>
  );
}

function ChangePasswordCard() {
  const changePassword = useAuthStore((s) => s.changePassword);
  const changing = useAuthStore((s) => s.changing);
  const changeError = useAuthStore((s) => s.changeError);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setDone(false);
    if (next !== confirm) {
      setLocalError("new passwords do not match");
      return;
    }
    if (next.length < 12) {
      setLocalError("password must be at least 12 characters");
      return;
    }
    if (await changePassword(current, next)) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    }
  };

  return (
    <Card className="p-6">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pw-current" className="text-sm font-medium">
            Current password
          </label>
          <Input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pw-new" className="text-sm font-medium">
            New password
          </label>
          <Input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
          <p className="text-xs text-neutral-500">
            At least 12 characters. This is also your XMPP password.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pw-confirm" className="text-sm font-medium">
            Confirm new password
          </label>
          <Input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>
        {(localError || changeError) && (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Description>{localError ?? changeError}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        {done && (
          <Alert status="success">
            <Alert.Content>
              <Alert.Description>
                Password changed. Update it in your XMPP client(s) too.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        <div>
          <Button type="submit" variant="primary" isDisabled={changing}>
            {changing ? (
              <span className="inline-flex items-center gap-2">
                <Spinner size="sm" /> Saving…
              </span>
            ) : (
              "Change password"
            )}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ToolCard({
  title,
  description,
  href,
  to,
}: {
  title: string;
  description: string;
  href?: string | null;
  to?: string;
}) {
  const inner = (
    <div className="h-full rounded-2xl border border-neutral-200 bg-white p-5 transition-colors hover:border-neutral-300">
      <div className="font-semibold">{title}</div>
      <p className="mt-1 text-sm text-neutral-500">{description}</p>
    </div>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="block">
        {inner}
      </a>
    );
  }
  if (to) {
    return (
      <Link to={to} className="block">
        {inner}
      </Link>
    );
  }
  return (
    <div className="h-full cursor-not-allowed rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 p-5">
      <div className="font-semibold text-neutral-400">{title}</div>
      <p className="mt-1 text-sm text-neutral-400">
        Available once your account is provisioned.
      </p>
    </div>
  );
}

type SiteCardStatus = "up" | "down" | "loading" | "unavailable";

/** A Kunguru Tools card that reports whether a personal app is up and links to
 * it only when it is. */
function SiteCard({
  title,
  description,
  href,
  status,
}: {
  title: string;
  description: string;
  href: string | null;
  status: SiteCardStatus;
}) {
  if (status === "unavailable") {
    return (
      <div className="h-full rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 p-5">
        <div className="font-semibold text-neutral-400">{title}</div>
        <p className="mt-1 text-sm text-neutral-400">
          Available once your account is provisioned.
        </p>
      </div>
    );
  }

  const chip =
    status === "up" ? (
      <StatusChip label="Up" tone="success" />
    ) : status === "down" ? (
      <StatusChip label="Down" tone="danger" />
    ) : (
      <StatusChip label="Checking…" tone="neutral" />
    );

  const inner = (
    <div
      className={`h-full rounded-2xl border border-neutral-200 bg-white p-5 transition-colors ${
        status === "up" ? "hover:border-neutral-300" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="font-semibold">{title}</div>
        {chip}
      </div>
      <p className="mt-1 text-sm text-neutral-500">{description}</p>
      {status === "down" && (
        <p className="mt-2 text-xs text-neutral-400">
          Not running yet — it will appear here once deployed.
        </p>
      )}
    </div>
  );

  if (status === "up" && href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="block">
        {inner}
      </a>
    );
  }
  return <div className="block">{inner}</div>;
}
