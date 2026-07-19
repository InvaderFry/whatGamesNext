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

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL UNIQUE,
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
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_games_store ON games(store);
    CREATE INDEX IF NOT EXISTS idx_games_enrich ON games(enrich_status);

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Older databases: add columns introduced after the initial schema.
  const cols = (db.pragma("table_info(games)") as { name: string }[]).map((c) => c.name);
  if (!cols.includes("status_changed_at"))
    db.exec("ALTER TABLE games ADD COLUMN status_changed_at TEXT");
  if (!cols.includes("finished_at")) db.exec("ALTER TABLE games ADD COLUMN finished_at TEXT");

  // Older databases: the store CHECK only allowed steam/epic/both. SQLite can't
  // alter a CHECK in place, so rebuild the table once when the old constraint
  // is detected.
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'games'")
    .get() as { sql: string };
  if (!schema.sql.includes("'gog'")) {
    db.exec(`
      BEGIN;
      ALTER TABLE games RENAME TO games_old;
      ${schema.sql.replace(/CHECK\s*\(\s*store IN \([^)]*\)\s*\)/, `CHECK (${STORE_CHECK})`)};
      INSERT INTO games SELECT * FROM games_old;
      DROP TABLE games_old;
      CREATE INDEX IF NOT EXISTS idx_games_store ON games(store);
      CREATE INDEX IF NOT EXISTS idx_games_enrich ON games(enrich_status);
      COMMIT;
    `);
  }
}

/** For tests: use an in-memory database. */
export function setDbForTests(testDb: Database.Database) {
  migrate(testDb);
  db = testDb;
}
