import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { setDbForTests, getDb, type GameRow } from "../db.js";
import { exportBackup, importBackup, parseBackup, toCsv } from "./backup.js";
import { normalizeTitle } from "./match.js";

beforeEach(() => {
  setDbForTests(new Database(":memory:"));
});

interface SeedGame {
  title: string;
  steam_appid?: number | null;
  status?: string;
  status_changed_at?: string | null;
  finished_at?: string | null;
  personal_rating?: number | null;
  notes?: string | null;
  queue_position?: number | null;
  hidden?: 0 | 1;
  difficulty_override?: number | null;
}

function seed(games: SeedGame[]) {
  const insert = getDb().prepare(`
    INSERT INTO games (title, normalized_title, store, steam_appid, status, status_changed_at,
      finished_at, personal_rating, notes, queue_position, hidden, difficulty_override)
    VALUES (@title, @norm, 'steam', @steam_appid, @status, @status_changed_at,
      @finished_at, @personal_rating, @notes, @queue_position, @hidden, @difficulty_override)
  `);
  for (const g of games) {
    insert.run({
      title: g.title,
      norm: g.title.toLowerCase(),
      steam_appid: g.steam_appid ?? null,
      status: g.status ?? "unplayed",
      status_changed_at: g.status_changed_at ?? null,
      finished_at: g.finished_at ?? null,
      personal_rating: g.personal_rating ?? null,
      notes: g.notes ?? null,
      queue_position: g.queue_position ?? null,
      hidden: g.hidden ?? 0,
      difficulty_override: g.difficulty_override ?? null,
    });
  }
}

/** Everything a restore is supposed to bring back, wiped. */
function wipeAuthoredColumns() {
  getDb().exec(`
    UPDATE games SET status = 'unplayed', status_changed_at = NULL, finished_at = NULL,
      personal_rating = NULL, notes = NULL, queue_position = NULL, hidden = 0,
      difficulty_override = NULL
  `);
}

const rowFor = (title: string) =>
  getDb().prepare("SELECT * FROM games WHERE title = ?").get(title) as GameRow;

describe("exportBackup", () => {
  it("carries only the games you did something to", () => {
    seed([
      { title: "Hades", personal_rating: 9 },
      { title: "Portal 2" },
      { title: "Celeste", notes: "stuck on chapter 7" },
      { title: "Dota 2", hidden: 1 },
    ]);

    // Portal 2 has nothing on it: re-syncing rebuilds that row exactly.
    expect(exportBackup().games.map((g) => g.title)).toEqual(["Hades", "Celeste", "Dota 2"]);
  });

  it("doesn't treat a status inferred from playtime as something you wrote", () => {
    seed([
      { title: "Hades", status: "playing" },
      { title: "Celeste", status: "playing", status_changed_at: "2024-01-01T00:00:00.000Z" },
    ]);

    expect(exportBackup().games.map((g) => g.title)).toEqual(["Celeste"]);
  });
});

describe("round trip", () => {
  const authored: SeedGame[] = [
    {
      title: "Hades",
      steam_appid: 1145360,
      status: "finished",
      status_changed_at: "2024-03-01T10:00:00.000Z",
      finished_at: "2024-03-01T10:00:00.000Z",
      personal_rating: 9,
      notes: 'best run yet — "one more" every time',
      queue_position: 2,
      difficulty_override: 4,
    },
    {
      title: "Celeste",
      steam_appid: 504230,
      status: "abandoned",
      status_changed_at: "2024-02-01T10:00:00.000Z",
      personal_rating: 7,
      notes: "dropped at the swamp,\nmaybe later",
      queue_position: 1,
      hidden: 1,
    },
  ];

  it("restores everything a JSON backup carried", () => {
    seed(authored);
    const before = exportBackup();

    wipeAuthoredColumns();
    const summary = importBackup(parseBackup(JSON.stringify(before)));

    expect(summary).toMatchObject({ restored: 2, notFound: [] });
    expect(exportBackup().games).toEqual(before.games);
  });

  it("survives a note with commas, quotes and a newline in it through CSV", () => {
    seed(authored);
    const before = exportBackup();

    wipeAuthoredColumns();
    importBackup(parseBackup(toCsv(before)));

    expect(exportBackup().games).toEqual(before.games);
    expect(rowFor("Celeste").notes).toBe("dropped at the swamp,\nmaybe later");
  });

  it("reports a second restore as changing nothing", () => {
    seed(authored);
    const backup = exportBackup();

    importBackup(backup);

    expect(importBackup(backup)).toMatchObject({ restored: 0, unchanged: 2 });
  });
});

