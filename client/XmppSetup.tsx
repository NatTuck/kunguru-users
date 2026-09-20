import { Card } from "@heroui/react";
import { useCurrentUser } from "./guards";
import { useConfigStore } from "./configStore";
import { Mono } from "./ui";

interface ClientLink {
  name: string;
  href: string;
  note?: string;
}

const CLIENTS: { os: string; items: ClientLink[] }[] = [
  {
    os: "Linux",
    items: [
      { name: "Gajim", href: "https://gitlab.com/gajim/gajim", note: "Full-featured desktop client." },
      { name: "Dino", href: "https://dino.im/", note: "Modern, simple GTK client." },
    ],
  },
  {
    os: "Windows",
    items: [
      { name: "Gajim", href: "https://gitlab.com/gajim/gajim", note: "Full-featured desktop client." },
      { name: "Psi", href: "https://psi-im.org/", note: "Lightweight desktop client." },
    ],
  },
  {
    os: "macOS",
    items: [
      { name: "Monal", href: "https://monal-im.org/", note: "Also available on iOS." },
      { name: "Siskin IM", href: "https://siskin.im/", note: "Native macOS client." },
    ],
  },
  {
    os: "iOS",
    items: [
      { name: "Monal", href: "https://monal-im.org/", note: "Free, open source." },
      { name: "Snikket", href: "https://snikket.org/app/", note: "Easiest on mobile." },
    ],
  },
  {
    os: "Android",
    items: [
      { name: "Conversations", href: "https://conversations.im/", note: "Widely used, supports OMEMO." },
      { name: "Snikket", href: "https://snikket.org/app/", note: "Easiest on mobile." },
    ],
  },
];

export default function XmppSetup() {
  const user = useCurrentUser();
  const config = useConfigStore((s) => s.config);
  if (!user) return null;

  const domain = config?.xmppDomain ?? "";
  const jid = domain ? `${user.username}@${domain}` : "";

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Setting up XMPP</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Your Kunguru account works with any standard XMPP (Jabber) client. Sign in with your
        Kunguru username and the same password you use here.
      </p>

      <Card className="mb-6 p-6">
        <dl className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 pb-3">
            <dt className="text-sm text-neutral-500">Address (JID)</dt>
            <dd>{jid ? <Mono>{jid}</Mono> : <span className="text-neutral-400">—</span>}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 pb-3">
            <dt className="text-sm text-neutral-500">Server</dt>
            <dd>{domain ? <Mono>{domain}</Mono> : <span className="text-neutral-400">—</span>}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-sm text-neutral-500">Password</dt>
            <dd className="text-sm">the same password you use to sign in here</dd>
          </div>
        </dl>
      </Card>

      <div className="mb-8 rounded-2xl border border-neutral-200 bg-white p-5 text-sm text-neutral-600">
        Turn on <strong>OMEMO</strong> encryption in your client if it offers it. Your agent
        supports it, and you can verify each other&rsquo;s devices from the app.
      </div>

      <h2 className="mb-3 text-lg font-semibold">Choose a client</h2>
      <div className="space-y-6">
        {CLIENTS.map(({ os, items }) => (
          <section key={os}>
            <h3 className="mb-2 text-sm font-medium text-neutral-500">{os}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {items.map((c) => (
                <a
                  key={c.name}
                  href={c.href}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-2xl border border-neutral-200 bg-white p-4 transition-colors hover:border-neutral-300"
                >
                  <div className="font-semibold">{c.name}</div>
                  {c.note && <p className="mt-1 text-sm text-neutral-500">{c.note}</p>}
                </a>
              ))}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-8 text-sm text-neutral-500">
        On mobile, the{" "}
        <a
          className="underline"
          href="https://snikket.org/app/"
          target="_blank"
          rel="noreferrer"
        >
          Snikket app
        </a>{" "}
        is the easiest option: pick &ldquo;Other&rdquo; / advanced, then enter the server and your
        username.
      </p>
    </div>
  );
}
