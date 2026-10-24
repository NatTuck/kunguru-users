# Deployment topologies

Status: **gateway + user servers is the reference config; one host is a
supported config that is not yet first-class.** This doc records the topology
model, the single-host requirements, and the constraints current work must
respect so it does not close the door on one-host deployments.

Related: `DESIGN.md` (problem statement), `expanded-design.md` (trust model),
`auth-protocol.md`, `deploy.md`, `initial-setup.md`,
`groups-and-apps.md` §14 (multi-host, deferred).

---

## 1. Roles

| Role | Runs |
|---|---|
| admin app | `kunguru-users` + its SQLite DB — always on the host that runs nginx, because `/internal/auth` is a loopback endpoint for nginx |
| gateway | public nginx/TLS, the auth gate, Snikket, Bifrost |
| user server | tenant Linux accounts, Hermes agents, WebUIs, tenant apps, static docroots |

Roles may overlap (`DESIGN.md`). A host row's `role` column is informational
(ordering/display only): routing and provisioning resolve hosts by name
(`gatewayHost`, `snikketHost`) and by `sshTarget`. `sshTarget: "localhost"`
means "the host the app itself runs on" — the existing co-located convention in
`server/provision.ts` and `server/nginx.ts`.

## 2. Configs

### 2.1 Gateway + user servers (reference)

- WireGuard connects the gateway and the user servers.
- Accounts live on a user server; apps bind that server's VPN address; the
  gateway proxies to `<user-server>:<port>` over the VPN.
- Identity is trusted by IP: apps accept `Remote-User`/`Remote-Groups` only from
  the gateway's VPN address (see `auth-protocol.md`).
- Static sites are served by the nginx on the owner's host on
  `PORT_STATIC_SITES` (14000); the gateway forwards to it.
- WebUIs run on the user server and bind its VPN address.

### 2.2 One host (supported; small instances)

All roles on one machine. Sketch (`deploy/instances/`):

```json
{
  "domain": "example.net",
  "cookieDomain": "users.example.net",
  "gatewayHost": "solo",
  "snikketHost": "solo",
  "gatewayWgIp": "",
  "hosts": [{ "name": "solo", "role": "admin", "sshTarget": "localhost" }]
}
```

Other fields (ACME email, cert name, SSH user, XMPP domain, LLM endpoint,
runtime) are as in the reference instance. `gatewayWgIp` is shown empty because
nothing consumes it when every account is co-located; today's validator still
requires a value (P1 makes it conditional).

What runs where:

- the admin app, nginx, Snikket, and Bifrost on the host;
- every account on the same host; apps and WebUIs bind `127.0.0.1`;
- no WireGuard is needed (a single host has no peers to reach);
- account routes proxy to `127.0.0.1:<port>` (`upstreamHost("localhost")`
  already maps this);
- static sites are served by the **gateway vhost** from
  `/home/<owner>/www/<label>` — the gateway host's static script runs in
  directories+ACLs mode (`KUNGURU_STATIC_LISTEN=0`) and no `:14000` listener is
  created;
- `users.<base>`, TLS, certificates, and the retired `.users.` redirect are
  unchanged.

Already true in the code: host resolution, loopback upstreams, co-located bind
addresses and trusted proxy, local static serving, and the reconcile split
between gateway routes and host docroots.

Not yet first-class (see §5): optional `gatewayWgIp`, a local transport,
bootstrap without WireGuard, host pruning, and templates/runbook.

## 3. Trust boundary (decision needed)

`expanded-design.md` says OS-native account permissions are the boundary
between tenants. That is the **filesystem** boundary. Network isolation is a
separate axis, and it depends on the topology.

On one host every tenant shares the network namespace with the gateway and with
the other tenants, so loopback is not a trust boundary:

- **impersonation** — tenant A connects to tenant B's app port with
  `Remote-User: B`; the app trusts `127.0.0.1` and acts as B;
- **auth authority** — `/internal/auth` is `127.0.0.1:3030`; a tenant that binds
  that port while the app is down becomes nginx's auth authority and can assert
  any identity to any app;
- **WebUI** — the third-party WebUI trusts the header by proxy IP and cannot
  verify a signature;
- **port squatting** — a tenant binds another account's free port and receives
  that account's proxied traffic (this exists on a user server too; it is easier
  and more consequential on one host).

Options:

