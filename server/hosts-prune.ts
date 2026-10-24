import { getDb, listHosts } from "./db";
import { hostSeeds } from "./inventory";

// Disable host rows that are no longer in the instance config — e.g. after
// converting a gateway+user-server deployment to a single host. Accounts,
// files, and jobs are untouched; routes for disabled hosts drop on the next
// reconcile.
//
// Dry run by default. Run on the app host:
//   pnpm hosts-prune            # list what would be disabled
//   pnpm hosts-prune --apply    # disable them

const apply = process.argv.includes("--apply");
const db = getDb();
const wanted = new Set(hostSeeds().map((h) => h.name));
const extra = listHosts(db, true).filter((h) => !wanted.has(h.name));

if (extra.length === 0) {
  console.log("hosts-prune: every host row is in the instance config");
  process.exit(0);
}

for (const h of extra) {
  console.log(
    `hosts-prune: host '${h.name}' (${h.ssh_target}) is not in the instance ` +
      `config (${h.enabled ? "enabled" : "already disabled"})`,
  );
}

const enabled = extra.filter((h) => h.enabled === 1);
if (enabled.length === 0) {
  console.log("hosts-prune: no enabled host to disable");
  process.exit(0);
}
if (!apply) {
  console.log(
    `hosts-prune: dry run; --apply would disable ${enabled.length} host(s)`,
  );
  process.exit(0);
}

for (const h of enabled) {
  db.prepare("UPDATE hosts SET enabled = 0 WHERE id = ?").run(h.id);
}
console.log(
  `hosts-prune: disabled ${enabled.length} host(s); accounts and files were left untouched`,
);
