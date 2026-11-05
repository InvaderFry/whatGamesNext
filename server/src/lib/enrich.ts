import { getDb, type GameRow } from "../db.js";
import { deriveDifficulty } from "./difficulty.js";
import { lookupIgdb, igdbConfigured, type IgdbGameData } from "../sources/igdb.js";
import { lookupRawg, type RawgGameData } from "../sources/rawg.js";
import { lookupHltb } from "../sources/hltb.js";
import {
  fetchReviewSummary,
  fetchStoreDetails,
  steamCoverUrl,
  type SteamStoreDetails,
} from "../sources/steam.js";
import { getSetting } from "./settings.js";

/**
 * In-process background enrichment queue. Walks all games with
 * enrich_status='pending' and fills in game data, rate-limited per API.
 * Progress is queryable so the UI can poll it. Results persist per game, so an
 * interrupted run resumes where it left off.
 *
 * Where each piece comes from:
 *   - IGDB (primary): critic and user ratings, genres, tags, release date, and
 *     the game's Steam appid — which is how an Epic or pasted game gets linked
 *     to Steam at all.
 *   - Steam store + reviews (keyless): Metacritic score, Steam's genres and
 *     play modes, and the review %, for every game with a Steam appid —
 *     whether it was synced from Steam or linked through IGDB.
 *   - RAWG (backup, likely to be deprecated — see sources/rawg.ts): only asked
 *     when IGDB isn't set up, errored, or had no match.
 *   - HowLongToBeat (keyless, unofficial): lengths.
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
  /** True after several consecutive IGDB errors — bad credentials, a rate limit, or an outage. */
  igdbUnavailable: boolean;
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

/** And for IGDB, for the same reasons. */
const IGDB_UNAVAILABLE_AFTER = 3;
let igdbConsecutiveErrors = 0;

/** Games enriched at once. Each one makes a handful of calls to different
 *  hosts, so the work is almost entirely waiting on the network. */
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
  igdbUnavailable: false,
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
// request a second. IGDB allows four a second and a lookup can take two
// queries (by Steam appid, then by title), hence half a second per lookup.
// Steam's store details are held to ~200 per five minutes; its review summary
// is more generous.
const limiters = {
  igdb: new RateLimiter(500),
  rawg: new RateLimiter(1000),
  hltb: new RateLimiter(1000),
  steamStore: new RateLimiter(1500),
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
  progress.igdbUnavailable = false;
  progress.rawgUnavailable = false;
  hltbConsecutiveErrors = 0;
  igdbConsecutiveErrors = 0;
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

/**
 * Outcome of asking a keyed source about one game. Three answers, and only two
 * of them mean we're finished with it: data, or a confident "never heard of
 * it" (null) — neither improves on a retry. An error (bad key, spent quota,
 * outage) says nothing about the game at all. Flattening an error to "no
 * match" and marking the row 'done' is how a bad key used to silently walk the
 * whole library, write nothing, and report a clean run.
 */
type Lookup<T> = { ok: true; data: T | null } | { ok: false };

async function askIgdb(game: GameRow): Promise<Lookup<IgdbGameData>> {
  // The breaker is open: skip the call, but the game is still unfinished.
  if (progress.igdbUnavailable) return { ok: false };
  await limiters.igdb.take();
  try {
    const data = await lookupIgdb(game.title, game.steam_appid ?? game.steam_link_appid);
    igdbConsecutiveErrors = 0;
    return { ok: true, data };
  } catch (err) {
    igdbConsecutiveErrors++;
    if (igdbConsecutiveErrors >= IGDB_UNAVAILABLE_AFTER) progress.igdbUnavailable = true;
    progress.lastError = `${game.title}: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false };
  }
}

async function askRawg(game: GameRow): Promise<Lookup<RawgGameData>> {
  if (progress.rawgUnavailable) return { ok: false };
  await limiters.rawg.take();
  try {
    const data = await lookupRawg(game.title);
    rawgConsecutiveErrors = 0;
    return { ok: true, data };
  } catch (err) {
    rawgConsecutiveErrors++;
    if (rawgConsecutiveErrors >= RAWG_UNAVAILABLE_AFTER) progress.rawgUnavailable = true;
    progress.lastError = `${game.title}: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false };
  }
}