| | What | Cost |
|---|---|---|
| T1 | Cooperative-only one host: document that accounts on a one-host instance must trust each other | none; contradicts the stated isolation boundary unless made explicit |
| T2 | Auth socket + signed identity: `/internal/auth` on a unix socket in a root-created directory (kills the auth-authority squat; useful in both configs) and an Ed25519 per-request token with `aud` = host so apps verify instead of trusting an IP (kills impersonation for apps that verify; the WebUI needs upstream support) | contained + medium |
| T3 | Per-account network namespaces/containers: true parity | large, out of scope |

Recommendation: **T1 + the auth socket now** (documented, and the socket is a
hardening in both configs), **signed identity alongside Phase 3** (it pairs with
`Remote-Groups`/`SOUL.md`/WebUI identity), **T3 deferred**. If one-host
instances are meant for mutually untrusted accounts, T1 alone is not enough —
say so before calling one host "safe".

## 4. Constraints for current work (do not break one host)

Any change on `feature/groups` (Phase 2b/3) must keep these true:

1. Resolve hosts from the `hosts` table/config; never hardcode a second host, a
   VPN address, or `10.10.1.x`. Derive addresses from `sshTarget`.
2. Treat `sshTarget === "localhost"` as "the app's own host" everywhere:
   loopback bind addresses, trusted proxy, static serving, reconcile, bootstrap.
3. Do not make the gateway's peer-IP check the *only* identity mechanism in a
   way that cannot later be replaced by a signed token: keep the
   `/internal/auth` response shape and the nginx injection point separable.
4. Do not require WireGuard or ssh-to-self in new steps.
5. Static sites: keep the "docroot served by the gateway vhost" path working;
   never reintroduce a loopback listener for co-located sites.
6. Ports stay the deterministic `11000/12000/13000 + id` (plus static `14000`);
   no per-host constants that only work when the app is remote.
7. Do not assume there are two or more hosts, or that the gateway is not also a
   user server, anywhere in routes/auth/provisioning/reconcile.
8. Anything new that runs per account must be memory-bounded: one host runs the
   auth app + gateway + Snikket + Bifrost + every agent.

## 5. Gaps to close (P1, functional)

| Gap | Fix |
|---|---|
| `gatewayWgIp` is required even when unused | require it only when a non-local host exists; drop the unused `KUNGURU_GATEWAY_WG_IP` plumbing in `hermes/ensure.sh` |
| every host operation is `ssh <user>@localhost` | local exec (`sudo -n env -i … bash -s`) when `sshTarget` is `localhost`, with the same stdin/timeout contract |
| bootstrap always does WireGuard | a single-host mode that skips it (one `group.conf` host with role `hub`) |
| `ensureHostSeed` never disables hosts removed from config | prune/disable config-absent hosts (explicit flag or CLI) |
| no one-host template or runbook | `deploy/instances/single.example.json`, a single-host `group.conf` example, and an `initial-setup.md` variant |
| capacity/availability | document; `MemoryMax` on app units in Phase 2b |

## 6. Phases

- **P1 — functional one host**: config, transport, bootstrap, host pruning,
  templates, docs.
- **P2 — auth socket** (both configs).
- **P3 — signed identity** with the groups work.
- **P4 — per-account isolation** (deferred).

## 7. Touchpoints

- `server/config.ts` — conditional `gatewayWgIp`
- `server/transport/run.ts` — local exec
- `server/inventory.ts`, `server/provision.ts` — co-located handling (already)
- `server/nginx.ts` — local static serving (already); auth socket target
- `scripts/bootstrap/bootstrap.sh` + `group.conf.example`
- `scripts/nginx/ensure-user-sites.sh`, `ensure-user-static.sh` (already)
- `deploy/instances/`, `notes/initial-setup.md`, `notes/deploy.md`
- `notes/auth-protocol.md` — topology caveat

## 8. Verification (P1)

Fresh single-host VM/container, with no SSH keys and no WireGuard:

- bootstrap `--check` / `--apply` with a one-host `group.conf`;
- app start; create and provision an account;
- `<account>.<base>`, `<account>-dev.<base>`, `<account>-agent.<base>`;
- a public and a `require_auth` static site (served by the gateway vhost);
- a disabled owner returns 403; the `.users.` redirect works; deleting the last
  site on the host converges; a failed host reconcile drops its routes;
- `gatewayWgIp` omitted from the instance JSON.

## 9. Open decisions

1. Trust posture: T1 + auth socket (recommended) vs T2 now vs T3.
2. Local transport vs ssh-to-self (recommended: local).
3. Keep the WireGuard-capable path so a user server can be added later
   (recommended: yes, with no WireGuard required today).
4. Host role name for the one host: keep `admin` (recommended) or add
   `standalone`.
