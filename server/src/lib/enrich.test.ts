import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { setDbForTests, getDb, type GameRow } from "../db.js";

// Settings are mocked rather than written to the test database so a developer's
// real .env (which dotenv loads as a fallback) can't leak into these tests.
const settings = new Map<string, string>();
vi.mock("./settings.js", () => ({
  getSetting: (key: string) => settings.get(key) ?? "",
}));
vi.mock("../sources/rawg.js", () => ({ lookupRawg: vi.fn() }));
vi.mock("../sources/hltb.js", () => ({ lookupHltb: vi.fn() }));
vi.mock("../sources/steam.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/steam.js")>()),
  fetchReviewSummary: vi.fn(),
}));

const { lookupRawg } = vi.mocked(await import("../sources/rawg.js"));
const { lookupHltb } = vi.mocked(await import("../sources/hltb.js"));
const { fetchReviewSummary } = vi.mocked(await import("../sources/steam.js"));
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
      hltb_main, steam_review_pct, enrich_status)
    VALUES (@title, @norm, 'steam', @appid, @metacritic, @hltb_main, @pct, @enrich_status)
  `);
  for (const g of games) {
    insert.run({
      title: g.title,
      norm: (g.title ?? "").toLowerCase(),
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
  lookupRawg.mockReset();
  lookupHltb.mockReset();
  fetchReviewSummary.mockReset();
  lookupRawg.mockResolvedValue(null);
  lookupHltb.mockResolvedValue(null);
  fetchReviewSummary.mockResolvedValue({ reviewPct: null, reviewCount: null });
});

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

  it("leaves games pending when no RAWG key is set, but still saves keyless data", async () => {
    seed([{ title: "Hades", steam_appid: 1145360 }]);
    lookupHltb.mockResolvedValue({ main: 21, extra: 44, completionist: 96 });
    fetchReviewSummary.mockResolvedValue({ reviewPct: 98, reviewCount: 250000 });

    await runQueue();

    const g = row("Hades");
    // 'done' here would strand the game forever: only failures are requeued, so
    // adding a RAWG key later could never backfill its rating.
    expect(g.enrich_status).toBe("pending");
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
    expect(g.enrich_status).toBe("done");
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
    expect(lookupHltb).toHaveBeenCalledTimes(3);
    // A dead length source must not fail the games themselves.
    expect(row("E").enrich_status).toBe("done");
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
