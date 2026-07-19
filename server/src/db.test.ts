import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { setDbForTests, getDb, type GameRow } from "./db.js";

const OLD_SCHEMA = `
  CREATE TABLE games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    normalized_title TEXT NOT NULL UNIQUE,
    store TEXT NOT NULL CHECK (store IN ('steam','epic','both')),
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
    last_synced TEXT
  );
  CREATE INDEX idx_games_store ON games(store);
  CREATE INDEX idx_games_enrich ON games(enrich_status);
  CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

describe("migrate", () => {
  it("upgrades an old-schema database: new columns, relaxed store CHECK, data intact", () => {
    const db = new Database(":memory:");
    db.exec(OLD_SCHEMA);
    db.prepare(
      "INSERT INTO games (title, normalized_title, store, status, metacritic) VALUES (?, ?, ?, ?, ?)",
    ).run("Hades", "hades", "steam", "finished", 93);

    setDbForTests(db);

    const row = getDb()
      .prepare("SELECT * FROM games WHERE normalized_title = 'hades'")
      .get() as GameRow;
    expect(row.metacritic).toBe(93);
    expect(row.status).toBe("finished");
    expect(row.status_changed_at).toBeNull();
    expect(row.finished_at).toBeNull();

    // The rebuilt table accepts the new store values...
    expect(() =>
      getDb()
        .prepare("INSERT INTO games (title, normalized_title, store) VALUES ('G', 'g', 'gog')")
        .run(),
    ).not.toThrow();
    // ...and still rejects garbage.
    expect(() =>
      getDb()
        .prepare("INSERT INTO games (title, normalized_title, store) VALUES ('X', 'x', 'bogus')")
        .run(),
    ).toThrow();
  });

  it("is idempotent on an already-current database", () => {
    const db = new Database(":memory:");
    setDbForTests(db);
    getDb()
      .prepare("INSERT INTO games (title, normalized_title, store) VALUES ('A', 'a', 'itch')")
      .run();
    setDbForTests(db);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number }).n).toBe(1);
  });
});
