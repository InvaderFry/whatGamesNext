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
  /** True after several consecutive RAWG errors — an expired key, a rate limit, or an outage. */
  rawgUnavailable: boolean;
  /** Seconds left, from the rate actually achieved so far. Null until a game finishes. */
  etaSeconds: number | null;
}

export interface LastRun {
  finishedAt: string;
  total: number;
  done: number;
  failed: number;
}

/** A run that was recorded as started but never finished — the process died mid-run. */
export interface InterruptedRun {
  startedAt: string;
  total: number;
}

const HLTB_UNAVAILABLE_AFTER = 3;
let hltbConsecutiveErrors = 0;

/**
 * Same circuit breaker for RAWG, and the same threshold. The failure that
 * matters is systemic rather than per-game — an expired key, a spent daily
 * quota, an outage — and all three answer identically for every title in the
 * library. Three in a row is enough to stop spending a second each on the
 * remaining fifteen hundred.
 */
const RAWG_UNAVAILABLE_AFTER = 3;
let rawgConsecutiveErrors = 0;

/** Games enriched at once. Each one makes up to three calls, to three
 *  different hosts, so the work is almost entirely waiting on the network. */
const CONCURRENCY = 3;

const RUNNING_KEY = "enrich:running";
const LAST_RUN_KEY = "enrich:last_run";

const progress = {
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  current: null as string | null,
  lastError: null as string | null,
  hltbUnavailable: false,
  rawgUnavailable: false,
};

let startedAtMs: number | null = null;

export function getEnrichProgress(): EnrichProgress {
  const completed = progress.done + progress.failed;
  let etaSeconds: number | null = null;
  // Measured rather than assumed: concurrency, a dead HLTB and a slow network
  // all move the real rate around a lot.
  if (progress.running && completed > 0 && startedAtMs != null) {
    const perGame = (Date.now() - startedAtMs) / completed;
    etaSeconds = Math.max(0, Math.round((perGame * (progress.total - completed)) / 1000));
  }
  return { ...progress, etaSeconds };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimum gap between calls to a single host. Each source gets its own lane, so
 * enriching several games at once never stacks requests onto one API — which is
 * what the old global sleep really protected against, at the cost of
 * serialising everything including calls to different hosts.
 */
class RateLimiter {
  private nextSlot = 0;
  constructor(private readonly intervalMs: number) {}

  async take(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) await sleep(slot - now);
  }

  reset(): void {
    this.nextSlot = 0;
  }
}

// RAWG's free tier and HLTB's unofficial endpoint both tolerate roughly one
// request a second. Steam's review summary is more generous.
const limiters = {
  rawg: new RateLimiter(1000),
  hltb: new RateLimiter(1000),
  steam: new RateLimiter(400),
};

function readMeta(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM sync_meta WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

function writeMeta(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

/** The outcome of the last completed run, for when nothing is currently going. */
export function getLastRun(): LastRun | null {
  const raw = readMeta(LAST_RUN_KEY);
  return raw ? (JSON.parse(raw) as LastRun) : null;
}

/**
 * Enrichment lives in-process, so a restart mid-run leaves the queue stopped
 * with no trace. The start marker is written to the database and only cleared
 * when the queue drains, so finding one at rest means the last run died.
 */
export function getInterruptedRun(): InterruptedRun | null {
  if (progress.running) return null;
  const raw = readMeta(RUNNING_KEY);
  return raw ? (JSON.parse(raw) as InterruptedRun) : null;
}

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
  progress.rawgUnavailable = false;
  hltbConsecutiveErrors = 0;
  rawgConsecutiveErrors = 0;
  startedAtMs = Date.now();
  // A fresh run shouldn't inherit the tail of the last one's pacing.
  for (const limiter of Object.values(limiters)) limiter.reset();

  const startedAt = new Date().toISOString();
  writeMeta(RUNNING_KEY, JSON.stringify({ startedAt, total: pending.length }));

  void runQueue(pending).finally(() => {
    progress.running = false;
    progress.current = null;
    getDb().prepare("DELETE FROM sync_meta WHERE key = ?").run(RUNNING_KEY);
    writeMeta(
      LAST_RUN_KEY,
      JSON.stringify({
        finishedAt: new Date().toISOString(),
        total: progress.total,
        done: progress.done,
        failed: progress.failed,
      }),
    );
  });
  return { started: true };
}

async function runQueue(games: GameRow[]) {
  const queue = [...games];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
}

async function worker(queue: GameRow[]) {
  for (;;) {
    const game = queue.shift();
    if (!game) return;
    // With several games in flight this is whichever started most recently.
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
  }
}

async function enrichOne(game: GameRow) {
  const db = getDb();

  // Without a key there are no ratings to fetch. The other two sources are
  // keyless and still worth running, but the game stays 'pending' so adding a
  // key later backfills it — 'done' would strand it, since only failures requeue.
  const hasRawgKey = !!getSetting("rawg_api_key");
  let rawg = null;
  // A RAWG lookup has three outcomes, and only two of them mean we're finished
  // with this game. `lookupRawg` returns null when it searched and found no
  // confident match — that answer won't improve on a retry, so it counts as
  // done. It *throws* for an expired key, a spent quota or an outage, which
  // says nothing about the game at all. Flattening the throw to null and
  // marking the row 'done' is how a bad key used to silently walk the whole
  // library, write nothing, and report a clean run.
  let rawgFailed = false;
  if (hasRawgKey) {
    if (progress.rawgUnavailable) {
      // The breaker is open. Skip the call, but the game is still unfinished.
      rawgFailed = true;
    } else {
      await limiters.rawg.take();
      try {
        rawg = await lookupRawg(game.title);
        rawgConsecutiveErrors = 0;
      } catch (err) {
        rawgFailed = true;
        rawgConsecutiveErrors++;
        if (rawgConsecutiveErrors >= RAWG_UNAVAILABLE_AFTER) progress.rawgUnavailable = true;
        progress.lastError = `${game.title}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  // HLTB is unofficial and flaky — missing lengths are acceptable, but flag
  // a run of consecutive errors so the UI can say lengths are being skipped.
  let hltb = null;
  if (!progress.hltbUnavailable) {
    await limiters.hltb.take();
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
    await limiters.steam.take();
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
    // Left pending when RAWG couldn't answer, for the same reason a missing key
    // does: the next run picks it up on its own, with no button to find. HLTB
    // and Steam reviews deliberately don't gate this — both are keyless
    // best-effort extras, and holding every game pending on a flaky scraper
    // would mean a library that never finishes enriching.
    status: hasRawgKey && !rawgFailed ? "done" : "pending",
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
