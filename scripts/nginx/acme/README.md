# ACME / TLS for per-user sites

The per-user sites vhost (`kunguru-user-sites`), the admin app vhost
(`kunguru-users`), and the Bifrost vhost (`bifrost-llm`) all reuse one cert,
`/etc/letsencrypt/live/<sitesCert>/`, issued and renewed here.

## What it covers

```
*.kunguru.net          users. (app), llm. (Bifrost), <user>., public aliases
*.users.kunguru.net    <user>.users., <user>-agent.users., private aliases
```

The SAN set is **fixed**, so the certificate is issued once and renewed by
`certbot.timer`. `scripts/nginx/ensure-user-sites.sh` (run on every user/alias
change) never touches certificates — it only renders vhosts. Adding users or
aliases no longer re-issues anything.

The apex (`kunguru.net` / `www.kunguru.net`) keeps its own cert and vhost; it is
deliberately not folded in.

## Why DNS-01 (and why the label layout matters)

Wildcards require DNS-01. Joker's API (`svc.joker.com/nic/replace`) **replaces
all TXT values at a label** on every call and cannot be read back. That is fine
here because the two names validate on *different* labels
(`_acme-challenge.kunguru.net` vs `_acme-challenge.users.kunguru.net`), so each
call sets a distinct label — one value per call, no accumulation.

If the apex is ever added to this DNS-01 cert it would share the
`_acme-challenge.kunguru.net` label with the wildcard, and `joker-hook.sh` would
then need to accumulate values per label (as `acme.sh`'s `dns_joker.sh` does).
This is also why the third-party `certbot-dns-joker` plugin fails for
apex+wildcard.

## Files

| File | Purpose |
|---|---|
| `joker-hook.sh` | certbot manual auth/cleanup hook: sets/clears one TXT record via Joker. |
| `ensure-sites-cert.sh` | Issues/renews the wildcard cert (idempotent; re-issues if SANs drift). |
| `install.sh` | Installs both to `/usr/local/lib/kunguru/acme/` (ensure-user-sites.sh is piped over stdin, so it needs an absolute path). |

## Credentials

Per-zone, root:root 0600 shell env file (matches `/etc/bifrost/env`):

```sh
# /etc/letsencrypt/secrets/kunguru.net.env
JOKER_API_MODE=SVC
JOKER_USERNAME=<per-domain DynDNS username>
JOKER_PASSWORD=<per-domain DynDNS password>
```

Enable "Dynamic DNS active" for the zone in the Joker console to obtain the
username/password.

## First issue (runbook)

```sh
sudo bash scripts/nginx/acme/install.sh
sudo KUNGURU_BASE_DOMAIN=kunguru.net KUNGURU_ACME_EMAIL=you@example.com \
  /usr/local/lib/kunguru/acme/ensure-sites-cert.sh
sudo mise exec -- pnpm sites-reconcile     # render the HTTPS vhost now the cert exists
```

Renewal is automatic (`certbot.timer`); `--deploy-hook 'systemctl reload nginx'`
reloads nginx after a renewal. Test end to end with:

```sh
sudo certbot renew --dry-run    # staging ACME; still creates/removes real TXT records
```
