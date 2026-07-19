import { getDb, type GameRow } from "../db.js";
import { normalizeTitle } from "./match.js";
import { steamCoverUrl, type SteamOwnedGame } from "../sources/steam.js";
import type { EpicGame } from "../sources/epic.js";
import type { ImportedGame } from "./import.js";

/**
 * Upsert helpers. Games are keyed by normalized title so the same game owned
 * on both stores collapses into a single row with store='both'.
 */

export function upsertSteamGames(games: SteamOwnedGame[]): { added: number; updated: number } {
  const db = getDb();
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  const find = db.prepare("SELECT id, store FROM games WHERE normalized_title = ?");
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
      const existing = find.get(norm) as { id: number; store: string } | undefined;
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
        updated++;
      } else {
        insert.run({ ...params, title: g.name, norm });
        added++;
      }
    }
  });
  tx();
  return { added, updated };
}

export function upsertEpicGames(games: EpicGame[]): { added: number; updated: number } {
  const db = getDb();
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  const find = db.prepare("SELECT id, store FROM games WHERE normalized_title = ?");
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
      const existing = find.get(norm) as { id: number; store: string } | undefined;
      if (existing) {
        update.run({
          appName: g.appName || null,
          now,
          id: existing.id,
          store: existing.store === "steam" ? "both" : existing.store,
        });
        updated++;
      } else {
        insert.run({ title: g.title, norm, appName: g.appName || null, now });
        added++;
      }
    }
  });
  tx();
  return { added, updated };
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
): { added: number; updated: number } {
  const db = getDb();
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  const find = db.prepare("SELECT id, playtime_minutes FROM games WHERE normalized_title = ?");
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
      const existing = find.get(norm) as { id: number; playtime_minutes: number } | undefined;
      if (existing) {
        update.run({
          id: existing.id,
          playtime: existing.playtime_minutes || (g.playtimeMinutes ?? 0),
          now,
        });
        updated++;
      } else {
        insert.run({ title: g.title, norm, store, playtime: g.playtimeMinutes ?? 0, now });
        added++;
      }
    }
  });
  tx();
  return { added, updated };
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
