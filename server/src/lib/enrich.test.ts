import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { setDbForTests, getDb, type GameRow } from "../db.js";

// Settings are mocked rather than written to the test database so a developer's
// real .env (which dotenv loads as a fallback) can't leak into these tests.
const settings = new Map<string, string>();
vi.mock("./settings.js", () => ({
  getSetting: (key: string) => settings.get(key) ?? "",
}));
vi.mock("../sources/igdb.js", () => ({
  lookupIgdb: vi.fn(),
  igdbConfigured: () => !!(settings.get("igdb_client_id") && settings.get("igdb_client_secret")),
}));
vi.mock("../sources/rawg.js", () => ({ lookupRawg: vi.fn() }));
vi.mock("../sources/hltb.js", () => ({ lookupHltb: vi.fn() }));
vi.mock("../sources/steam.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/steam.js")>()),
  fetchReviewSummary: vi.fn(),
  fetchStoreDetails: vi.fn(),
}));

const { lookupIgdb } = vi.mocked(await import("../sources/igdb.js"));
const { lookupRawg } = vi.mocked(await import("../sources/rawg.js"));
const { lookupHltb } = vi.mocked(await import("../sources/hltb.js"));
const { fetchReviewSummary, fetchStoreDetails } = vi.mocked(await import("../sources/steam.js"));
const {
  startEnrichment,
  getEnrichProgress,
  getLastRun,
  getInterruptedRun,
  retryFailed,
  refreshAll,
} = await import("./enrich.js");

function seed(games: Partial<GameRow>[]) {
  const insert = getDb().prepare(`
    INSERT INTO games (title, normalized_title, store, steam_appid, metacritic,
      hltb_main, steam_review_pct, enrich_status, genres, tags)
    VALUES (@title, @norm, @store, @appid, @metacritic, @hltb_main, @pct, @enrich_status,
      @genres, @tags)
  `);
  for (const g of games) {
    insert.run({
      title: g.title,
      norm: (g.title ?? "").toLowerCase(),
      store: g.store ?? "steam",
      genres: g.genres ?? "[]",
      tags: g.tags ?? "[]",
      appid: g.steam_appid ?? null,
      metacritic: g.metacritic ?? null,
      hltb_main: g.hltb_main ?? null,
      pct: g.steam_review_pct ?? null,
      enrich_status: g.enrich_status ?? "pending",
    });
  }
}

function row(title: string): GameRow {
  return getDb().prepare("SELECT * FROM games WHERE title = ?").get(title) as GameRow;
}

/** Start the queue and let its inter-request sleeps run to completion. */
async function runQueue() {
  const result = startEnrichment();
  await vi.runAllTimersAsync();
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  setDbForTests(new Database(":memory:"));
  settings.clear();
  lookupIgdb.mockReset();
  lookupRawg.mockReset();
  lookupHltb.mockReset();
  fetchReviewSummary.mockReset();
  fetchStoreDetails.mockReset();
  lookupIgdb.mockResolvedValue(null);
  lookupRawg.mockResolvedValue(null);
  lookupHltb.mockResolvedValue(null);
  fetchReviewSummary.mockResolvedValue({ reviewPct: null, reviewCount: null });
  fetchStoreDetails.mockResolvedValue(null);
});

function useIgdb() {
  settings.set("igdb_client_id", "id");
  settings.set("igdb_client_secret", "secret");
}

