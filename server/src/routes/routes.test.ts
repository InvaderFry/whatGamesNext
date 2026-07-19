import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import request from "supertest";
import { setDbForTests, getDb } from "../db.js";
import { createApp } from "../app.js";

vi.mock("../sources/steam.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sources/steam.js")>();
  return {
    ...actual,
    fetchOwnedGames: vi.fn(async () => [
      { appid: 620, name: "Portal 2", playtime_forever: 30 },
      { appid: 570, name: "Dota 2", playtime_forever: 5000 },
    ]),
  };
});

const app = createApp();

interface SeedGame {
  title: string;
  store?: string;
  status?: string;
  hidden?: number;
  metacritic?: number | null;
  hltb_main?: number | null;
  difficulty?: number | null;
  genres?: string[];
  tags?: string[];
  playtime_minutes?: number;
}

function seed(games: SeedGame[]) {
  const insert = getDb().prepare(`
    INSERT INTO games (title, normalized_title, store, status, hidden, metacritic,
      hltb_main, difficulty, genres, tags, playtime_minutes)
    VALUES (@title, @norm, @store, @status, @hidden, @metacritic,
      @hltb_main, @difficulty, @genres, @tags, @playtime_minutes)
  `);
  for (const g of games) {
    insert.run({
      title: g.title,
      norm: g.title.toLowerCase(),
      store: g.store ?? "steam",
      status: g.status ?? "unplayed",
      hidden: g.hidden ?? 0,
      metacritic: g.metacritic ?? null,
      hltb_main: g.hltb_main ?? null,
      difficulty: g.difficulty ?? null,
      genres: JSON.stringify(g.genres ?? []),
      tags: JSON.stringify(g.tags ?? []),
      playtime_minutes: g.playtime_minutes ?? 0,
    });
  }
}

beforeEach(() => {
  setDbForTests(new Database(":memory:"));
});

