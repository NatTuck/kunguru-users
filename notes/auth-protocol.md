# App authentication protocol (kunguru gateway)

Status: **implemented** (Phase 1 + Phase 2a of `notes/groups-and-apps.md`) on
`feature/groups`, not yet deployed. Audience: tenant app authors; the same
contract is embedded in the `kunguru-sites` skill.

The gateway is the only authentication authority. Apps never implement password
login and never see the session cookie. They receive **verified identity
headers** from the gateway and, when they need a login, redirect to the central
login page.

---

## 1. Identity headers

The gateway sets these on every proxied app request, always overwriting any
client-supplied value:

| Header | Value |
|---|---|
| `Remote-User` | the signed-in username, or empty for anonymous |
| `Remote-Groups` | comma-separated group names the user belongs to, or empty |
| `X-Kunguru-Identity` | a short-lived EdDSA JWT asserting the same identity (see below), or absent |

Rules:

- **Empty `Remote-User` = anonymous.** Never treat a missing header as an
  identity.
- The gateway **strips the session cookie** (`kunguru_sid`) from the request
  `Cookie` header before proxying. It does **not** filter response
  `Set-Cookie` headers, so an app must never set a cookie with
  `Domain=<base>` (that would be sent to every host, including the login app —
  cookie tossing). Scope your own cookies to your own hostname. Apps must not
  expect `kunguru_sid` and must not try to read it.
- The gateway strips any inbound `Remote-User`/`Remote-Groups` from the client
  and re-sets them, so they cannot be spoofed through the proxy.
- Apps must trust these headers **only** from the gateway's WireGuard IP (the
  same trusted-proxy contract as today). Bind the address the gateway reaches,
  and compare the TCP peer.

### Signed identity token (recommended)

`X-Kunguru-Identity` is a compact JWT (`alg: EdDSA`, `kid`) minted per request
by `/internal/auth` and forwarded by the gateway. It is the **unforgeable** form
of the same identity: unlike `Remote-User`, another local process cannot
produce a valid one.

```json
{
  "iss": "https://users.<base>",
  "aud": "<the exact hostname the request was for>",
  "sub": "<username>",
  "grp": ["<group>", "..."],
  "iat": 1700000000,
  "exp": 1700000060,
  "jti": "..."
}
```

Verification rules:

- verify the signature with the instance public key
  (`GET https://users.<base>/api/identity-key` returns `publicKeyPem` and
  `publicKeyDer`; the base64 DER is also provisioned into the `kunguru-sites`
  skill as `KUNGURU_IDENTITY_PUBKEY_DER`);
- require `aud` to equal your own hostname (tokens are audience-bound, so a
  token captured by another app cannot be replayed against yours);
- require `iss` to be the auth host and `exp` to be in the future (allow a
  small clock skew);
- **no token = anonymous.** Never use claims from an unverified token.
- It expires in 60 seconds and is minted per request; there is no revocation
  list. Treat it as an assertion about *this* request.

The headers remain for compatibility and for apps that only do the peer check;
apps that can verify the token should prefer it.

---

## 2. Login redirect (the standard protocol)

When an app wants the visitor to sign in, redirect the browser to:

```
GET https://users.<base>/login?next=<urlencoded absolute URL>
```

- `<base>` is the instance domain (e.g. `kunguru.net`); the auth host is
  `users.<base>`.
- `next` is the absolute URL the user should return to. Build it from the
  current request, e.g. `https://<app-host><path>` and URL-encode it.
- The login page signs the user in, then navigates to the server-validated
  `next` (`window.location.replace(redirectTo)`).
- `next` is validated server-side: same-origin absolute paths, or a
  **single-label host under `<base>`** (`<label>.<base>`). During the `.users.`
  migration window, single-label hosts under `users.<base>` are also allowed.
  Anything else is rejected (no open redirects).

### Required-auth hosts

A host marked `require_auth` (the WebUI, an app with `require_auth`, or a
`require_auth` static site) is handled entirely by the gateway: nginx returns
`401` and redirects to the login page with `next=<current URL>`. The app needs no
login code.

### Optional hosts (default)

Most apps are optional: anonymous is allowed and `Remote-User` is populated when
the visitor is signed in. If the app wants to require login for a particular
action, it redirects to the login URL itself:

```js
if (!req.user) {
  const next = `https://${req.get("host")}${req.originalUrl}`;
  return res.redirect(
    `https://users.example.net/login?next=${encodeURIComponent(next)}`
  );
}
```

---

## 3. Auth status (JSON)

For SPAs that need client-side user info:

```
GET https://users.<base>/api/auth/me
```

- `200 { "user": { id, username, role, created_at } }` when signed in.
- `401` when anonymous.

The server-side `Remote-User` remains the authoritative identity for the app's
own backend; this endpoint is for client-side display/state.

---

## 4. Logout

```
POST https://users.<base>/api/auth/logout
```

Clears the session cookie. The app then navigates back to itself (or to the
auth host's login page). Because the session cookie is scoped to `<base>`, a
logout affects every app host.

---

## 5. Example (Express)

`example.net` below stands for your instance's `<base>`.

```js
const GATEWAY_WG_IP = "10.10.1.1"; // from references/local.md