const HADES_IGDB = {
  igdbId: 113112,
  criticRating: 93,
  userRating: 91,
  genres: ["RPG", "Indie"],
  tags: ["Single player", "roguelike"],
  releaseDate: "2020-09-17",
  coverUrl: "https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg",
  steamAppid: 1145360,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("startEnrichment", () => {
  it("does nothing when there is no pending work", async () => {
    seed([{ title: "Hades", enrich_status: "done" }]);
    expect(await runQueue()).toEqual({ started: false });
  });

  it("stores data from every source and marks the game done", async () => {
    settings.set("rawg_api_key", "key");
    seed([{ title: "Hades", steam_appid: 1145360 }]);
    lookupRawg.mockResolvedValue({
      rawgId: 7,
      metacritic: 93,
      rating: 4.5,
      genres: ["Action"],
      tags: ["Roguelite"],
      releaseDate: "2020-09-17",
      coverUrl: "https://example.com/hades.jpg",
    });
    lookupHltb.mockResolvedValue({ main: 21, extra: 44, completionist: 96 });
    fetchReviewSummary.mockResolvedValue({ reviewPct: 98, reviewCount: 250000 });

    await runQueue();

    const g = row("Hades");
    expect(g.enrich_status).toBe("done");
    expect(g.metacritic).toBe(93);
    expect(g.hltb_main).toBe(21);
    expect(g.steam_review_pct).toBe(98);
    expect(JSON.parse(g.genres)).toEqual(["Action"]);
    expect(g.difficulty).not.toBeNull();
    expect(getEnrichProgress()).toMatchObject({ running: false, done: 1, failed: 0 });
  });

  it("leaves games pending when no ratings source is set, but still saves keyless data", async () => {
    seed([{ title: "Hades", steam_appid: 1145360 }]);
    lookupHltb.mockResolvedValue({ main: 21, extra: 44, completionist: 96 });
    fetchReviewSummary.mockResolvedValue({ reviewPct: 98, reviewCount: 250000 });

    await runQueue();

    const g = row("Hades");
    // 'done' here would strand the game forever: only failures are requeued, so
    // adding IGDB credentials later could never backfill its rating.
    expect(g.enrich_status).toBe("pending");
    expect(lookupIgdb).not.toHaveBeenCalled();
    expect(lookupRawg).not.toHaveBeenCalled();
    expect(g.hltb_main).toBe(21);
    expect(g.steam_review_pct).toBe(98);
  });

  it("keeps existing data when a source is down instead of wiping it", async () => {
    settings.set("rawg_api_key", "key");
    seed([
      { title: "Hades", steam_appid: 1145360, metacritic: 93, hltb_main: 21, steam_review_pct: 98 },
    ]);
    lookupRawg.mockRejectedValue(new Error("RAWG API error 503"));
    lookupHltb.mockRejectedValue(new Error("HLTB search 500"));
    fetchReviewSummary.mockRejectedValue(new Error("steam down"));

    await runQueue();

    const g = row("Hades");
    expect(g.metacritic).toBe(93);
    expect(g.hltb_main).toBe(21);
    expect(g.steam_review_pct).toBe(98);
  });

  it("leaves a game pending when RAWG errors, rather than calling it done", async () => {
    settings.set("rawg_api_key", "expired");
    seed([{ title: "Hades", steam_appid: 1145360 }]);
    lookupRawg.mockRejectedValue(new Error("RAWG API error 401"));
    lookupHltb.mockResolvedValue({ main: 21, extra: 44, completionist: 96 });
    fetchReviewSummary.mockResolvedValue({ reviewPct: 98, reviewCount: 250000 });

    await runQueue();

    const g = row("Hades");
    // The whole point: a dead key must not look like a finished game, or the
    // rating never gets fetched again without someone finding Refresh all.
    expect(g.enrich_status).toBe("pending");
    expect(g.metacritic).toBeNull();
    // The keyless sources still ran and their data was kept.
    expect(g.hltb_main).toBe(21);
    expect(g.steam_review_pct).toBe(98);
    expect(getEnrichProgress().lastError).toContain("401");
  });

  it("marks a game done when RAWG has simply never heard of it", async () => {
    settings.set("rawg_api_key", "key");
    seed([{ title: "Some Itch Jam Game" }]);
    // null is a searched-and-found-nothing answer, not a failure. Retrying it
    // forever would mean a library that can never finish enriching.
    lookupRawg.mockResolvedValue(null);

    await runQueue();

    expect(row("Some Itch Jam Game").enrich_status).toBe("done");
    expect(getEnrichProgress().rawgUnavailable).toBe(false);
  });

  it("stops calling RAWG once it has failed enough times in a row", async () => {
    settings.set("rawg_api_key", "expired");
    const titles = Array.from({ length: 12 }, (_, i) => `Game ${i}`);
    seed(titles.map((title) => ({ title })));
    lookupRawg.mockRejectedValue(new Error("RAWG API error 401"));

    await runQueue();

    expect(getEnrichProgress().rawgUnavailable).toBe(true);
    // Not an exact count: three games are in flight at once, so a couple more
    // calls are already committed by the time the third failure trips the
    // breaker. What matters is that it stops well short of the whole library.
    expect(lookupRawg.mock.calls.length).toBeLessThan(titles.length);
    // Every game stays pending, including the ones the breaker skipped outright.
    for (const title of titles) {
      expect(row(title).enrich_status).toBe("pending");
    }
  });

  it("records a failure without stopping the rest of the queue", async () => {
    settings.set("rawg_api_key", "key");
    seed([{ title: "Broken" }, { title: "Fine" }]);
    // All three sources are caught softly inside enrichOne, so the only way to
    // reach the failure branch is a game whose stored genres JSON won't parse.
    getDb().prepare("UPDATE games SET genres = '{oops' WHERE title = 'Broken'").run();

    await runQueue();

    expect(row("Broken").enrich_status).toBe("failed");
    expect(row("Broken").enrich_error).toBeTruthy();
    expect(row("Fine").enrich_status).toBe("done");
    expect(getEnrichProgress()).toMatchObject({ done: 1, failed: 1 });
  });

  it("stops calling HLTB after three consecutive failures", async () => {
    settings.set("rawg_api_key", "key");
    seed([{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }, { title: "E" }]);
    lookupHltb.mockRejectedValue(new Error("HLTB search 403"));

    await runQueue();

    expect(getEnrichProgress().hltbUnavailable).toBe(true);
    // The reason is kept, so the UI can say more than "unreachable".
    expect(getEnrichProgress().hltbError).toBe("HLTB search 403");
    expect(lookupHltb).toHaveBeenCalledTimes(3);
    // A dead length source must not fail the games themselves.
    expect(row("E").enrich_status).toBe("done");
  });
});

describe("IGDB + Steam, with RAWG as the backup", () => {
  it("takes ratings and tags from IGDB and Metacritic from Steam, without asking RAWG", async () => {
    useIgdb();
    settings.set("rawg_api_key", "key");
    seed([{ title: "Hades", steam_appid: 1145360 }]);
    lookupIgdb.mockResolvedValue(HADES_IGDB);
    fetchStoreDetails.mockResolvedValue({
      metacritic: 93,
      genres: ["Action", "Indie"],
      tags: ["Single-player"],
      releaseDate: "2020-09-17",
    });
    fetchReviewSummary.mockResolvedValue({ reviewPct: 98, reviewCount: 250000 });

    await runQueue();

    const g = row("Hades");
    expect(g.enrich_status).toBe("done");
    expect(lookupIgdb).toHaveBeenCalledWith("Hades", 1145360);
    // IGDB answered, so the backup is never bothered.
    expect(lookupRawg).not.toHaveBeenCalled();
    expect(g.igdb_id).toBe(113112);
    expect(g.igdb_critic_rating).toBe(93);
    expect(g.igdb_user_rating).toBe(91);
    expect(g.metacritic).toBe(93);
    expect(g.steam_review_pct).toBe(98);
    // Both sources' genres, once each.
    expect(JSON.parse(g.genres)).toEqual(["RPG", "Indie", "Action"]);
    expect(JSON.parse(g.tags)).toEqual(["Single player", "roguelike", "Single-player"]);
    expect(g.release_date).toBe("2020-09-17");
    // Owned on Steam already, so there is nothing to link.
    expect(g.steam_link_appid).toBeNull();
  });

  it("links an Epic game to Steam through IGDB without claiming it's owned there", async () => {
    useIgdb();
    seed([{ title: "Hades", store: "epic" }]);
    lookupIgdb.mockResolvedValue(HADES_IGDB);
    fetchStoreDetails.mockResolvedValue({
      metacritic: 93,
      genres: ["Action"],
      tags: [],
      releaseDate: null,
    });
    fetchReviewSummary.mockResolvedValue({ reviewPct: 98, reviewCount: 250000 });

    await runQueue();

    const g = row("Hades");
    expect(lookupIgdb).toHaveBeenCalledWith("Hades", null);
    expect(fetchStoreDetails).toHaveBeenCalledWith(1145360);
    expect(fetchReviewSummary).toHaveBeenCalledWith(1145360);
    expect(g.steam_link_appid).toBe(1145360);
    // steam_appid means "owned on Steam" and drives store matching — untouched.
    expect(g.steam_appid).toBeNull();
    expect(g.store).toBe("epic");
    expect(g.metacritic).toBe(93);
    expect(g.steam_review_pct).toBe(98);
    expect(g.cover_url).toContain("/apps/1145360/");
  });

  it("uses the stored Steam link for an exact IGDB match on the next run", async () => {
    useIgdb();
    seed([{ title: "Hades", store: "epic" }]);
    getDb().prepare("UPDATE games SET steam_link_appid = 1145360").run();

    await runQueue();

    expect(lookupIgdb).toHaveBeenCalledWith("Hades", 1145360);
  });

  it("falls back to RAWG when IGDB has no match", async () => {
    useIgdb();
    settings.set("rawg_api_key", "key");
    seed([{ title: "Obscure Game" }]);
    lookupIgdb.mockResolvedValue(null);
    lookupRawg.mockResolvedValue({
      rawgId: 7,
      metacritic: 71,
      rating: 3.5,
      genres: ["Puzzle"],
      tags: ["Relaxing"],
      releaseDate: "2015-01-01",
      coverUrl: "https://example.com/obscure.jpg",
    });

    await runQueue();

    const g = row("Obscure Game");
    expect(lookupRawg).toHaveBeenCalledTimes(1);
    expect(g.enrich_status).toBe("done");
    expect(g.metacritic).toBe(71);
    expect(g.rawg_rating).toBe(3.5);
    expect(JSON.parse(g.genres)).toEqual(["Puzzle"]);
  });

  it("keeps a game pending when IGDB has no match and the RAWG backup errors", async () => {
    useIgdb();
    settings.set("rawg_api_key", "key");
    seed([{ title: "Obscure Game" }]);
    lookupIgdb.mockResolvedValue(null);
    lookupRawg.mockRejectedValue(new Error("RAWG API error 503"));

    await runQueue();

    // RAWG might well know this game; 'done' would mean never asking it again.
    expect(row("Obscure Game").enrich_status).toBe("pending");
  });

  it("keeps IGDB-unmatched games pending while RAWG's breaker is open", async () => {
    useIgdb();
    settings.set("rawg_api_key", "key");
    const titles = Array.from({ length: 8 }, (_, i) => `Obscure ${i}`);
    seed(titles.map((title) => ({ title })));
    lookupIgdb.mockResolvedValue(null);
    lookupRawg.mockRejectedValue(new Error("RAWG API error 503"));

    await runQueue();

    expect(getEnrichProgress().rawgUnavailable).toBe(true);
    // Including the games the breaker skipped without calling RAWG at all.
    for (const title of titles) expect(row(title).enrich_status).toBe("pending");
  });

  it("marks a game done when neither IGDB nor RAWG has heard of it", async () => {
    useIgdb();
    settings.set("rawg_api_key", "key");
    seed([{ title: "Some Itch Jam Game" }]);
    lookupIgdb.mockResolvedValue(null);
    lookupRawg.mockResolvedValue(null);

    await runQueue();

    expect(row("Some Itch Jam Game").enrich_status).toBe("done");
  });

  it("marks an IGDB-unmatched game done when no RAWG key is set", async () => {
    useIgdb();
    seed([{ title: "Some Itch Jam Game" }]);
    lookupIgdb.mockResolvedValue(null);

    await runQueue();

    expect(lookupRawg).not.toHaveBeenCalled();
    expect(row("Some Itch Jam Game").enrich_status).toBe("done");
  });

  it("keeps a game pending when IGDB errors, even if RAWG filled the gap", async () => {
    useIgdb();
    settings.set("rawg_api_key", "key");
    seed([{ title: "Hades", steam_appid: 1145360 }]);
    lookupIgdb.mockRejectedValue(new Error("IGDB API error 503"));
    lookupRawg.mockResolvedValue({
      rawgId: 7,
      metacritic: 93,
      rating: 4.5,
      genres: ["Action"],
      tags: [],
      releaseDate: null,
      coverUrl: null,
    });

    await runQueue();

    const g = row("Hades");
    // RAWG's data is kept in the meantime...
    expect(g.metacritic).toBe(93);
    // ...but the next run should still go back for IGDB's.
    expect(g.enrich_status).toBe("pending");
    expect(getEnrichProgress().lastError).toContain("IGDB API error 503");
  });

  it("stops calling IGDB once it has failed enough times in a row", async () => {
    useIgdb();
    const titles = Array.from({ length: 12 }, (_, i) => `Game ${i}`);
    seed(titles.map((title) => ({ title })));
    lookupIgdb.mockRejectedValue(new Error("IGDB login failed (Twitch 403)"));

    await runQueue();

    expect(getEnrichProgress().igdbUnavailable).toBe(true);
    expect(lookupIgdb.mock.calls.length).toBeLessThan(titles.length);
    for (const title of titles) expect(row(title).enrich_status).toBe("pending");
  });

  it("doesn't trade stored tags for Steam's broad ones while IGDB is down", async () => {
    useIgdb();
    seed([
      {
        title: "Hades",
        steam_appid: 1145360,
        genres: JSON.stringify(["RPG"]),
        tags: JSON.stringify(["roguelike"]),
      },
    ]);
    lookupIgdb.mockRejectedValue(new Error("IGDB API error 503"));
    fetchStoreDetails.mockResolvedValue({
      metacritic: null,
      genres: ["Action"],
      tags: ["Single-player"],
      releaseDate: null,
    });

    await runQueue();

    const g = row("Hades");
    expect(JSON.parse(g.genres)).toEqual(["Action", "RPG"]);
    expect(JSON.parse(g.tags)).toEqual(["Single-player", "roguelike"]);
  });
});

describe("pacing and concurrency", () => {
  it("overlaps work across the different sources", async () => {
    settings.set("rawg_api_key", "key");
    seed([
      { title: "A", steam_appid: 1 },
      { title: "B", steam_appid: 2 },
      { title: "C", steam_appid: 3 },
    ]);

    let inFlight = 0;
    let peak = 0;
    // Slower than a lane's own interval, which is the case that matters: a
    // sluggish source used to add its full latency to every game in turn.
    const track = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1500));
      inFlight--;
    };
    lookupRawg.mockImplementation(async () => {
      await track();
      return null;
    });
    lookupHltb.mockImplementation(async () => {
      await track();
      return null;
    });
    fetchReviewSummary.mockImplementation(async () => {
      await track();
      return { reviewPct: null, reviewCount: null };
    });

    await runQueue();

    // Each host keeps its own pace, so the gain is one game's RAWG call
    // overlapping another's HLTB call rather than queueing behind it.
    expect(peak).toBeGreaterThan(1);
    expect(getEnrichProgress()).toMatchObject({ done: 3, failed: 0 });
  });

  it("still spaces out calls to any single host", async () => {
    settings.set("rawg_api_key", "key");
    seed([{ title: "A" }, { title: "B" }, { title: "C" }]);

    const calledAt: number[] = [];
    lookupRawg.mockImplementation(async () => {
      calledAt.push(Date.now());
      return null;
    });

    await runQueue();

    expect(calledAt).toHaveLength(3);
    // Concurrency must not turn into a burst against one API.
    for (let i = 1; i < calledAt.length; i++) {
      expect(calledAt[i] - calledAt[i - 1]).toBeGreaterThanOrEqual(1000);
    }
  });

  it("estimates the time left from the rate actually achieved", async () => {
    settings.set("rawg_api_key", "key");
    seed(Array.from({ length: 12 }, (_, i) => ({ title: `Game ${i}` })));

    startEnrichment();
    // Let part of the queue drain, then read the estimate mid-run.
    await vi.advanceTimersByTimeAsync(3000);
    const mid = getEnrichProgress();
    expect(mid.running).toBe(true);
    expect(mid.etaSeconds).toBeGreaterThan(0);

    await vi.runAllTimersAsync();
    // Nothing left to wait for once the queue drains.
    expect(getEnrichProgress().etaSeconds).toBeNull();
  });
});

