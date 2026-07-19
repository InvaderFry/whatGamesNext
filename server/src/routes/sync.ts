import { Router } from "express";
import { getDb } from "../db.js";
import { fetchOwnedGames } from "../sources/steam.js";
import { fetchEpicGames, parseManualTitles } from "../sources/epic.js";
import {
  upsertSteamGames,
  upsertEpicGames,
  upsertImportedGames,
  type ImportStore,
} from "../lib/library.js";
import { parseImportText } from "../lib/import.js";
import { startEnrichment, getEnrichProgress, retryFailed } from "../lib/enrich.js";
import { env } from "../env.js";
import { getSetting } from "../lib/settings.js";

export const syncRouter = Router();

syncRouter.post("/sync/steam", async (_req, res) => {
  try {
    const games = await fetchOwnedGames();
    const result = upsertSteamGames(games);
    res.json({ source: "steam", fetched: games.length, ...result });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

syncRouter.post("/sync/epic", async (_req, res) => {
  try {
    const games = await fetchEpicGames();
    const result = upsertEpicGames(games);
    res.json({ source: "epic", fetched: games.length, ...result });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Fallback for Epic: paste a list of titles, one per line. */
syncRouter.post("/sync/epic/manual", (req, res) => {
  const text = (req.body as { titles?: string }).titles;
  if (!text || typeof text !== "string") {
    return res
      .status(400)
      .json({ error: "body must be { titles: string } with one title per line" });
  }
  const titles = parseManualTitles(text);
  const result = upsertEpicGames(titles.map((t) => ({ appName: "", title: t })));
  res.json({ source: "epic-manual", fetched: titles.length, ...result });
});

const IMPORT_STORES: ImportStore[] = ["gog", "itch", "other"];

/** Generic import for stores without an API: paste titles or CSV. */
syncRouter.post("/sync/import", (req, res) => {
  const body = req.body as { store?: string; text?: string };
  if (!body.store || !IMPORT_STORES.includes(body.store as ImportStore)) {
    return res.status(400).json({ error: `store must be one of: ${IMPORT_STORES.join(", ")}` });
  }
  if (!body.text || typeof body.text !== "string") {
    return res.status(400).json({
      error: "body must be { store, text } — titles one per line, or CSV with a title column",
    });
  }
  const games = parseImportText(body.text);
  const result = upsertImportedGames(games, body.store as ImportStore);
  res.json({ source: body.store, fetched: games.length, ...result });
});

syncRouter.post("/sync/enrich", (_req, res) => {
  const result = startEnrichment();
  res.json({ ...result, progress: getEnrichProgress() });
});

syncRouter.post("/sync/enrich/retry-failed", (_req, res) => {
  const requeued = retryFailed();
  const result = requeued > 0 ? startEnrichment() : { started: false };
  res.json({ requeued, ...result });
});

syncRouter.get("/sync/status", (_req, res) => {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN store IN ('steam','both') THEN 1 ELSE 0 END) AS steam,
        SUM(CASE WHEN store IN ('epic','both') THEN 1 ELSE 0 END) AS epic,
        SUM(CASE WHEN store IN ('gog','itch','other') THEN 1 ELSE 0 END) AS other,
        SUM(CASE WHEN enrich_status = 'done' THEN 1 ELSE 0 END) AS enriched,
        SUM(CASE WHEN enrich_status = 'failed' THEN 1 ELSE 0 END) AS enrich_failed
      FROM games`,
    )
    .get();
  res.json({
    library: counts,
    enrichment: getEnrichProgress(),
    config: {
      steamConfigured: !!(getSetting("steam_api_key") && getSetting("steam_id")),
      rawgConfigured: !!getSetting("rawg_api_key"),
      demo: env.demo,
    },
  });
});