app.use((req, res, next) => {
  const peer = (req.socket.remoteAddress || "").replace("::ffff:", "");
  const trusted = peer === GATEWAY_WG_IP;
  req.user = trusted ? (req.get("Remote-User") || null) : null;
  req.groups = trusted
    ? (req.get("Remote-Groups") || "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  next();
});

// Optional auth: anonymous is allowed; identity is available when signed in.
app.get("/", (req, res) => {
  res.send(req.user ? `Hello ${req.user}` : "Hello, anonymous");
});

// Require auth for an action: redirect to the central login.
app.get("/private", (req, res) => {
  if (!req.user) {
    const next = `https://${req.get("host")}${req.originalUrl}`;
    return res.redirect(
      `https://users.example.net/login?next=${encodeURIComponent(next)}`
    );
  }
  res.send(`Hello ${req.user}; groups: ${req.groups.join(", ") || "none"}`);
});
```

---

## 6. Security notes

- **Trust only the gateway's WG IP** for `Remote-*`. Ignore them from any other
  peer.
- **Do not read or forward the session cookie** — it is stripped by the gateway.
- **CSRF/origin checks** are still required for state-changing endpoints:
  subdomains of `<base>` are *same-site*, so `SameSite` cookies do not protect
  the auth host from a compromised sibling app. Validate `Origin`/`Referer` (or
  use a CSRF token) on the auth app's mutating routes.
- Apps are trusted to act for the signed-in user **on their own requests**;
  they cannot use `Remote-User` against another app (it is set per request by
  the gateway).
- `next` is validated by the auth server; do not construct cross-site targets.
- Keep `Remote-*` out of logs if you log request headers.
- **Every vhost that proxies to an upstream must strip `kunguru_sid`** (the
  repo-managed user-sites, Snikket, and Bifrost vhosts do; the auth app is the
  only one that keeps it). The broad `Domain=<base>` cookie is fail-open: any
  hand-managed/legacy vhost that forgets the strip will hand the session cookie
  to its upstream. Audit all vhosts before broadening the cookie on a host.
- **`/internal/auth` is nginx-only.** With `runtime.authSocket` set it listens
  on a root-created unix socket in a directory owned by the app user and group
  `www-data`; local users can neither reach nor bind it. Without it, it is a
  loopback TCP endpoint (fine only where the gateway host has no untrusted
  local users).
- **The user-server static nginx** must only accept the gateway's WG IP
  (`allow <gateway-wg-ip>; deny all;`); `require_auth` static sites are gated at
  the gateway before the request is forwarded.
- **The trusted-proxy rule is topology-dependent.** It assumes the app is not
  co-located with untrusted tenants. On a one-host deployment every account
  shares the network namespace, so loopback is not a trust boundary: a
  co-located app must not rely on the peer-IP check alone, and identity must
  come from a signed token (roadmap) or the instance must be cooperative-only.
  See `notes/topology.md` §3.

---

## 7. Migration notes

- **Phase 1** broadens the session cookie to `Domain=<base>`, strips it on every
  upstream vhost except the auth app, injects `Remote-User`/`Remote-Groups`, and
  adds optional/required behavior to `/internal/auth`. `sanitizeNext` is
  broadened to accept single-label hosts under `<base>` (and keeps
  `.users.<base>` during the migration).
- **Two-port model (implemented)**: the old slots are now app
  `<account>.<base>` (`12000+id`), app-dev `<account>-dev.<base>` (`13000+id`),
  and WebUI `<account>-agent.<base>` (`11000+id`). The `.users.` app subtree is
  retired: `/internal/auth` resolves those three hosts plus static sites, and
  the gateway vhost is one wildcard block (`*.<base>`) driven by a
  host->upstream map.
- **Static sites (implemented)**: served by nginx on the owner's host; the
  gateway forwards `<label>.<base>` to `<owner-host>:14000` and applies the
  site's `require_auth` gate. Source lives at `~/sites/<label>`; the served
  docroot is `~/www/<label>`. `scripts/nginx/ensure-user-static.sh` renders the
  host listener and fixes directory permissions/ACLs.
- **Signed identity (P3)**: `/internal/auth` mints the token; nginx forwards it
  as `X-Kunguru-Identity`; the public key is served at `/api/identity-key` and
  provisioned into the `kunguru-sites` skill. This is additive — apps that
  ignore the token behave exactly as before.
- **Deployment cutover (not done)**: this branch is not deployed. On a live
  instance the hand-managed legacy vhosts (`ops`, `ops-dev`, `gitbot`,
  `tongue-tie-dev`, the `tasks.*` `/api/` locations, the static `docs` vhost)
  must be removed when the new routes land, since a legacy vhost that proxies
  without the cookie strip is fail-open once the cookie is `<base>`-wide.
  `docs` migrates to a static site (the DB migration creates the row; the files
  move from the gateway docroot to `<owner>~/www/docs`).
- **Retired `.users.` hosts** get a permanent redirect from the gateway:
  `<x>-agent.users.<base>` → `<x>-agent.<base>` and `<x>.users.<base>` →
  `<x>-dev.<base>`. This needs the `*.users.<base>` SAN, so that SAN is retained
  for now; remove the redirect (and the SAN) once old bookmarks are gone.
- **Static sites owned on the gateway host** are served from the gateway vhost's
  docroot, not from a loopback listener: a loopback listener would let any local
  process read a `require_auth` site by sending the `Host` header directly.