describe("importBackup", () => {
  it("matches on the appid, so a renamed game still finds its notes", () => {
    seed([{ title: "Hades", steam_appid: 1145360, personal_rating: 9 }]);
    const backup = exportBackup();

    getDb().prepare("UPDATE games SET title = 'Hades II', personal_rating = NULL").run();
    importBackup(backup);

    expect(rowFor("Hades II").personal_rating).toBe(9);
  });

  it("reports games it can't place instead of inventing them", () => {
    seed([{ title: "Hades", personal_rating: 9 }]);
    const backup = exportBackup();
    getDb().exec("DELETE FROM games");

    const summary = importBackup(backup);

    expect(summary).toMatchObject({ restored: 0, notFound: ["Hades"] });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM games").get()).toEqual({ n: 0 });
  });

  it("leaves a value alone where the backup has none for it", () => {
    seed([{ title: "Hades", personal_rating: 9, notes: "written since the backup" }]);
    const backup = exportBackup();
    backup.games[0].notes = null;

    importBackup(backup);

    expect(rowFor("Hades").notes).toBe("written since the backup");
  });

  it("renumbers the shortlist when restored positions collide", () => {
    seed([
      { title: "Hades", personal_rating: 9, queue_position: 1 },
      { title: "Celeste", personal_rating: 8, queue_position: 2 },
    ]);
    const backup = exportBackup();

    // Someone shortlisted something else while the backup sat on disk.
    getDb().exec("UPDATE games SET queue_position = 1 WHERE title = 'Celeste'");
    importBackup(backup);

    const positions = (
      getDb().prepare("SELECT title, queue_position FROM games ORDER BY queue_position").all() as {
        title: string;
        queue_position: number;
      }[]
    ).map((r) => [r.title, r.queue_position]);
    expect(positions).toEqual([
      ["Hades", 1],
      ["Celeste", 2],
    ]);
  });
});

describe("parseBackup", () => {
  it("rejects a rating the database would refuse, naming the game", () => {
    const backup = { version: 1, games: [{ title: "Hades", personal_rating: 50 }] };
    expect(() => parseBackup(JSON.stringify(backup))).toThrow(/Hades.*between 1 and 10/);
  });

  it("rejects an unknown status", () => {
    const backup = { version: 1, games: [{ title: "Hades", status: "completed" }] };
    expect(() => parseBackup(JSON.stringify(backup))).toThrow(/unknown status "completed"/);
  });

  it("rejects a file that isn't a backup at all", () => {
    expect(() => parseBackup("{ nope")).toThrow(/wouldn't parse/);
    expect(() => parseBackup("")).toThrow(/empty/);
    expect(() => parseBackup("name,hours\nHades,20")).toThrow(/`title` column/);
  });

  it("accepts a hand-written CSV with only the columns someone cared about", () => {
    seed([{ title: "Hades", status: "playing", personal_rating: 9, hidden: 1 }]);

    importBackup(parseBackup('title,notes\nHades,"a note typed by hand"'));

    // Columns the file never mentioned are left exactly as they were.
    expect(rowFor("Hades")).toMatchObject({
      notes: "a note typed by hand",
      status: "playing",
      personal_rating: 9,
      hidden: 1,
    });
  });

  it("refuses a backup written by a newer version", () => {
    const backup = { version: 99, games: [{ title: "Hades" }] };
    expect(() => parseBackup(JSON.stringify(backup))).toThrow(/version 99.*update the app/);
  });
});

describe("matching a hand-written title", () => {
  it("normalizes the title the same way the library did", () => {
    // Seeded through the real normalizer, as a sync would.
    const title = "Control";
    getDb()
      .prepare(
        "INSERT INTO games (title, normalized_title, store, notes) VALUES (?, ?, 'steam', NULL)",
      )
      .run(title, normalizeTitle(title));

    // Typed out by hand, with the edition suffix the store puts on it. Plain
    // lowercasing leaves "control: ultimate edition" and finds nothing.
    const summary = importBackup(
      parseBackup('title,notes\n"Control: Ultimate Edition","still my favourite"'),
    );

    expect(summary.notFound).toEqual([]);
    expect(rowFor(title).notes).toBe("still my favourite");
  });
});
