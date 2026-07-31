import { getDb, type GameRow, type Store } from "../db.js";
import { normalizeTitle } from "./match.js";
import { steamCoverUrl, type SteamOwnedGame } from "../sources/steam.js";
import type { EpicGame } from "../sources/epic.js";
import type { ImportedGame } from "./import.js";

/**
 * Upsert helpers. A game owned on more than one store collapses into a single
 * row with store='both', which is why titles are matched at all — no id is
 * shared across stores.
 */

export type MatchedBy = "steam_appid" | "epic_app_name" | "title";

export interface MatchedGame {
  id: number;
  title: string;
  store: Store;
  playtime_minutes: number;
  matchedBy: MatchedBy;
}

export interface MatchKeys {
  normalizedTitle: string;
  steamAppid?: number | null;
  epicAppName?: string | null;
}

/** A merge that happened on a title rather than an id, so it can be reported. */
export interface MergeNote {
  /** The incoming title, as the store spells it. */
  title: string;
  /** The title of the row it was folded into. */
  into: string;
  /** What that row was before the merge. */
  store: Store;
}

/**
 * Find the row an incoming game belongs to.
 *
 * A store id is authoritative and comes first: two Steam games that normalize
 * to the same title — DOOM (1993) and DOOM (2016) — are different appids and
 * must stay different rows. Falling back to the title is what merges a game
 * owned on two stores, so it is kept, but only against rows carrying no id of
 * the kind we're holding: an Epic row has no appid and is a genuine candidate,
 * another Steam row has one and is a different game.
 */
export function findExistingGame(keys: MatchKeys): MatchedGame | null {
  const db = getDb();
  const select = "SELECT id, title, store, playtime_minutes FROM games";
  type Row = Omit<MatchedGame, "matchedBy">;

  if (keys.steamAppid != null) {
    const row = db.prepare(`${select} WHERE steam_appid = ?`).get(keys.steamAppid) as
      Row | undefined;
    if (row) return { ...row, matchedBy: "steam_appid" };
  }
  if (keys.epicAppName) {
    const row = db.prepare(`${select} WHERE epic_app_name = ?`).get(keys.epicAppName) as
      Row | undefined;
    if (row) return { ...row, matchedBy: "epic_app_name" };
  }

  const guards = [
    keys.steamAppid != null ? "AND steam_appid IS NULL" : "",
    keys.epicAppName ? "AND epic_app_name IS NULL" : "",
  ].join(" ");
  // Oldest wins where several rows share a title: stable across syncs, and the
  // one most likely to be carrying the user's ratings and notes already.
  const row = db
    .prepare(`${select} WHERE normalized_title = ? ${guards} ORDER BY id LIMIT 1`)
    .get(keys.normalizedTitle) as Row | undefined;
  return row ? { ...row, matchedBy: "title" } : null;
}

/**
 * Two hours — Steam's own refund window, and a fair line between "launched it
 * once to see if it runs" and "actually started playing this".
 */
export const PLAYED_THRESHOLD_MINUTES = 120;

/**
 * Stores report playtime but never whether you consider a game started, so a
 * game with real hours on it would otherwise sit at 'unplayed' forever.
 *
 * Only promotes rows the user has never touched: `status_changed_at` is written
 * solely by the PATCH route, so a NULL there means the current status was
 * inferred rather than chosen. It is deliberately left NULL here — this is still
 * an inference, and a later sync should be free to keep managing it.
 *
 * Returns the number of games promoted.
 */
export function promoteStartedGames(): number {
  return getDb()
    .prepare(
      `UPDATE games SET status = 'playing'
       WHERE status = 'unplayed' AND status_changed_at IS NULL
         AND playtime_minutes >= @threshold`,
    )
    .run({ threshold: PLAYED_THRESHOLD_MINUTES }).changes;
}