describe("GET /api/health", () => {
  it("responds ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("GET /api/games", () => {
  it("lists games with parsed genres and effective fields", async () => {
    seed([{ title: "Hades", metacritic: 93, genres: ["Action"], tags: ["Roguelike"] }]);
    const res = await request(app).get("/api/games");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const g = res.body.games[0];
    expect(g.genres).toEqual(["Action"]);
    expect(g.hidden).toBe(false);
    expect(g.effective_rating).not.toBeNull();
  });

  it("excludes hidden games unless includeHidden=1", async () => {
    seed([{ title: "Visible" }, { title: "Secret", hidden: 1 }]);
    const normal = await request(app).get("/api/games");
    expect(normal.body.games.map((g: { title: string }) => g.title)).toEqual(["Visible"]);
    const all = await request(app).get("/api/games?includeHidden=1");
    expect(all.body.count).toBe(2);
  });

  it("filters by status, genre, and search", async () => {
    seed([
      { title: "Celeste", status: "finished", genres: ["Platformer"] },
      { title: "Hollow Knight", status: "unplayed", genres: ["Metroidvania"] },
    ]);
    const byStatus = await request(app).get("/api/games?status=finished");
    expect(byStatus.body.games[0].title).toBe("Celeste");
    const byGenre = await request(app).get("/api/games?genre=metroidvania");
    expect(byGenre.body.games[0].title).toBe("Hollow Knight");
    const bySearch = await request(app).get("/api/games?search=hollow");
    expect(bySearch.body.games[0].title).toBe("Hollow Knight");
  });

  it("sorts by metacritic descending with nulls last", async () => {
    seed([
      { title: "Unrated" },
      { title: "Good", metacritic: 80 },
      { title: "Great", metacritic: 95 },
    ]);
    const res = await request(app).get("/api/games?sort=metacritic");
    expect(res.body.games.map((g: { title: string }) => g.title)).toEqual([
      "Great",
      "Good",
      "Unrated",
    ]);
  });
});

describe("GET /api/games/facets", () => {
  it("returns sorted genres and only tags used 3+ times", async () => {
    seed([
      { title: "A", genres: ["RPG"], tags: ["Indie"] },
      { title: "B", genres: ["Action"], tags: ["Indie"] },
      { title: "C", genres: ["Action"], tags: ["Indie", "Rare"] },
    ]);
    const res = await request(app).get("/api/games/facets");
    expect(res.body.genres).toEqual(["Action", "RPG"]);
    expect(res.body.tags).toEqual(["Indie"]);
  });
});

describe("PATCH /api/games/:id", () => {
  it("updates status and returns the updated game", async () => {
    seed([{ title: "Hades" }]);
    const res = await request(app).patch("/api/games/1").send({ status: "playing" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("playing");
  });

  it("rejects invalid status and difficulty_override", async () => {
    seed([{ title: "Hades" }]);
    expect((await request(app).patch("/api/games/1").send({ status: "nope" })).status).toBe(400);
    expect((await request(app).patch("/api/games/1").send({ difficulty_override: 9 })).status).toBe(
      400,
    );
    expect((await request(app).patch("/api/games/1").send({})).status).toBe(400);
  });

  it("404s for a missing game", async () => {
    const res = await request(app).patch("/api/games/999").send({ status: "playing" });
    expect(res.status).toBe(404);
  });

  it("clears difficulty_override with null", async () => {
    seed([{ title: "Hades", difficulty: 3 }]);
    await request(app).patch("/api/games/1").send({ difficulty_override: 5 });
    const cleared = await request(app).patch("/api/games/1").send({ difficulty_override: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.difficulty_override).toBeNull();
    expect(cleared.body.effective_difficulty).toBe(3);
  });
});

describe("GET /api/recommend", () => {
  it("rejects unknown modes", async () => {
    const res = await request(app).get("/api/recommend?mode=bogus");
    expect(res.status).toBe(400);
  });

  it("returns scored results for play-next", async () => {
    seed([
      { title: "Great Unplayed", metacritic: 92, hltb_main: 10 },
      { title: "Done", metacritic: 95, status: "finished" },
    ]);
    const res = await request(app).get("/api/recommend?mode=play-next&budget=20");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("play-next");
    expect(res.body.count).toBeGreaterThan(0);
    const top = res.body.results[0];
    expect(top.game.title).toBe("Great Unplayed");
    expect(typeof top.score).toBe("number");
    expect(typeof top.reason).toBe("string");
  });

  it("respects the limit parameter", async () => {
    seed(
      Array.from({ length: 5 }, (_, i) => ({
        title: `Game ${i}`,
        metacritic: 80 + i,
        hltb_main: 10,
      })),
    );
    const res = await request(app).get("/api/recommend?limit=2");
    expect(res.body.count).toBe(2);
  });
});

describe("sync routes", () => {
  it("POST /api/sync/steam upserts mocked owned games", async () => {
    const res = await request(app).post("/api/sync/steam");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: "steam", fetched: 2, added: 2, updated: 0 });
    const games = await request(app).get("/api/games");
    expect(games.body.count).toBe(2);
  });

  it("POST /api/sync/epic/manual parses pasted titles and merges duplicates", async () => {
    seed([{ title: "Portal 2" }]);
    const res = await request(app)
      .post("/api/sync/epic/manual")
      .send({ titles: "Portal 2\nControl\n\n" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fetched: 2, added: 1, updated: 1 });
    const games = await request(app).get("/api/games");
    const portal = games.body.games.find((g: { title: string }) => g.title === "Portal 2");
    expect(portal.store).toBe("both");
  });

  it("POST /api/sync/epic/manual rejects a missing body", async () => {
    const res = await request(app).post("/api/sync/epic/manual").send({});
    expect(res.status).toBe(400);
  });

  it("GET /api/sync/status reports library counts and enrichment state", async () => {
    seed([{ title: "A" }, { title: "B", store: "epic" }]);
    const res = await request(app).get("/api/sync/status");
    expect(res.status).toBe(200);
    expect(res.body.library).toMatchObject({ total: 2, steam: 1, epic: 1 });
    expect(res.body.enrichment).toMatchObject({ running: false });
    expect(res.body.config).toHaveProperty("steamConfigured");
  });
});

describe("play history and stats", () => {
  it("records status_changed_at and finished_at on status transitions", async () => {
    seed([{ title: "Hades" }]);
    const playing = await request(app).patch("/api/games/1").send({ status: "playing" });
    expect(playing.body.status_changed_at).toBeTruthy();
    expect(playing.body.finished_at).toBeNull();

    const finished = await request(app).patch("/api/games/1").send({ status: "finished" });
    expect(finished.body.finished_at).toBeTruthy();

    // Re-sending the same status must not bump the timestamps.
    const again = await request(app).patch("/api/games/1").send({ status: "finished" });
    expect(again.body.finished_at).toBe(finished.body.finished_at);
    expect(again.body.status_changed_at).toBe(finished.body.status_changed_at);
  });

  it("GET /api/stats aggregates status counts, backlog, and finishes by year", async () => {
    seed([
      { title: "Backlog A", hltb_main: 10 },
      { title: "Backlog B" },
      { title: "Old Finish", status: "finished" },
      { title: "Dropped", status: "abandoned" },
      { title: "Hidden", hidden: 1 },
    ]);
    await request(app).patch("/api/games/2").send({ status: "finished" });

    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body.statusCounts).toMatchObject({ unplayed: 1, finished: 2, abandoned: 1 });
    expect(res.body.backlog).toMatchObject({ games: 1, knownHours: 10, unknownLength: 0 });
    expect(res.body.untrackedFinishes).toBe(1);
    expect(res.body.abandonmentRate).toBe(33);
    const year = String(new Date().getFullYear());
    expect(res.body.finishedByYear).toEqual([{ year, n: 1 }]);
    expect(res.body.recentFinishes.map((g: { title: string }) => g.title)).toEqual(["Backlog B"]);
  });
});

describe("settings routes", () => {
  it("saves settings, masks API keys, and reflects them in sync status", async () => {
    const put = await request(app)
      .put("/api/settings")
      .send({ steam_api_key: "ABCDEF123456", steam_id: "76561198000000000" });
    expect(put.status).toBe(200);
    expect(put.body.steam_api_key).toMatchObject({
      configured: true,
      source: "settings",
      preview: "…3456",
    });
    expect(put.body.steam_id.preview).toBe("76561198000000000");

    const status = await request(app).get("/api/sync/status");
    expect(status.body.config.steamConfigured).toBe(true);
    expect(status.body.config.rawgConfigured).toBe(false);
  });

  it("clears a setting with null", async () => {
    await request(app).put("/api/settings").send({ rawg_api_key: "secret-key" });
    const cleared = await request(app).put("/api/settings").send({ rawg_api_key: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.rawg_api_key.configured).toBe(false);
  });

  it("rejects unknown-only or malformed bodies", async () => {
    expect((await request(app).put("/api/settings").send({ nonsense: "x" })).status).toBe(400);
    expect((await request(app).put("/api/settings").send({ steam_id: 42 })).status).toBe(400);
  });
});
