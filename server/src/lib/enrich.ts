import { getDb, type GameRow } from "../db.js";
import { deriveDifficulty } from "./difficulty.js";
import { lookupRawg } from "../sources/rawg.js";
import { lookupHltb } from "../sources/hltb.js";
import { fetchReviewSummary } from "../sources/steam.js";
import { getSetting } from "./settings.js";

/**
 * In-process background enrichment queue. Walks all games with
 * enrich_status='pending' and fills in RAWG, HLTB, and Steam review data,
 * rate-limited per API. Progress is queryable so the UI can poll it.
 * Results persist per game, so an interrupted run resumes where it left off.
 */

export interface EnrichProgress {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  current: string | null;
  lastError: string | null;
  /** True after several consecutive HLTB errors — the scraper is likely broken or blocked. */
  hltbUnavailable: boolean;
}

const HLTB_UNAVAILABLE_AFTER = 3;
let hltbConsecutiveErrors = 0;

const progress: EnrichProgress = {
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  current: null,
  lastError: null,
  hltbUnavailable: false,
};

export function getEnrichProgress(): EnrichProgress {
  return { ...progress };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startEnrichment(): { started: boolean } {
  if (progress.running) return { started: false };
  const pending = getDb()
    .prepare("SELECT * FROM games WHERE enrich_status = 'pending'")
    .all() as GameRow[];
  if (!pending.length) return { started: false };

  progress.running = true;
  progress.total = pending.length;
  progress.done = 0;
  progress.failed = 0;
  progress.lastError = null;
  progress.hltbUnavailable = false;
  hltbConsecutiveErrors = 0;

  void runQueue(pending).finally(() => {
    progress.running = false;
    progress.current = null;
  });
  return { started: true };
}

async function runQueue(games: GameRow[]) {
  for (const game of games) {
    progress.current = game.title;
    try {
      await enrichOne(game);
      progress.done++;
    } catch (err) {
      progress.failed++;
      progress.lastError = `${game.title}: ${err instanceof Error ? err.message : String(err)}`;
      getDb()
        .prepare("UPDATE games SET enrich_status = 'failed', enrich_error = ? WHERE id = ?")
        .run(String(err), game.id);
    }
    // RAWG free tier and HLTB both tolerate ~1 req/s; each game makes
    // up to 3 API calls, so pace conservatively.
    await sleep(1200);
  }
}

async function enrichOne(game: GameRow) {
  const db = getDb();

  // Without a key there are no ratings to fetch. The other two sources are
  // keyless and still worth running, but the game stays 'pending' so adding a
  // key later backfills it — 'done' would strand it, since only failures requeue.
  const hasRawgKey = !!getSetting("rawg_api_key");
  const rawg = hasRawgKey ? await lookupRawg(game.title).catch(() => null) : null;

  // HLTB is unofficial and flaky — missing lengths are acceptable, but flag
  // a run of consecutive errors so the UI can say lengths are being skipped.
  let hltb = null;
  if (!progress.hltbUnavailable) {
    try {
      hltb = await lookupHltb(game.title);
      hltbConsecutiveErrors = 0;
    } catch {
      hltbConsecutiveErrors++;
      if (hltbConsecutiveErrors >= HLTB_UNAVAILABLE_AFTER) progress.hltbUnavailable = true;
    }
  }

  let review = { reviewPct: null as number | null, reviewCount: null as number | null };
  if (game.steam_appid) {
    review = await fetchReviewSummary(game.steam_appid).catch(() => review);
  }

  const genres = rawg?.genres ?? (JSON.parse(game.genres) as string[]);
  const tags = rawg?.tags ?? (JSON.parse(game.tags) as string[]);
  const difficulty = deriveDifficulty(genres, tags);

  // Every source field is COALESCEd over its current value: a source that is
  // down or has no entry for this game must not wipe data an earlier run got.
  db.prepare(
    `UPDATE games SET
      rawg_id = COALESCE(@rawgId, rawg_id),
      metacritic = COALESCE(@metacritic, metacritic),
      rawg_rating = COALESCE(@rating, rawg_rating),
      genres = @genres, tags = @tags,
      release_date = COALESCE(@releaseDate, release_date),
      cover_url = COALESCE(cover_url, @coverUrl),
      hltb_main = COALESCE(@main, hltb_main),
      hltb_extra = COALESCE(@extra, hltb_extra),
      hltb_completionist = COALESCE(@completionist, hltb_completionist),
      steam_review_pct = COALESCE(@reviewPct, steam_review_pct),
      steam_review_count = COALESCE(@reviewCount, steam_review_count),
      difficulty = @difficulty,
      enrich_status = @status, enrich_error = NULL
    WHERE id = @id`,
  ).run({
    status: hasRawgKey ? "done" : "pending",
    id: game.id,
    rawgId: rawg?.rawgId ?? null,
    metacritic: rawg?.metacritic ?? null,
    rating: rawg?.rating ?? null,
    genres: JSON.stringify(genres),
    tags: JSON.stringify(tags),
    releaseDate: rawg?.releaseDate ?? null,
    coverUrl: rawg?.coverUrl ?? null,
    main: hltb?.main ?? null,
    extra: hltb?.extra ?? null,
    completionist: hltb?.completionist ?? null,
    reviewPct: review.reviewPct,
    reviewCount: review.reviewCount,
    difficulty,
  });
}

/** Mark failed games as pending again so the next run retries them. */
export function retryFailed(): number {
  const info = getDb()
    .prepare(
      "UPDATE games SET enrich_status = 'pending', enrich_error = NULL WHERE enrich_status = 'failed'",
    )
    .run();
  return info.changes;
}

/**
 * Requeue every already-processed game. Ratings, review counts and lengths are
 * otherwise frozen at whatever the first run happened to fetch, so this is the
 * way to pick up new data — or to fill in ratings after adding a RAWG key.
 */
export function refreshAll(): number {
  const info = getDb()
    .prepare(
      "UPDATE games SET enrich_status = 'pending', enrich_error = NULL WHERE enrich_status <> 'pending'",
    )
    .run();
  return info.changes;
}
