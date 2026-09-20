import { Button, Card } from "@heroui/react";
import { Link } from "react-router-dom";
import { useCurrentUser } from "./guards";
import { agentUrl, useConfigStore } from "./configStore";
import { StatusChip } from "./ui";

export default function Account() {
  const user = useCurrentUser();
  const config = useConfigStore((s) => s.config);
  if (!user) return null;

  const agent = agentUrl(config?.baseDomain ?? "", user.username);

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
    </div>
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
