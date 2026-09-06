import express from "express";
import cookieParser from "cookie-parser";
import ViteExpress from "vite-express";
import { ensureAdminSeed, ensureHostSeed, getDb, ADMIN_USERNAME } from "./db";
import { hostSeeds } from "./inventory";
import { api } from "./routes";

const app = express();

app.use(express.json());
app.use(cookieParser());

app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.use("/api", api);

const PORT = Number(process.env.PORT ?? 3030);

const db = getDb();

const seed = await ensureAdminSeed(db);
if (seed.seeded) {
  console.log("==================================================");
  console.log(`  Admin user "${ADMIN_USERNAME}" created.`);
  console.log(`  One-time password: ${seed.password}`);
  console.log("  Store it somewhere safe now. It will not be shown again.");
  console.log("==================================================");
}

ensureHostSeed(db, hostSeeds());

ViteExpress.listen(app, PORT, () => {
  console.log(`kunguru-users dev server listening on http://localhost:${PORT}`);
});
