import { getDb, listActiveAccountUsers, setAccountModel } from "./db";
import { applyUserModel } from "./provision";

// One-off maintenance: reset every tenant's stored model selection to the given
// model and rewrite the live agents/WebUIs to match. Future per-user picks are
// unaffected (the model picker still stores per account).
//
//   MODEL=default-model pnpm set-default-model
//
// MODEL is required: a manual run does NOT inherit the app's systemd
// HERMES_MODEL, so relying on it would silently fall back to the code default
// (server/bifrost.ts) instead of the instance's real default.

const db = getDb();
const model = (process.env.MODEL ?? "").trim();
if (!model) {
  console.error("no target model: pass MODEL=<provider/name|alias>");
  process.exit(1);
}

// Stored selection is the source of truth for re-provisions and the picker's
// "current"; reset it for every account (including disabled/inactive ones so a
// later enable/re-provision also lands on the new default).
const rows = db
  .prepare(
    `SELECT a.id AS account_id, a.status AS status, u.username AS username
     FROM accounts a JOIN users u ON u.id = a.user_id
     ORDER BY a.id ASC`,
  )
  .all() as { account_id: number; status: string; username: string }[];
for (const r of rows) setAccountModel(db, r.account_id, model);
console.log(`[db] reset ${rows.length} account(s) to '${model}'`);

// Rewrite the running config for every active, enabled tenant: the DB change
// alone does not touch the host. applyUserModel() runs hermes/set-model.sh and
// restarts the WebUI; it only succeeds for accounts that are active.
const active = listActiveAccountUsers(db);
console.log(`[host] updating ${active.length} active tenant(s)`);
let failed = 0;
for (const u of active) {
  try {
    const res = await applyUserModel({
      user: { id: u.id, username: u.username },
      model,
      createdBy: null,
    });
    const suffix = res.failedStep ? ` (failed step: ${res.failedStep})` : "";
    console.log(`[host] ${u.username}: ${res.status}${suffix}`);
    if (res.status !== "succeeded") failed++;
  } catch (err) {
    failed++;
    console.error(
      `[host] ${u.username}: error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

db.close();
if (failed > 0) {
  console.error(`done with ${failed} failure(s)`);
  process.exit(1);
}
console.log("done");