/** Case-insensitive union, first spelling wins. */
function union(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of lists.flat()) {
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

const MAX_TAGS = 30;

async function enrichOne(game: GameRow) {
  const db = getDb();

  // --- Ratings, genres and tags: IGDB first, RAWG as the backup. -----------
  const hasIgdb = igdbConfigured();
  const hasRawg = !!getSetting("rawg_api_key");

  const igdb: Lookup<IgdbGameData> = hasIgdb ? await askIgdb(game) : { ok: false };
  // RAWG is only worth a call when IGDB couldn't help: not set up, erroring,
  // or no match for this title.
  const rawgNeeded = hasRawg && !(igdb.ok && igdb.data);
  const rawg: Lookup<RawgGameData> = rawgNeeded ? await askRawg(game) : { ok: false };
  const igdbData = igdb.ok ? igdb.data : null;
  const rawgData = rawg.ok ? rawg.data : null;

  // --- Steam: for every game with an appid, owned there or linked by IGDB. --
  // A linked appid is only recorded for games not synced from Steam; see the
  // steam_link_appid column in db.ts for why the two are kept apart.
  const linkedAppid = game.steam_appid == null ? (igdbData?.steamAppid ?? null) : null;
  const appid = game.steam_appid ?? linkedAppid ?? game.steam_link_appid;

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

  let store: SteamStoreDetails | null = null;
  let review = { reviewPct: null as number | null, reviewCount: null as number | null };
  if (appid != null) {
    await limiters.steamStore.take();
    store = await fetchStoreDetails(appid).catch(() => null);
    await limiters.steam.take();
    review = await fetchReviewSummary(appid).catch(() => review);
  }

  // A game is finished only when every keyed source that was needed for it
  // gave a real answer:
  //   - IGDB, when it's set up. An IGDB error leaves the game pending even if
  //     RAWG filled the gap, so the next run fetches the better data once IGDB
  //     is back.
  //   - RAWG, whenever it was needed — it's the only source, or IGDB had no
  //     match. A RAWG error (or its breaker being open) after IGDB's "no
  //     match" must not count as done: RAWG may well know the game, and 'done'
  //     would mean never asking it again. If RAWG stays down, those games
  //     just stay pending; removing the RAWG key lets them finish.
  //   - Neither set up: pending, so adding credentials later backfills it —
  //     'done' would strand it, since only failures requeue.
  // Steam and HLTB deliberately don't gate this — both are keyless
  // best-effort extras, and holding every game pending on a flaky scraper
  // would mean a library that never finishes enriching.
  const finished = (hasIgdb || hasRawg) && (!hasIgdb || igdb.ok) && (!rawgNeeded || rawg.ok);

  // Every source's genres and tags together: IGDB's are the most detailed,
  // Steam's are the broad ones RAWG used to give, RAWG fills in when it was
  // asked. What's already stored is kept as well when this run turned up
  // nothing, or didn't hear from its main source — so a refresh during an IGDB
  // outage can't trade a game's detailed tags for Steam's few broad ones.
  const merged = (fresh: string[], storedJson: string) =>
    union(fresh, !finished || !fresh.length ? (JSON.parse(storedJson) as string[]) : []);
  const genres = merged(
    union(igdbData?.genres ?? [], store?.genres ?? [], rawgData?.genres ?? []),
    game.genres,
  );
  const tags = merged(
    union(igdbData?.tags ?? [], store?.tags ?? [], rawgData?.tags ?? []),
    game.tags,
  ).slice(0, MAX_TAGS);
  const difficulty = deriveDifficulty(genres, tags);

  // Every source field is COALESCEd over its current value: a source that is
  // down or has no entry for this game must not wipe data an earlier run got.
  db.prepare(
    `UPDATE games SET
      igdb_id = COALESCE(@igdbId, igdb_id),
      igdb_critic_rating = COALESCE(@igdbCritic, igdb_critic_rating),
      igdb_user_rating = COALESCE(@igdbUser, igdb_user_rating),
      steam_link_appid = COALESCE(@linkedAppid, steam_link_appid),
      rawg_id = COALESCE(@rawgId, rawg_id),
      metacritic = COALESCE(@metacritic, metacritic),
      rawg_rating = COALESCE(@rawgRating, rawg_rating),
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
    status: finished ? "done" : "pending",
    id: game.id,
    igdbId: igdbData?.igdbId ?? null,
    igdbCritic: igdbData?.criticRating ?? null,
    igdbUser: igdbData?.userRating ?? null,
    linkedAppid,
    rawgId: rawgData?.rawgId ?? null,
    // Steam's figure is Metacritic's own, straight off the store page.
    metacritic: store?.metacritic ?? rawgData?.metacritic ?? null,
    rawgRating: rawgData?.rating ?? null,
    genres: JSON.stringify(genres),
    tags: JSON.stringify(tags),
    releaseDate: igdbData?.releaseDate ?? rawgData?.releaseDate ?? store?.releaseDate ?? null,
    // Steam's header art is landscape like the rest of the grid, so it wins
    // over IGDB's portrait box art. Only fills a gap: covers are never replaced.
    coverUrl:
      (appid != null ? steamCoverUrl(appid) : null) ??
      rawgData?.coverUrl ??
      igdbData?.coverUrl ??
      null,
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
 * way to pick up new data — or to fill in ratings after adding IGDB credentials.
 */
export function refreshAll(): number {
  const info = getDb()
    .prepare(
      "UPDATE games SET enrich_status = 'pending', enrich_error = NULL WHERE enrich_status <> 'pending'",
    )
    .run();
  return info.changes;
}
