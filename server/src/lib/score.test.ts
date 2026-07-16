import { describe, it, expect } from "vitest";
import { compositeScore, effectiveRating, recommend } from "./score.js";
import type { GameRow } from "../db.js";

function game(overrides: Partial<GameRow>): GameRow {
  return {
    id: 1,
    title: "Test Game",
    normalized_title: "test game",
    store: "steam",
    steam_appid: null,
    epic_app_name: null,
    playtime_minutes: 0,
    metacritic: null,
    rawg_id: null,
    rawg_rating: null,
    steam_review_pct: null,
    steam_review_count: null,
    hltb_main: null,
    hltb_extra: null,
    hltb_completionist: null,
    difficulty: null,
    difficulty_override: null,
    genres: "[]",
    tags: "[]",
    release_date: null,
    cover_url: null,
    status: "unplayed",
    hidden: 0,
    enrich_status: "done",
    enrich_error: null,
    last_synced: null,
    ...overrides,
  };
}

describe("effectiveRating", () => {
  it("prefers metacritic, then rawg (scaled), then steam", () => {
    expect(effectiveRating(game({ metacritic: 90, rawg_rating: 2, steam_review_pct: 50 }))).toBe(90);
    expect(effectiveRating(game({ rawg_rating: 4.5, steam_review_pct: 50 }))).toBe(90);
    expect(effectiveRating(game({ steam_review_pct: 85 }))).toBe(85);
    expect(effectiveRating(game({}))).toBeNull();
  });
});

describe("compositeScore", () => {
  it("scores an unplayed acclaimed game above a played mediocre one", () => {
    const acclaimed = game({ metacritic: 95, playtime_minutes: 0 });
    const mediocre = game({ metacritic: 60, playtime_minutes: 3000 });
    expect(compositeScore(acclaimed)).toBeGreaterThan(compositeScore(mediocre));
  });

  it("rewards games that fit the time budget", () => {
    const short = game({ metacritic: 85, hltb_main: 8 });
    const long = game({ metacritic: 85, hltb_main: 80 });
    expect(compositeScore(short, undefined, 10)).toBeGreaterThan(compositeScore(long, undefined, 10));
  });
});

describe("recommend", () => {
  const library = [
    game({ id: 1, title: "Acclaimed Unplayed", metacritic: 95, playtime_minutes: 0, hltb_main: 10, release_date: "2023-01-01" }),
    game({ id: 2, title: "Old Classic", metacritic: 96, playtime_minutes: 0, hltb_main: 13, release_date: "2004-11-16" }),
    game({ id: 3, title: "Hidden Gem", steam_review_pct: 95, steam_review_count: 800, playtime_minutes: 0, hltb_main: 6, release_date: "2022-01-01" }),
    game({ id: 4, title: "Already Finished", metacritic: 99, status: "finished" }),
    game({ id: 5, title: "Hidden Game", metacritic: 90, hidden: 1 }),
    game({ id: 6, title: "Big Popular Game", steam_review_pct: 96, steam_review_count: 500000, playtime_minutes: 6000 }),
  ];

  it("excludes finished and hidden games from every mode", () => {
    for (const mode of ["play-next", "quick-wins", "backlog-shame", "hidden-gems", "classics-missed"] as const) {
      const ids = recommend(library, mode).map((r) => r.game.id);
      expect(ids).not.toContain(4);
      expect(ids).not.toContain(5);
    }
  });

  it("quick-wins returns only short, barely-played games", () => {
    const results = recommend(library, "quick-wins", { budgetHours: 12 });
    expect(results.every((r) => (r.game.hltb_main ?? 99) <= 12)).toBe(true);
    expect(results.every((r) => r.game.playtime_minutes < 120)).toBe(true);
  });

  it("hidden-gems requires high review pct and modest review counts", () => {
    const ids = recommend(library, "hidden-gems").map((r) => r.game.id);
    expect(ids).toEqual([3]);
  });

  it("classics-missed only returns old, acclaimed, unplayed games", () => {
    const ids = recommend(library, "classics-missed").map((r) => r.game.id);
    expect(ids).toEqual([2]);
  });

  it("surprise returns exactly one playable game", () => {
    const results = recommend(library, "surprise");
    expect(results).toHaveLength(1);
    expect([1, 2, 3, 6]).toContain(results[0].game.id);
  });
});
