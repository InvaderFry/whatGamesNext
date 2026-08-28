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

// The refresh/retry routes kick off the background enrichment queue. Stub just
// the queue so route tests never hit the network or leak a still-running job
// into the next test — the queue itself is covered in lib/enrich.test.ts.
vi.mock("../lib/enrich.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/enrich.js")>();
  return { ...actual, startEnrichment: vi.fn(() => ({ started: true })) };
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
  release_date?: string | null;
}

function seed(games: SeedGame[]) {
  const insert = getDb().prepare(`
    INSERT INTO games (title, normalized_title, store, status, hidden, metacritic,
      hltb_main, difficulty, genres, tags, playtime_minutes, release_date)
    VALUES (@title, @norm, @store, @status, @hidden, @metacritic,
      @hltb_main, @difficulty, @genres, @tags, @playtime_minutes, @release_date)
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
      release_date: g.release_date ?? null,
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

  it("ignores a filter it can't read instead of applying it", async () => {
    // A hand-edited URL shouldn't quietly drop the games with no known length.
    seed([{ title: "Known", hltb_main: 12 }, { title: "Unknown" }]);
    for (const q of ["maxLength=Infinity", "maxLength=-Infinity", "maxLength=abc", "minRating="]) {
      expect((await request(app).get(`/api/games?${q}`)).body.count).toBe(2);
    }
  });

  it("clamps a filter that runs off the end of its scale", async () => {
    seed([
      { title: "Easy", difficulty: 2 },
      { title: "Hard", difficulty: 5 },
    ]);
    const res = await request(app).get("/api/games?maxDifficulty=99");
    expect(res.body.count).toBe(2);
    expect((await request(app).get("/api/games?maxDifficulty=-5")).body.count).toBe(0);
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

  it("paginates with limit/offset while count reports the total", async () => {
    seed(Array.from({ length: 5 }, (_, i) => ({ title: `Game ${i}`, metacritic: 70 + i })));
    const res = await request(app).get("/api/games?sort=metacritic&limit=2&offset=1");
    expect(res.body.count).toBe(5);
    expect(res.body.games.map((g: { title: string }) => g.title)).toEqual(["Game 3", "Game 2"]);
  });

  it("searches for a literal % rather than treating it as a wildcard", async () => {
    seed([{ title: "100% Orange Juice" }, { title: "Portal 2" }, { title: "Hollow Knight" }]);
    const res = await request(app).get("/api/games?search=%25");
    expect(res.body.games.map((g: { title: string }) => g.title)).toEqual(["100% Orange Juice"]);
  });

  it("searches for a literal _ rather than matching any character", async () => {
    seed([{ title: "100% Orange Juice" }, { title: "Portal 2" }, { title: "Hollow Knight" }]);
    // Unescaped, "_" is "any one character" and matches all three.
    const res = await request(app).get("/api/games?search=_");
    expect(res.body.games).toEqual([]);
  });

  it("keeps matching an ordinary search term case-insensitively", async () => {
    seed([{ title: "Portal 2" }, { title: "Hollow Knight" }]);
    const res = await request(app).get("/api/games?search=PORTAL");
    expect(res.body.games.map((g: { title: string }) => g.title)).toEqual(["Portal 2"]);
  });

  it("clamps a huge page size so one request can't serialize the library", async () => {
    seed(Array.from({ length: 210 }, (_, i) => ({ title: `Game ${i}` })));
    const res = await request(app).get("/api/games?limit=99999");
    expect(res.body.games).toHaveLength(200);
    expect(res.body.count).toBe(210);
  });

  it("still returns the whole library when no limit is asked for", async () => {
    seed(Array.from({ length: 210 }, (_, i) => ({ title: `Game ${i}` })));
    const res = await request(app).get("/api/games");
    expect(res.body.games).toHaveLength(210);
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

  it('takes only a real boolean for hidden, so "false" can\'t hide a game', async () => {
    seed([{ title: "Hades" }]);
    for (const hidden of ["false", 0, 1, null]) {
      expect((await request(app).patch("/api/games/1").send({ hidden })).status).toBe(400);
    }
    expect((await request(app).get("/api/games")).body.count).toBe(1);
    expect((await request(app).patch("/api/games/1").send({ hidden: true })).body.hidden).toBe(
      true,
    );
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
    // `total` is pre-slice, so the UI can report how many games matched.
    expect(res.body.total).toBe(5);
  });

  it("leaves games of unknown difficulty out of a maxDifficulty filter", async () => {
    seed([
      { title: "Known Easy", metacritic: 90, hltb_main: 10, difficulty: 2 },
      { title: "Unknown", metacritic: 90, hltb_main: 10, difficulty: null },
    ]);
    // Consistent with how a null rating is treated: asked for "this hard or
    // easier", a game we can't place doesn't qualify.
    const res = await request(app).get("/api/recommend?maxDifficulty=3");
    expect(res.body.results.map((r: { game: { title: string } }) => r.game.title)).toEqual([
      "Known Easy",
    ]);
  });

  it("applies the genre filter before scoring", async () => {
    seed([
      { title: "Actioner", metacritic: 90, hltb_main: 10, genres: ["Action"] },
      { title: "Puzzler", metacritic: 90, hltb_main: 10, genres: ["Puzzle"] },
    ]);
    const res = await request(app).get("/api/recommend?genre=action");
    expect(res.body.total).toBe(1);
    expect(res.body.results[0].game.title).toBe("Actioner");
  });

  it("reorders results when the weights change", async () => {
    seed([
      { title: "Old Great", metacritic: 95, hltb_main: 10, release_date: "2005-01-01" },
      { title: "New Good", metacritic: 78, hltb_main: 10, release_date: "2024-01-01" },
    ]);
    const byRating = await request(app).get("/api/recommend?w_rating=2&w_recency=0");
    expect(byRating.body.results[0].game.title).toBe("Old Great");

    const byRecency = await request(app).get("/api/recommend?w_rating=0&w_recency=2");
    expect(byRecency.body.results[0].game.title).toBe("New Good");
  });

  it("clamps an absurd limit instead of serializing the whole library", async () => {
    seed(
      Array.from({ length: 210 }, (_, i) => ({
        title: `Game ${i}`,
        metacritic: 80,
        hltb_main: 10,
      })),
    );
    const res = await request(app).get("/api/recommend?limit=99999");
    expect(res.body.count).toBe(200);
    // The pre-slice total still tells the truth about what matched.
    expect(res.body.total).toBe(210);
  });

  it("treats a negative limit as one game, not as everything bar the last few", async () => {
    seed(Array.from({ length: 5 }, (_, i) => ({ title: `Game ${i}`, metacritic: 80 + i })));
    const res = await request(app).get("/api/recommend?limit=-2");
    expect(res.body.count).toBe(1);
  });

  it("treats a negative weight as zero rather than inverting the ranking", async () => {
    const games = [
      { title: "Acclaimed", metacritic: 95, hltb_main: 10 },
      { title: "Panned", metacritic: 45, hltb_main: 10 },
    ];
    seed(games);
    const negative = await request(app).get("/api/recommend?w_rating=-2");
    const off = await request(app).get("/api/recommend?w_rating=0");
    const titles = (r: { body: { results: { game: { title: string } }[] } }) =>
      r.body.results.map((x) => x.game.title);
    expect(titles(negative)).toEqual(titles(off));
    // And specifically: the badly-reviewed game is not promoted to the top.
    expect(titles(negative)[0]).toBe("Acclaimed");
  });

  it("falls back to a weight's own default when its value is unreadable", async () => {
    seed([
      { title: "Old Great", metacritic: 95, hltb_main: 10, release_date: "2005-01-01" },
      { title: "New Good", metacritic: 78, hltb_main: 10, release_date: "2024-01-01" },
    ]);
    const garbage = await request(app).get("/api/recommend?w_rating=lots");
    const untouched = await request(app).get("/api/recommend");
    expect(garbage.body.results.map((r: { score: number }) => r.score)).toEqual(
      untouched.body.results.map((r: { score: number }) => r.score),
    );
  });

  it("ignores a budget that isn't a number instead of scoring every game NaN", async () => {
    seed([
      { title: "Short", metacritic: 90, hltb_main: 5 },
      { title: "Long", metacritic: 90, hltb_main: 80 },
    ]);
    const garbage = await request(app).get("/api/recommend?budget=whenever");
    const none = await request(app).get("/api/recommend");
    for (const r of garbage.body.results) expect(Number.isFinite(r.score)).toBe(true);
    expect(garbage.body.results.map((r: { score: number }) => r.score)).toEqual(
      none.body.results.map((r: { score: number }) => r.score),
    );
  });

  it("clamps maxDifficulty into the 1-5 scale the estimate uses", async () => {
    seed([
      { title: "Relaxing", metacritic: 90, hltb_main: 10, difficulty: 1 },
      { title: "Punishing", metacritic: 90, hltb_main: 10, difficulty: 5 },
    ]);
    // 0 clamps up to 1 rather than filtering the library down to nothing.
    const low = await request(app).get("/api/recommend?maxDifficulty=0");
    expect(low.body.results.map((r: { game: { title: string } }) => r.game.title)).toEqual([
      "Relaxing",
    ]);
    // 9 clamps down to 5, which is everything — the same as no filter.
    const high = await request(app).get("/api/recommend?maxDifficulty=9");
    expect(high.body.total).toBe(2);
  });
});

describe("GET /api/recommend?mode=tonight", () => {
  it("only offers games already under way, closest to done first", async () => {
    seed([
      // 15h in on a 20h game: 5h left.
      { title: "Nearly Done", status: "playing", hltb_main: 20, playtime_minutes: 900 },
      // 2h in on a 60h game: 58h left, way past a 6h evening.
      { title: "Barely Started", status: "playing", hltb_main: 60, playtime_minutes: 120 },
      { title: "Not Started", status: "unplayed", hltb_main: 5 },
      { title: "Already Done", status: "finished", hltb_main: 5, playtime_minutes: 300 },
    ]);
    const res = await request(app).get("/api/recommend?mode=tonight&budget=6");

    const titles = res.body.results.map((r: { game: { title: string } }) => r.game.title);
    expect(titles).toEqual(["Nearly Done", "Barely Started"]);
    expect(res.body.results[0].reason).toMatch(/5h left of 20h/);
  });

  it("says so when a game is past its main story", async () => {
    seed([{ title: "Overrun", status: "playing", hltb_main: 10, playtime_minutes: 900 }]);
    const res = await request(app).get("/api/recommend?mode=tonight");
    expect(res.body.results[0].reason).toMatch(/past the 10h main story/);
  });

  it("copes with a game of unknown length", async () => {
    seed([{ title: "Unknown Length", status: "playing", hltb_main: null, playtime_minutes: 300 }]);
    const res = await request(app).get("/api/recommend?mode=tonight");
    expect(res.body.results[0].reason).toMatch(/length unknown/);
  });
});

describe("user-authored data survives", () => {
  /**
   * Status, rating, notes and shortlist position are the only things here that
   * can't be recovered by re-syncing. The upserts avoid them by listing columns
   * explicitly rather than replacing the row — which is easy to lose the day
   * someone reaches for INSERT ... ON CONFLICT DO UPDATE SET excluded.*.
   */
  async function authorEverything(id: number) {
    await request(app).patch(`/api/games/${id}`).send({ status: "playing" });
    await request(app)
      .patch(`/api/games/${id}`)
      .send({ personal_rating: 9, notes: "stuck on the swamp" });
    await request(app).post(`/api/queue/${id}`);
  }

  const authored = (body: { games: { title: string }[] }, title: string) =>
    body.games.find((g) => g.title === title);

  it("a Steam sync doesn't overwrite what you wrote", async () => {
    // The mocked library contains Portal 2, so this row gets *updated*, not added.
    seed([{ title: "Portal 2" }]);
    await authorEverything(1);

    const res = await request(app).post("/api/sync/steam");
    expect(res.body.updated).toBeGreaterThan(0);

    const games = await request(app).get("/api/games");
    expect(authored(games.body, "Portal 2")).toMatchObject({
      status: "playing",
      personal_rating: 9,
      notes: "stuck on the swamp",
      queue_position: 1,
    });
  });

  it("reports a cross-store merge so a wrong one is visible", async () => {
    seed([{ title: "Portal 2", store: "epic" }]);

    const res = await request(app).post("/api/sync/steam");

    expect(res.body.merged).toEqual([{ title: "Portal 2", into: "Portal 2", store: "epic" }]);
  });

  it("an import doesn't overwrite what you wrote", async () => {
    seed([{ title: "Portal 2" }]);
    await authorEverything(1);

    await request(app)
      .post("/api/sync/import")
      .send({ store: "gog", text: "title,playtime_hours\nPortal 2,12" });

    const games = await request(app).get("/api/games");
    expect(authored(games.body, "Portal 2")).toMatchObject({
      status: "playing",
      personal_rating: 9,
      notes: "stuck on the swamp",
      queue_position: 1,
    });
  });

  it("enrichment doesn't overwrite what you wrote", async () => {
    seed([{ title: "Portal 2" }]);
    await authorEverything(1);

    await request(app).post("/api/sync/enrich/refresh");

    const games = await request(app).get("/api/games");
    expect(authored(games.body, "Portal 2")).toMatchObject({
      status: "playing",
      personal_rating: 9,
      notes: "stuck on the swamp",
      queue_position: 1,
    });
  });

  it("a status you set by hand outlives repeated syncs", async () => {
    // Dota 2 in the mock has 5000 minutes, so the playtime inference wants it
    // to be 'playing'. Saying otherwise has to stick.
    await request(app).post("/api/sync/steam");
    const first = await request(app).get("/api/games");
    const dota = authored(first.body, "Dota 2") as { id: number };
    await request(app).patch(`/api/games/${dota.id}`).send({ status: "abandoned" });

    await request(app).post("/api/sync/steam");
    await request(app).post("/api/sync/steam");

    const after = await request(app).get("/api/games");
    expect(authored(after.body, "Dota 2")).toMatchObject({ status: "abandoned" });
  });
});

describe("learned taste", () => {
  /** A history of finishing RPGs and dropping shooters. */
  function seedHistory() {
    seed([
      ...Array.from({ length: 4 }, (_, i) => ({
        title: `Finished RPG ${i}`,
        status: "finished",
        genres: ["RPG"],
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        title: `Dropped Shooter ${i}`,
        status: "abandoned",
        genres: ["Shooter"],
      })),
    ]);
  }

  it("prefers a genre you finish over a better-rated one you drop", async () => {
    seedHistory();
    seed([
      { title: "New Shooter", metacritic: 92, hltb_main: 10, genres: ["Shooter"] },
      { title: "New RPG", metacritic: 80, hltb_main: 10, genres: ["RPG"] },
    ]);

    const learned = await request(app).get("/api/recommend?mode=play-next");
    expect(learned.body.results[0].game.title).toBe("New RPG");

    // Turning the component off hands the ranking back to the critic score.
    const off = await request(app).get("/api/recommend?mode=play-next&w_taste=0");
    expect(off.body.results[0].game.title).toBe("New Shooter");
  });

  it("changes nothing when there is no history to learn from", async () => {
    seed([
      { title: "Better", metacritic: 92, hltb_main: 10, genres: ["Shooter"] },
      { title: "Worse", metacritic: 80, hltb_main: 10, genres: ["RPG"] },
    ]);
    const on = await request(app).get("/api/recommend?mode=play-next");
    const off = await request(app).get("/api/recommend?mode=play-next&w_taste=0");

    const titles = (r: typeof on) =>
      r.body.results.map((x: { game: { title: string } }) => x.game.title);
    expect(titles(on)).toEqual(titles(off));
    expect(titles(on)[0]).toBe("Better");
  });

  it("learns from the whole library, not just what the filters let through", async () => {
    seedHistory();
    seed([{ title: "New RPG", metacritic: 80, hltb_main: 10, genres: ["RPG"] }]);

    // Filtering to RPG hides every shooter from `recommend`, but the profile is
    // built separately — so the RPG affinity still reflects the dropped ones.
    const filtered = await request(app).get("/api/recommend?mode=play-next&genre=RPG");
    const unfiltered = await request(app).get("/api/recommend?mode=play-next");
    const scoreOf = (r: typeof filtered) =>
      r.body.results.find((x: { game: { title: string } }) => x.game.title === "New RPG").score;
    expect(scoreOf(filtered)).toBe(scoreOf(unfiltered));
  });

  it("reports what it learned, and admits when it hasn't", async () => {
    const cold = await request(app).get("/api/stats");
    expect(cold.body.taste).toMatchObject({ observations: 0, liked: [], disliked: [] });

    seedHistory();
    const warm = await request(app).get("/api/stats");
    expect(warm.body.taste.observations).toBe(8);
    expect(warm.body.taste.liked.map((t: { key: string }) => t.key)).toContain("rpg");
    expect(warm.body.taste.disliked.map((t: { key: string }) => t.key)).toContain("shooter");
  });

  it("stays out of the modes that don't use the composite score", async () => {
    seedHistory();
    seed([
      { title: "Quick Shooter", metacritic: 92, hltb_main: 3, genres: ["Shooter"] },
      { title: "Quick RPG", metacritic: 80, hltb_main: 3, genres: ["RPG"] },
    ]);

    // quick-wins, backlog-shame, hidden-gems and classics-missed have their own
    // fixed ranking. The weight is parsed for every mode, so nothing but this
    // stops it leaking into them.
    for (const mode of ["quick-wins", "backlog-shame"]) {
      const on = await request(app).get(`/api/recommend?mode=${mode}`);
      const off = await request(app).get(`/api/recommend?mode=${mode}&w_taste=0`);
      const titles = (r: typeof on) =>
        r.body.results.map((x: { game: { title: string } }) => x.game.title);
      expect(titles(on)).toEqual(titles(off));
      expect(titles(on)[0]).toBe("Quick Shooter");
    }
  });

  it("counts a hidden game as evidence even though it's never recommended", async () => {
    seed([
      ...Array.from({ length: 4 }, (_, i) => ({
        title: `Hidden Drop ${i}`,
        status: "abandoned",
        genres: ["Shooter"],
        hidden: 1,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        title: `Finished RPG ${i}`,
        status: "finished",
        genres: ["RPG"],
      })),
    ]);
    const res = await request(app).get("/api/stats");
    expect(res.body.taste.disliked.map((t: { key: string }) => t.key)).toContain("shooter");
  });
});

describe("personal rating and notes", () => {
  it("stores a rating and a note", async () => {
    seed([{ title: "Hades" }]);
    const res = await request(app)
      .patch("/api/games/1")
      .send({ personal_rating: 9, notes: "  best run-based game  " });

    expect(res.status).toBe(200);
    expect(res.body.personal_rating).toBe(9);
    // Trimmed on the way in, so a stray newline isn't stored as a note.
    expect(res.body.notes).toBe("best run-based game");
  });

  it("treats an emptied note as cleared", async () => {
    seed([{ title: "Hades" }]);
    await request(app).patch("/api/games/1").send({ notes: "a thought" });
    const res = await request(app).patch("/api/games/1").send({ notes: "   " });
    expect(res.body.notes).toBeNull();
  });

  it("rejects a rating outside 1-10", async () => {
    seed([{ title: "Hades" }]);
    for (const bad of [0, 11, 5.5]) {
      const res = await request(app).patch("/api/games/1").send({ personal_rating: bad });
      expect(res.status).toBe(400);
    }
    expect((await request(app).patch("/api/games/1").send({ personal_rating: null })).status).toBe(
      200,
    );
  });

  it("ranks by your score over the critics'", async () => {
    seed([
      { title: "Critics Loved It", metacritic: 95, hltb_main: 10 },
      { title: "You Loved It", metacritic: 60, hltb_main: 10 },
    ]);
    const before = await request(app).get("/api/recommend?w_rating=2&w_unplayed=0&w_recency=0");
    expect(before.body.results[0].game.title).toBe("Critics Loved It");

    const you = (await request(app).get("/api/games")).body.games.find(
      (g: { title: string }) => g.title === "You Loved It",
    );
    await request(app).patch(`/api/games/${you.id}`).send({ personal_rating: 10 });

    const after = await request(app).get("/api/recommend?w_rating=2&w_unplayed=0&w_recency=0");
    expect(after.body.results[0].game.title).toBe("You Loved It");
    expect(after.body.results[0].game.effective_rating).toBe(100);
  });
});

describe("shortlist routes", () => {
  it("adds, reorders and removes, always returning the current list", async () => {
    seed([{ title: "A" }, { title: "B" }]);

    const added = await request(app).post("/api/queue/1");
    expect(added.status).toBe(200);
    await request(app).post("/api/queue/2");

    const moved = await request(app).post("/api/queue/2/move").send({ direction: "up" });
    expect(moved.body.games.map((g: { title: string }) => g.title)).toEqual(["B", "A"]);
    expect(moved.body.games[0].queue_position).toBe(1);

    const removed = await request(app).delete("/api/queue/2");
    expect(removed.body.games.map((g: { title: string }) => g.title)).toEqual(["A"]);
  });

  it("rejects a bad direction", async () => {
    seed([{ title: "A" }]);
    await request(app).post("/api/queue/1");
    const res = await request(app).post("/api/queue/1/move").send({ direction: "sideways" });
    expect(res.status).toBe(400);
  });

  it("404s on adding a game that doesn't exist", async () => {
    const res = await request(app).post("/api/queue/999");
    expect(res.status).toBe(404);
  });

  it("surfaces the shortlist position on the game itself", async () => {
    seed([{ title: "A" }]);
    await request(app).post("/api/queue/1");
    const games = await request(app).get("/api/games");
    expect(games.body.games[0].queue_position).toBe(1);
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

  it("marks a game with real hours on it as playing, and leaves a barely-touched one alone", async () => {
    // The mocked library has Dota 2 at 5000 minutes and Portal 2 at 30.
    const res = await request(app).post("/api/sync/steam");
    expect(res.body.promoted).toBe(1);

    const games = await request(app).get("/api/games");
    const byTitle = Object.fromEntries(
      games.body.games.map((g: { title: string; status: string }) => [g.title, g.status]),
    );
    expect(byTitle["Dota 2"]).toBe("playing");
    expect(byTitle["Portal 2"]).toBe("unplayed");
  });

  it("never overrides a status the user set by hand", async () => {
    await request(app).post("/api/sync/steam");
    const games = await request(app).get("/api/games");
    const dota = games.body.games.find((g: { title: string }) => g.title === "Dota 2");
    expect(dota.status).toBe("playing");

    // Deliberately putting it back stamps status_changed_at, which is the
    // signal that the inference must stop touching this row.
    const patched = await request(app).patch(`/api/games/${dota.id}`).send({ status: "unplayed" });
    expect(patched.body.status).toBe("unplayed");

    const again = await request(app).post("/api/sync/steam");
    expect(again.body.promoted).toBe(0);
    const after = await request(app).get("/api/games");
    expect(after.body.games.find((g: { title: string }) => g.title === "Dota 2").status).toBe(
      "unplayed",
    );
  });

  it("infers status from imported playtime too", async () => {
    const res = await request(app)
      .post("/api/sync/import")
      .send({ store: "gog", text: "title,playtime_hours\nDeep Rock Galactic,40\nBriefly Tried,1" });
    expect(res.body.promoted).toBe(1);

    const games = await request(app).get("/api/games");
    const byTitle = Object.fromEntries(
      games.body.games.map((g: { title: string; status: string }) => [g.title, g.status]),
    );
    expect(byTitle["Deep Rock Galactic"]).toBe("playing");
    expect(byTitle["Briefly Tried"]).toBe("unplayed");
  });

  it("reports promoted: 0 for Epic, which carries no playtime", async () => {
    const res = await request(app).post("/api/sync/epic/manual").send({ titles: "Control" });
    expect(res.body.promoted).toBe(0);
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

  it("POST /api/sync/import adds CSV titles under the chosen store without duplicating", async () => {
    seed([{ title: "Portal 2" }]);
    const res = await request(app)
      .post("/api/sync/import")
      .send({ store: "gog", text: "title,playtime_hours\nThe Witcher 3,50\nPortal 2,1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: "gog", fetched: 2, added: 1, updated: 1 });

    const games = await request(app).get("/api/games?store=gog");
    expect(games.body.games).toHaveLength(1);
    expect(games.body.games[0]).toMatchObject({
      title: "The Witcher 3",
      store: "gog",
      playtime_minutes: 3000,
    });
    // The existing Steam copy keeps its store.
    const portal = (await request(app).get("/api/games?search=portal")).body.games[0];
    expect(portal.store).toBe("steam");
  });

  it("POST /api/sync/import rejects bad stores and missing text", async () => {
    expect(
      (await request(app).post("/api/sync/import").send({ store: "amazon", text: "x" })).status,
    ).toBe(400);
    expect((await request(app).post("/api/sync/import").send({ store: "gog" })).status).toBe(400);
  });

  it("POST /api/sync/enrich/refresh requeues already-enriched games", async () => {
    seed([{ title: "A" }, { title: "B" }]);
    getDb().prepare("UPDATE games SET enrich_status = 'done'").run();

    const res = await request(app).post("/api/sync/enrich/refresh");
    expect(res.status).toBe(200);
    expect(res.body.requeued).toBe(2);

    const status = await request(app).get("/api/sync/status");
    expect(status.body.library.enriched).toBe(0);
  });

  it("GET /api/sync/status reports library counts and enrichment state", async () => {
    seed([{ title: "A" }, { title: "B", store: "epic" }]);
    const res = await request(app).get("/api/sync/status");
    expect(res.status).toBe(200);
    expect(res.body.library).toMatchObject({ total: 2, steam: 1, epic: 1 });
    expect(res.body.enrichment).toMatchObject({ running: false });
    expect(res.body.config).toHaveProperty("steamConfigured");
  });

  it("GET /api/sync/status counts games still awaiting enrichment", async () => {
    seed([{ title: "A" }, { title: "B" }]);
    const before = await request(app).get("/api/sync/status");
    expect(before.body.library.enrich_pending).toBe(2);

    getDb().prepare("UPDATE games SET enrich_status = 'done' WHERE title = 'A'").run();
    const after = await request(app).get("/api/sync/status");
    expect(after.body.library.enrich_pending).toBe(1);
    expect(after.body.library.enriched).toBe(1);
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

  it("costs unsized backlog games at the median known length", async () => {
    seed([
      { title: "Short", hltb_main: 5 },
      { title: "Medium", hltb_main: 10 },
      { title: "Long", hltb_main: 100 },
      { title: "Unsized A" },
      { title: "Unsized B" },
    ]);
    const res = await request(app).get("/api/stats");

    // Median of 5/10/100 is 10 — a mean would let the 100h outlier inflate it.
    expect(res.body.backlog).toMatchObject({
      knownHours: 115,
      unknownLength: 2,
      medianLength: 10,
      estimatedHours: 135,
    });
  });

  it("leaves the backlog estimate null when no length is known at all", async () => {
    seed([{ title: "A" }, { title: "B" }]);
    const res = await request(app).get("/api/stats");
    expect(res.body.backlog.estimatedHours).toBeNull();
    expect(res.body.backlog.medianLength).toBeNull();
  });

  it("reports playtime by genre, counting a multi-genre game under each", async () => {
    seed([
      { title: "A", genres: ["Action", "RPG"], playtime_minutes: 600 },
      { title: "B", genres: ["RPG"], playtime_minutes: 300 },
      { title: "Never Played", genres: ["Puzzle"] },
      { title: "Hidden", genres: ["RPG"], playtime_minutes: 6000, hidden: 1 },
    ]);
    const res = await request(app).get("/api/stats");

    expect(res.body.genres).toEqual([
      { genre: "RPG", games: 2, hours: 15 },
      { genre: "Action", games: 1, hours: 10 },
    ]);
  });

  it("summarises your own ratings", async () => {
    seed([{ title: "A" }, { title: "B" }, { title: "C" }]);
    const empty = await request(app).get("/api/stats");
    expect(empty.body.personal).toMatchObject({ rated: 0, average: null, top: [] });

    await request(app).patch("/api/games/1").send({ personal_rating: 9 });
    await request(app).patch("/api/games/2").send({ personal_rating: 6 });

    const res = await request(app).get("/api/stats");
    expect(res.body.personal.rated).toBe(2);
    expect(res.body.personal.average).toBe(7.5);
    expect(res.body.personal.top.map((g: { title: string }) => g.title)).toEqual(["A", "B"]);
  });

  it("compares this year's finishes with last year's", async () => {
    seed([{ title: "A" }, { title: "B" }]);
    await request(app).patch("/api/games/1").send({ status: "finished" });
    getDb()
      .prepare("UPDATE games SET status = 'finished', finished_at = ? WHERE title = 'B'")
      .run(`${new Date().getFullYear() - 1}-06-01T00:00:00.000Z`);

    const res = await request(app).get("/api/stats");
    expect(res.body.finishedThisYear).toBe(1);
    expect(res.body.finishedLastYear).toBe(1);
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

describe("backup and restore", () => {
  /** Marks a game so it has something worth backing up. */
  async function author(id: number) {
    await request(app).patch(`/api/games/${id}`).send({ status: "finished" });
    await request(app)
      .patch(`/api/games/${id}`)
      .send({ personal_rating: 9, notes: "one more run" });
  }

  it("serves the backup as a file the browser will download", async () => {
    seed([{ title: "Hades" }]);
    await author(1);

    const res = await request(app).get("/api/export");

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename="whatgamesnext-backup-\d{4}-\d{2}-\d{2}\.json"/,
    );
    expect(res.body.games).toHaveLength(1);
    expect(res.body.games[0]).toMatchObject({ title: "Hades", personal_rating: 9 });
  });

  it("serves a CSV for a spreadsheet", async () => {
    seed([{ title: "Hades" }]);
    await author(1);

    const res = await request(app).get("/api/export?format=csv");

    expect(res.headers["content-disposition"]).toMatch(/\.csv"/);
    expect(res.text.split("\n")[0]).toContain("personal_rating");
    expect(res.text).toContain("one more run");
  });

  it("puts back what you wrote after the database was rebuilt", async () => {
    seed([{ title: "Hades" }]);
    await author(1);
    const backup = (await request(app).get("/api/export")).body;

    // What starting over actually looks like: delete data/games.db, sync again.
    getDb().exec("DELETE FROM games");
    seed([{ title: "Hades" }]);

    const res = await request(app)
      .post("/api/import")
      .send({ text: JSON.stringify(backup) });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ restored: 1, notFound: [] });
    const games = await request(app).get("/api/games");
    expect(games.body.games[0]).toMatchObject({
      status: "finished",
      personal_rating: 9,
      notes: "one more run",
    });
  });

  it("says what is wrong with a file it won't take", async () => {
    const res = await request(app).post("/api/import").send({ text: "not a backup" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/`title` column/);
  });

  it("takes a backup too big for the app-wide body limit", async () => {
    // The rest of the API parses under a 2mb limit, and a real library with a
    // note on every game goes past that — which is the whole reason the restore
    // route parses under its own 10mb one.
    seed(Array.from({ length: 1100 }, (_, i) => ({ title: `Game ${i}` })));
    getDb().exec(`UPDATE games SET status = 'finished', notes = '${"n".repeat(2000)}'`);
    const text = JSON.stringify((await request(app).get("/api/export")).body);
    expect(text.length).toBeGreaterThan(2 * 1024 * 1024);
    getDb().exec("UPDATE games SET status = 'unplayed', notes = NULL");

    const res = await request(app).post("/api/import").send({ text });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ restored: 1100, notFound: [] });
  });

  it("says a file past the restore limit is too large", async () => {
    const res = await request(app)
      .post("/api/import")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ text: "x".repeat(11 * 1024 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/);
  });
});
