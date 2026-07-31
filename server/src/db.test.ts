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

/**
 * The shape shipped immediately before the collision fix: every column present
 * and the store CHECK already widened, but normalized_title still UNIQUE. This
 * is what a database in day-to-day use actually looks like, so it is the
 * migration path that matters most.
 */
const PREVIOUS_SCHEMA = OLD_SCHEMA.replace(
  "CHECK (store IN ('steam','epic','both'))",
  "CHECK (store IN ('steam','epic','both','gog','itch','other'))",
).replace(
  "last_synced TEXT\n  );",
  `last_synced TEXT,
    status_changed_at TEXT,
    finished_at TEXT,
    queue_position INTEGER,
    personal_rating INTEGER,
    notes TEXT
  );`,
);

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
    // Every column added after the original schema. A missed ALTER here doesn't
    // fail until an upgraded database hits "no such column" at runtime, so each
    // one is named rather than spot-checked.
    expect(row.status_changed_at).toBeNull();
    expect(row.finished_at).toBeNull();
    expect(row.queue_position).toBeNull();
    expect(row.personal_rating).toBeNull();
    expect(row.notes).toBeNull();

    // ...and they're writable, not just present.
    getDb()
      .prepare(
        "UPDATE games SET queue_position = 1, personal_rating = 8, notes = 'good' WHERE normalized_title = 'hades'",
      )
      .run();
    const updated = getDb()
      .prepare("SELECT * FROM games WHERE normalized_title = 'hades'")
      .get() as GameRow;
    expect(updated).toMatchObject({ queue_position: 1, personal_rating: 8, notes: "good" });

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

  it("drops the unique title constraint, keeping every value on its own column", () => {
    const db = new Database(":memory:");
    db.exec(PREVIOUS_SCHEMA);
    db.prepare(
      `INSERT INTO games (title, normalized_title, store, steam_appid, playtime_minutes,
         metacritic, status, finished_at, queue_position, personal_rating, notes)
       VALUES ('Hades', 'hades', 'steam', 1145360, 5400, 93, 'finished', '2024-03-01', 2, 9, 'best run yet')`,
    ).run();

    setDbForTests(db);

    // The copy names its columns, so a value landing one column over — playtime
    // read as a rating — is exactly what this is checking for.
    const row = getDb().prepare("SELECT * FROM games").get() as GameRow;
    expect(row).toMatchObject({
      title: "Hades",
      steam_appid: 1145360,
      playtime_minutes: 5400,
      metacritic: 93,
      status: "finished",
      finished_at: "2024-03-01",
      queue_position: 2,
      personal_rating: 9,
      notes: "best run yet",
    });

    // DOOM (1993) and DOOM (2016) can now coexist.
    expect(() =>
      getDb()
        .prepare(
          "INSERT INTO games (title, normalized_title, store, steam_appid) VALUES ('Hades', 'hades', 'steam', 2280)",
        )
        .run(),
    ).not.toThrow();

    const indexes = (getDb().pragma("index_list(games)") as { name: string; unique: number }[]).map(
      (i) => i.name,
    );
    expect(indexes).toContain("idx_games_norm");
    expect(indexes).toContain("idx_games_steam_appid");
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
