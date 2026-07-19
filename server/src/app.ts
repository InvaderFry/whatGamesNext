import express from "express";
import path from "node:path";
import fs from "node:fs";
import { repoRoot } from "./env.js";
import { libraryRouter } from "./routes/library.js";
import { syncRouter } from "./routes/sync.js";
import { recommendRouter } from "./routes/recommend.js";
import { settingsRouter } from "./routes/settings.js";
import { statsRouter } from "./routes/stats.js";

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.use("/api", libraryRouter);
  app.use("/api", syncRouter);
  app.use("/api", recommendRouter);
  app.use("/api", settingsRouter);
  app.use("/api", statsRouter);

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // In production (after `npm run build`), serve the built frontend too.
  const webDist = path.join(repoRoot, "web", "dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  return app;
}