export function upsertSteamGames(games: SteamOwnedGame[]): {
  added: number;
  updated: number;
  promoted: number;
  merged: MergeNote[];
} {
  const db = getDb();
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  const merged: MergeNote[] = [];
  const insert = db.prepare(`
    INSERT INTO games (title, normalized_title, store, steam_appid, playtime_minutes, cover_url, last_synced)
    VALUES (@title, @norm, 'steam', @appid, @playtime, @cover, @now)
  `);
  const update = db.prepare(`
    UPDATE games SET steam_appid = @appid, playtime_minutes = @playtime,
      store = @store, cover_url = COALESCE(cover_url, @cover), last_synced = @now
    WHERE id = @id
  `);

  const tx = db.transaction(() => {
    for (const g of games) {
      const norm = normalizeTitle(g.name);
      if (!norm) continue;
      const existing = findExistingGame({ normalizedTitle: norm, steamAppid: g.appid });
      const params = {
        appid: g.appid,
        playtime: g.playtime_forever,
        cover: steamCoverUrl(g.appid),
        now,
      };
      if (existing) {
        update.run({
          ...params,
          id: existing.id,
          store: existing.store === "epic" ? "both" : existing.store,
        });
        if (existing.matchedBy === "title" && existing.store !== "steam") {
          merged.push({ title: g.name, into: existing.title, store: existing.store });
        }
        updated++;
      } else {
        insert.run({ ...params, title: g.name, norm });
        added++;
      }
    }
  });
  tx();
  return { added, updated, promoted: promoteStartedGames(), merged };
}

export function upsertEpicGames(games: EpicGame[]): {
  added: number;
  updated: number;
  merged: MergeNote[];
} {
  const db = getDb();
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  const merged: MergeNote[] = [];
  const insert = db.prepare(`
    INSERT INTO games (title, normalized_title, store, epic_app_name, last_synced)
    VALUES (@title, @norm, 'epic', @appName, @now)
  `);
  const update = db.prepare(`
    UPDATE games SET epic_app_name = @appName, store = @store, last_synced = @now
    WHERE id = @id
  `);

  const tx = db.transaction(() => {
    for (const g of games) {
      const norm = normalizeTitle(g.title);
      if (!norm) continue;
      const existing = findExistingGame({ normalizedTitle: norm, epicAppName: g.appName || null });
      if (existing) {
        update.run({
          appName: g.appName || null,
          now,
          id: existing.id,
          store: existing.store === "steam" ? "both" : existing.store,
        });
        if (existing.matchedBy === "title" && existing.store !== "epic") {
          merged.push({ title: g.title, into: existing.title, store: existing.store });
        }
        updated++;
      } else {
        insert.run({ title: g.title, norm, appName: g.appName || null, now });
        added++;
      }
    }
  });
  tx();
  return { added, updated, merged };
}

export type ImportStore = "gog" | "itch" | "other";

/**
 * Upsert games pasted/imported from stores without an API integration.
 * A title already in the library (from any store) is left on its existing
 * store — only last_synced and a missing playtime are filled in.
 */
export function upsertImportedGames(
  games: ImportedGame[],
  store: ImportStore,
): { added: number; updated: number; promoted: number; merged: MergeNote[] } {
  const db = getDb();
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  const merged: MergeNote[] = [];
  const insert = db.prepare(`
    INSERT INTO games (title, normalized_title, store, playtime_minutes, last_synced)
    VALUES (@title, @norm, @store, @playtime, @now)
  `);
  const update = db.prepare(`
    UPDATE games SET playtime_minutes = @playtime, last_synced = @now WHERE id = @id
  `);

  const tx = db.transaction(() => {
    for (const g of games) {
      const norm = normalizeTitle(g.title);
      if (!norm) continue;
      // A pasted list carries no id at all, so the title is all there is to go
      // on — the one case where two same-named games can still collide.
      const existing = findExistingGame({ normalizedTitle: norm });
      if (existing) {
        update.run({
          id: existing.id,
          playtime: existing.playtime_minutes || (g.playtimeMinutes ?? 0),
          now,
        });
        if (existing.store !== store) {
          merged.push({ title: g.title, into: existing.title, store: existing.store });
        }
        updated++;
      } else {
        insert.run({ title: g.title, norm, store, playtime: g.playtimeMinutes ?? 0, now });
        added++;
      }
    }
  });
  tx();
  return { added, updated, promoted: promoteStartedGames(), merged };
}

