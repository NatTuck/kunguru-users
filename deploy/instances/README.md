# Instance configs

Each `<name>.json` is a deployment identity (domain, XMPP domain, host list,
LLM endpoint). Select one with `KUNGURU_INSTANCE=<name>`; there are no built-in
defaults, and a missing file or field refuses to start. No secrets live here —
they stay in the host's env file / `/etc`.

| File | Topology |
|---|---|
| `single.example.json` | One host: admin app + gateway + user server, no WireGuard. |
| `kunguru.net.json` | Gateway (drongo) + user server (swan) over WireGuard. |
| `ironbeard.com.json` | Legacy two-host instance. |

`runtime.authSocket` (e.g. `/run/kunguru-users/auth.sock`) moves the nginx auth
subrequest to a unix socket — recommended, and required for a clean one-host
deployment. Install `deploy/kunguru-users.tmpfiles` first (see `notes/deploy.md`
§4a).

A single-host config may omit `gatewayWgIp`; it is required as soon as a host is
not `sshTarget: "localhost"`. `gatewayHost` and `snikketHost` must name a host
in `hosts`. See `notes/topology.md`.
