import { deleteVirtualKey, listVirtualKeys } from "./bifrost";

// Sweep of leftover Bifrost virtual keys.
//
// Deletes keys whose name matches one of the given prefixes/exact names. By
// default only INACTIVE keys are deleted (failed-provision orphans). Pass
// --active to also delete matching active keys (use with care).
//
// Usage: pnpm bifrost-cleanup-keys [--active] [name-prefix-or-exact ...]
//        (no name patterns = list only, delete nothing)

const includeActive = process.argv.includes("--active");
const patterns = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"))
  .map((a) => a.toLowerCase());

async function main(): Promise<void> {
  const keys = await listVirtualKeys();
  const report = patterns.length === 0 ? keys : keys.filter((k) => {
    const n = k.name.toLowerCase();
    return patterns.some((p) => n === p || n.startsWith(p));
  });

  if (report.length === 0) {
    console.log("[bifrost-cleanup] no matching keys");
    return;
  }
  for (const k of report) {
    console.log(
      `  ${k.is_active ? "ACTIVE " : "inactive"} ${k.name}  (${k.id})  created ${k.created_at}`,
    );
  }

  if (patterns.length === 0) {
    console.log("[bifrost-cleanup] no patterns given; list only, nothing deleted");
    return;
  }

  let doomed = report.filter((k) => !k.is_active);
  if (includeActive) doomed = report;
  if (doomed.length === 0) {
    console.log("[bifrost-cleanup] nothing to delete (no matching inactive keys; add --active to include active)");
    return;
  }
  for (const k of doomed) {
    await deleteVirtualKey(k.id);
    console.log(`[bifrost-cleanup] deleted ${k.name} (${k.id})`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[bifrost-cleanup] error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
