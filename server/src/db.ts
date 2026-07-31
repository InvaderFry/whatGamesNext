import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";

export type Store = "steam" | "epic" | "both" | "gog" | "itch" | "other";

export interface GameRow {
  id: number;
  title: string;
  normalized_title: string;
  store: Store;
  steam_appid: number | null;
  epic_app_name: string | null;
  playtime_minutes: number;
  metacritic: number | null;
  rawg_id: number | null;
  rawg_rating: number | null;
  steam_review_pct: number | null;
  steam_review_count: number | null;
  hltb_main: number | null;
  hltb_extra: number | null;
  hltb_completionist: number | null;
  difficulty: number | null;
  difficulty_override: number | null;
  genres: string; // JSON string[]
  tags: string; // JSON string[]
  release_date: string | null;
  cover_url: string | null;
  status: "unplayed" | "playing" | "finished" | "abandoned";
  hidden: 0 | 1;
  enrich_status: "pending" | "done" | "failed";
  enrich_error: string | null;
  last_synced: string | null;
  status_changed_at: string | null;
  finished_at: string | null;
  /** 1-based position in the shortlist, or null when not shortlisted. */
  queue_position: number | null;
  /** Your own 1–10 score, which outranks critic ratings where it's set. */
  personal_rating: number | null;
  notes: string | null;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(env.dataDir, { recursive: true });
  db = new Database(path.join(env.dataDir, "games.db"));
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

const STORE_CHECK = "store IN ('steam','epic','both','gog','itch','other')";

/**
 * The current shape of the games table, in one place so a rebuild can recreate
 * it exactly rather than regex-patching whatever the old database happened to
 * hold — patches compound badly once there is more than one of them.
 *
 * `normalized_title` is deliberately *not* UNIQUE. It used to be, and that
 * silently merged two genuinely different games that normalize the same — DOOM
 * (1993/2016), Prey (2006/2017). Rows are matched on a store id first now, and
 * on the title only where no id exists; see lib/library.ts.
 */
const GAMES_DDL = `
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      store TEXT NOT NULL CHECK (${STORE_CHECK}),
      steam_appid INTEGER,
      epic_app_name TEXT,
      playtime_minutes INTEGER NOT NULL DEFAULT 0,
      metacritic INTEGER,
      rawg_id INTEGER,
      rawg_rating REAL,
      steam_review_pct INTEGER,
      steam_review_count INTEGER,
      hltb_main REAL,
      hltb_extra REAL,
      hltb_completionist REAL,
      difficulty INTEGER,
      difficulty_override INTEGER,
      genres TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      release_date TEXT,
      cover_url TEXT,
      status TEXT NOT NULL DEFAULT 'unplayed'
        CHECK (status IN ('unplayed','playing','finished','abandoned')),
      hidden INTEGER NOT NULL DEFAULT 0,
      enrich_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (enrich_status IN ('pending','done','failed')),
      enrich_error TEXT,
      last_synced TEXT,
      status_changed_at TEXT,
      finished_at TEXT,
      queue_position INTEGER,
      personal_rating INTEGER CHECK (personal_rating IS NULL OR personal_rating BETWEEN 1 AND 10),
      notes TEXT
    );
`;

/**
 * Plain indexes, not unique ones. The upserts already refuse to create a second
 * row for an id they have seen, and a CREATE UNIQUE INDEX that trips over some
 * legacy database would take the whole app down at startup — a migration should
 * fail as soft as the scrapers do.
 */
const GAMES_INDEXES = `
    CREATE INDEX IF NOT EXISTS idx_games_store ON games(store);
    CREATE INDEX IF NOT EXISTS idx_games_enrich ON games(enrich_status);
    CREATE INDEX IF NOT EXISTS idx_games_norm ON games(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_games_steam_appid ON games(steam_appid);
    CREATE INDEX IF NOT EXISTS idx_games_epic_app ON games(epic_app_name);
`;

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

/**
 * SQLite can't drop a UNIQUE constraint or alter a CHECK in place, so the table
 * is rebuilt from GAMES_DDL and the rows copied across.
 *
 * The copy names its columns instead of `SELECT *`: columns added by ALTER land
 * at the end of the old table in the order they were added, and a mismatch
 * there would quietly write playtime into a rating rather than fail.
 */
function rebuildGamesTable(db: Database.Database) {
  db.transaction(() => {
    db.exec("ALTER TABLE games RENAME TO games_old");
    db.exec(GAMES_DDL);
    const old = new Set(columnsOf(db, "games_old"));
    const shared = columnsOf(db, "games").filter((c) => old.has(c));
    db.exec(`INSERT INTO games (${shared.join(", ")}) SELECT ${shared.join(", ")} FROM games_old`);
    // Indexes follow a renamed table, so their names are still taken until the
    // old table is gone — creating them any earlier would silently no-op.
    db.exec("DROP TABLE games_old");
    db.exec(GAMES_INDEXES);
  })();
}

function migrate(db: Database.Database) {
  db.exec(`
    ${GAMES_DDL}
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Older databases: add columns introduced after the initial schema. This runs
  // before any rebuild so the copy below has every column to copy.
  const cols = columnsOf(db, "games");
  if (!cols.includes("status_changed_at"))
    db.exec("ALTER TABLE games ADD COLUMN status_changed_at TEXT");
  if (!cols.includes("finished_at")) db.exec("ALTER TABLE games ADD COLUMN finished_at TEXT");
  if (!cols.includes("queue_position"))
    db.exec("ALTER TABLE games ADD COLUMN queue_position INTEGER");
  // No CHECK on the added column: SQLite can't attach one via ALTER, and the
  // route validates the range anyway. New databases get it from the schema above.
  if (!cols.includes("personal_rating"))
    db.exec("ALTER TABLE games ADD COLUMN personal_rating INTEGER");
  if (!cols.includes("notes")) db.exec("ALTER TABLE games ADD COLUMN notes TEXT");

  // Two older shapes need the table rebuilt: one where the store CHECK only
  // allowed steam/epic/both, and one where normalized_title was UNIQUE.
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'games'")
    .get() as { sql: string };
  const staleStoreCheck = !schema.sql.includes("'gog'");
  const uniqueTitle = /normalized_title\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(schema.sql);
  if (staleStoreCheck || uniqueTitle) rebuildGamesTable(db);

  db.exec(GAMES_INDEXES);
}

/** For tests: use an in-memory database. */
export function setDbForTests(testDb: Database.Database) {
  migrate(testDb);
  db = testDb;
}