describe("run history", () => {
  it("records the outcome of a completed run", async () => {
    settings.set("rawg_api_key", "key");
    seed([{ title: "Fine" }, { title: "Broken" }]);
    getDb().prepare("UPDATE games SET genres = '{oops' WHERE title = 'Broken'").run();

    expect(getLastRun()).toBeNull();
    await runQueue();

    expect(getLastRun()).toMatchObject({ total: 2, done: 1, failed: 1 });
    expect(getLastRun()?.finishedAt).toBeTruthy();
  });

  it("reports a run that never finished, and clears it once one does", async () => {
    settings.set("rawg_api_key", "key");
    seed([{ title: "A" }]);

    // A run that starts but whose process dies leaves the marker behind. Nothing
    // clears it, because the code that would have has already stopped running.
    startEnrichment();
    expect(getInterruptedRun()).toBeNull(); // still running, so not interrupted yet
    await vi.runAllTimersAsync();
    expect(getInterruptedRun()).toBeNull(); // drained cleanly

    getDb()
      .prepare("INSERT INTO sync_meta (key, value) VALUES ('enrich:running', ?)")
      .run(JSON.stringify({ startedAt: new Date().toISOString(), total: 40 }));
    expect(getInterruptedRun()).toMatchObject({ total: 40 });

    retryFailed();
    seed([{ title: "B" }]);
    await runQueue();
    expect(getInterruptedRun()).toBeNull();
  });
});

describe("requeueing", () => {
  it("retryFailed requeues only failures", () => {
    seed([
      { title: "Ok", enrich_status: "done" },
      { title: "Bad", enrich_status: "failed" },
    ]);
    expect(retryFailed()).toBe(1);
    expect(row("Bad").enrich_status).toBe("pending");
    expect(row("Ok").enrich_status).toBe("done");
  });

  it("refreshAll requeues everything already processed", () => {
    seed([
      { title: "Ok", enrich_status: "done" },
      { title: "Bad", enrich_status: "failed" },
      { title: "New", enrich_status: "pending" },
    ]);
    // "New" is already pending, so it isn't counted as a change.
    expect(refreshAll()).toBe(2);
    for (const title of ["Ok", "Bad", "New"]) {
      expect(row(title).enrich_status).toBe("pending");
    }
  });
});
