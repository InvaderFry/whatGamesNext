import express from "express";
import path from "node:path";
import fs from "node:fs";
import { repoRoot } from "./env.js";
import { libraryRouter } from "./routes/library.js";
import { queueRouter } from "./routes/queue.js";
import { syncRouter } from "./routes/sync.js";
import { recommendRouter } from "./routes/recommend.js";
import { settingsRouter } from "./routes/settings.js";
import { statsRouter } from "./routes/stats.js";
import { backupRouter } from "./routes/backup.js";

export function createApp(): express.Express {
  const app = express();
  /**
   * A restore body is one field holding a whole file. The app-wide limit below
   * is 2mb, and a large library whose games carry notes goes past that, so the
   * restore route gets its own. It has to be installed *before* the app-wide
   * parser: whichever parser runs first is the one that enforces a limit, and a
   * 2mb ceiling reached first rejects the body before the route ever sees it.
   * The app-wide parser then no-ops here, since the body is already read.
   */
  app.use("/api/import", express.json({ limit: "10mb" }));
  app.use(express.json({ limit: "2mb" }));

  app.use("/api", libraryRouter);
  app.use("/api", queueRouter);
  app.use("/api", syncRouter);
  app.use("/api", recommendRouter);
  app.use("/api", settingsRouter);
  app.use("/api", statsRouter);
  app.use("/api", backupRouter);

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // In production (after `npm run build`), serve the built frontend too.
  const webDist = path.join(repoRoot, "web", "dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  // Last, so it sees errors thrown by everything above. Without it a body over
  // the limit leaves as express's default HTML error page, which the web client
  // can only report as a bare status line.
  const tooLarge: express.ErrorRequestHandler = (err, _req, res, next) => {
    if ((err as { type?: string })?.type === "entity.too.large") {
      res.status(413).json({ error: "file is too large to restore — the limit is 10 MB" });
      return;
    }
    next(err);
  };
  app.use(tooLarge);

  return app;
}
