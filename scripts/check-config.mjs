#!/usr/bin/env node
// check-config.mjs — enforce "no built-in instance identity".
//
// Runtime server code must read all deployment-specific values (domains,
// endpoints, providers, hosts) from the per-instance config (server/config.ts).
// This static check fails the build if server code reintroduces:
//   A. a foreign/instance host literal (e.g. ironbeard, ferrus, deepseek,
//      otter, goose, or any `host.tld` string), or
//   B. a direct read of an identity env var outside server/config.ts (which
//      also forbids `??`/`||` defaults on those vars).
//
// It is deliberately dependency-free and runs as `pnpm check`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const serverDir = join(root, "server");

// The single place allowed to read identity env / hold instance literals.
const ALLOWLIST = new Set(["server/config.ts"]);
const isTest = (rel) => rel.endsWith(".test.ts") || rel.endsWith(".spec.ts");

const IDENTITY_ENV =
  /^(HERMES_LLM_BASE_URL|HERMES_MODEL|XMPP_DOMAIN|BIFROST_PROVIDERS|BIFROST_API_URL|KUNGURU_[A-Z0-9_]+)$/;
// Non-identity KUNGURU_* operational overrides (not deployment identity).
const ALLOWED_ENV = new Set(["KUNGURU_SCRIPTS_DIR"]);
const FOREIGN = /\b(ironbeard|ferrus|deepseek|otter|goose)\b/i;
const FQDN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|ai|dev|xyz)\b/i;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith(".ts")) yield p;
  }
}

const problems = [];
for (const file of walk(serverDir)) {
  const rel = relative(root, file);
  if (ALLOWLIST.has(rel) || isTest(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const ln = i + 1;
    // Rule A: foreign / instance host literals inside quoted strings.
    for (const m of line.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      const lit = m[2];
      const foreign = FOREIGN.test(lit);
      const fqdn = FQDN.test(lit);
      if (foreign || fqdn) {
        const why = foreign ? "foreign identity literal" : "host-like literal";
        problems.push(`${rel}:${ln}: ${why}: ${JSON.stringify(lit).slice(0, 80)}`);
      }
    }
    // Rule B: identity env reads must go through server/config.ts.
    for (const m of line.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (IDENTITY_ENV.test(m[1]) && !ALLOWED_ENV.has(m[1])) {
        problems.push(
          `${rel}:${ln}: direct identity env read process.env.${m[1]} — must come from server/config.ts (no defaults)`,
        );
      }
    }
  });
}

if (problems.length > 0) {
  console.error("check-config: instance identity must not be hardcoded:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nMove the value into deploy/instances/<instance>.json and read it via server/config.ts.",
  );
  process.exit(1);
}
console.log("check-config: ok (no hardcoded instance identity in server/)");
