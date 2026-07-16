import express from "express";
import path from "node:path";
import fs from "node:fs";
import { env, repoRoot } from "./env.js";
import { getDb } from "./db.js";
import { libraryRouter } from "./routes/library.js";
import { syncRouter } from "./routes/sync.js";
import { recommendRouter } from "./routes/recommend.js";
import { seedDemoData } from "./demo.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use("/api", libraryRouter);
app.use("/api", syncRouter);
app.use("/api", recommendRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// In production (after `npm run build`), serve the built frontend too.
const webDist = path.join(repoRoot, "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

getDb();
if (env.demo) {
  const seeded = seedDemoData();
  if (seeded) console.log(`[demo] seeded ${seeded} sample games`);
}

app.listen(env.port, () => {
  console.log(`whatGamesNext server listening on http://localhost:${env.port}`);
  if (!env.steamApiKey) console.log("  (STEAM_API_KEY not set — Steam sync disabled)");
  if (!env.rawgApiKey) console.log("  (RAWG_API_KEY not set — rating enrichment disabled)");
});
