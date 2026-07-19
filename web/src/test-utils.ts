import type { Game } from "./api";

export function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 1,
    title: "Hades",
    store: "steam",
    steam_appid: 1145360,
    playtime_minutes: 0,
    metacritic: 93,
    rawg_rating: null,
    steam_review_pct: 98,
    steam_review_count: 300000,
    hltb_main: 21,
    hltb_extra: 46,
    hltb_completionist: 96,
    difficulty: 4,
    difficulty_override: null,
    effective_rating: 93,
    effective_difficulty: 4,
    genres: ["Action", "Roguelike"],
    tags: [],
    release_date: "2020-09-17",
    cover_url: "https://example.com/hades.jpg",
    status: "unplayed",
    hidden: false,
    enrich_status: "done",
    ...overrides,
  };
}