export interface GameFilters {
  store?: string;
  status?: string;
  genre?: string;
  tag?: string;
  maxLength?: number;
  minLength?: number;
  maxDifficulty?: number;
  minRating?: number;
  includeHidden?: boolean;
  search?: string;
}

export type SortKey =
  | "title"
  | "rating"
  | "metacritic"
  | "length"
  | "difficulty"
  | "playtime"
  | "release"
  | "steam_reviews";

const SORT_SQL: Record<SortKey, string> = {
  title: "lower(title)",
  rating: "COALESCE(metacritic, rawg_rating * 20, steam_review_pct)",
  metacritic: "metacritic",
  length: "hltb_main",
  difficulty: "COALESCE(difficulty_override, difficulty)",
  playtime: "playtime_minutes",
  release: "release_date",
  steam_reviews: "steam_review_pct",
};

export interface ListOptions {
  sort?: SortKey;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

function buildWhere(filters: GameFilters): { clause: string; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (!filters.includeHidden) where.push("hidden = 0");
  if (filters.store) {
    // 'both' means steam+epic, so it matches either of those filters only.
    if (filters.store === "steam" || filters.store === "epic") {
      where.push("(store = @store OR store = 'both')");
    } else {
      where.push("store = @store");
    }
    params.store = filters.store;
  }
  if (filters.status) {
    where.push("status = @status");
    params.status = filters.status;
  }
  if (filters.search) {
    where.push("title LIKE @search");
    params.search = `%${filters.search}%`;
  }
  if (filters.maxLength != null) {
    where.push("hltb_main <= @maxLength");
    params.maxLength = filters.maxLength;
  }
  if (filters.minLength != null) {
    where.push("hltb_main >= @minLength");
    params.minLength = filters.minLength;
  }
  if (filters.maxDifficulty != null) {
    where.push("COALESCE(difficulty_override, difficulty) <= @maxDifficulty");
    params.maxDifficulty = filters.maxDifficulty;
  }
  if (filters.minRating != null) {
    where.push("COALESCE(metacritic, rawg_rating * 20, steam_review_pct) >= @minRating");
    params.minRating = filters.minRating;
  }

  // genres/tags are JSON arrays; match case-insensitively via json_each.
  if (filters.genre) {
    where.push(
      "EXISTS (SELECT 1 FROM json_each(games.genres) WHERE lower(json_each.value) = lower(@genre))",
    );
    params.genre = filters.genre;
  }
  if (filters.tag) {
    where.push(
      "EXISTS (SELECT 1 FROM json_each(games.tags) WHERE lower(json_each.value) = lower(@tag))",
    );
    params.tag = filters.tag;
  }

  return { clause: where.length ? "WHERE " + where.join(" AND ") : "", params };
}

export function listGames(filters: GameFilters = {}, options: ListOptions = {}): GameRow[] {
  const { clause, params } = buildWhere(filters);
  let sql = `SELECT * FROM games ${clause}`;
  if (options.sort) {
    const key = SORT_SQL[options.sort];
    const dir = options.dir === "asc" ? "ASC" : "DESC";
    // Nulls always sort last, regardless of direction.
    sql += ` ORDER BY (${key} IS NULL), ${key} ${dir}, id ASC`;
  }
  if (options.limit != null) {
    sql += " LIMIT @limit";
    params.limit = options.limit;
    if (options.offset != null) {
      sql += " OFFSET @offset";
      params.offset = options.offset;
    }
  }
  return getDb().prepare(sql).all(params) as GameRow[];
}

/** Number of games matching the filters (ignores limit/offset). */
export function countGames(filters: GameFilters = {}): number {
  const { clause, params } = buildWhere(filters);
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM games ${clause}`).get(params) as {
    n: number;
  };
  return row.n;
}
