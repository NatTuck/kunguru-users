import express from "express";
import ViteExpress from "vite-express";

const app = express();

app.use(express.json());

app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

const PORT = Number(process.env.PORT ?? 3030);

ViteExpress.listen(app, PORT, () => {
  console.log(`kunguru-users dev server listening on http://localhost:${PORT}`);
});
