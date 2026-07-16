import { getDb, type GameRow } from "../db.js";
import { deriveDifficulty } from "./difficulty.js";
import { lookupRawg } from "../sources/rawg.js";
import { lookupHltb } from "../sources/hltb.js";
import { fetchReviewSummary } from "../sources/steam.js";
import { env } from "../env.js";

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
}

const progress: EnrichProgress = {
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  current: null,
  lastError: null,
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

  const rawg = env.rawgApiKey ? await lookupRawg(game.title).catch(() => null) : null;

  let hltb = null;
  try {
    hltb = await lookupHltb(game.title);
  } catch {
    // HLTB is unofficial and flaky — missing lengths are acceptable.
  }

  let review = { reviewPct: null as number | null, reviewCount: null as number | null };
  if (game.steam_appid) {
    review = await fetchReviewSummary(game.steam_appid).catch(() => review);
  }

  const genres = rawg?.genres ?? (JSON.parse(game.genres) as string[]);
  const tags = rawg?.tags ?? (JSON.parse(game.tags) as string[]);
  const difficulty = deriveDifficulty(genres, tags);

  db.prepare(
    `UPDATE games SET
      rawg_id = @rawgId, metacritic = @metacritic, rawg_rating = @rating,
      genres = @genres, tags = @tags,
      release_date = COALESCE(@releaseDate, release_date),
      cover_url = COALESCE(cover_url, @coverUrl),
      hltb_main = @main, hltb_extra = @extra, hltb_completionist = @completionist,
      steam_review_pct = @reviewPct, steam_review_count = @reviewCount,
      difficulty = @difficulty,
      enrich_status = 'done', enrich_error = NULL
    WHERE id = @id`,
  ).run({
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
    .prepare("UPDATE games SET enrich_status = 'pending', enrich_error = NULL WHERE enrich_status = 'failed'")
    .run();
  return info.changes;
}
