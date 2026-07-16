import type { GameRow } from "../db.js";

/**
 * Composite "play next" scoring and named recommendation modes.
 * All component scores are normalized to [0, 1] before weighting so the
 * weights are comparable.
 */

export interface Weights {
  rating: number; // how much critic/user rating matters
  unplayed: number; // bonus for games with little/no playtime
  lengthFit: number; // closeness of HLTB main to the user's time budget
  recency: number; // newer releases score higher
}

export const DEFAULT_WEIGHTS: Weights = {
  rating: 1,
  unplayed: 0.8,
  lengthFit: 0.6,
  recency: 0.3,
};

/** Best available rating on a 0–100 scale, or null when nothing is known. */
export function effectiveRating(g: GameRow): number | null {
  if (g.metacritic != null) return g.metacritic;
  if (g.rawg_rating != null) return g.rawg_rating * 20; // RAWG is 0–5
  if (g.steam_review_pct != null) return g.steam_review_pct;
  return null;
}

function unplayedScore(minutes: number): number {
  // 1 for never touched, fading to 0 at ~20h of playtime.
  return Math.max(0, 1 - minutes / (20 * 60));
}

function lengthFitScore(hltbMain: number | null, budgetHours: number | null): number {
  if (hltbMain == null || budgetHours == null || budgetHours <= 0) return 0.5;
  const ratio = hltbMain / budgetHours;
  if (ratio <= 1) return 1; // fits in the budget
  return Math.max(0, 1 - (ratio - 1) / 2); // 3x over budget → 0
}

function recencyScore(releaseDate: string | null, now = new Date()): number {
  if (!releaseDate) return 0.5;
  const years = (now.getTime() - new Date(releaseDate).getTime()) / (365.25 * 24 * 3600 * 1000);
  if (!Number.isFinite(years)) return 0.5;
  return Math.max(0, 1 - years / 25); // 25-year-old game → 0
}

export function compositeScore(
  g: GameRow,
  weights: Weights = DEFAULT_WEIGHTS,
  budgetHours: number | null = null,
): number {
  const rating = effectiveRating(g);
  const parts = [
    { w: weights.rating, v: rating != null ? rating / 100 : 0.4 },
    { w: weights.unplayed, v: unplayedScore(g.playtime_minutes) },
    { w: weights.lengthFit, v: lengthFitScore(g.hltb_main, budgetHours) },
    { w: weights.recency, v: recencyScore(g.release_date) },
  ];
  const totalWeight = parts.reduce((a, p) => a + p.w, 0);
  if (totalWeight === 0) return 0;
  return parts.reduce((a, p) => a + p.w * p.v, 0) / totalWeight;
}

export type RecommendMode =
  | "play-next"
  | "quick-wins"
  | "backlog-shame"
  | "hidden-gems"
  | "classics-missed"
  | "surprise";

export interface RecommendOptions {
  budgetHours?: number | null;
  weights?: Weights;
}

interface Scored {
  game: GameRow;
  score: number;
  reason: string;
}

function playable(games: GameRow[]): GameRow[] {
  return games.filter((g) => !g.hidden && g.status !== "finished" && g.status !== "abandoned");
}

export function recommend(
  games: GameRow[],
  mode: RecommendMode,
  opts: RecommendOptions = {},
): Scored[] {
  const pool = playable(games);
  const budget = opts.budgetHours ?? null;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;

  switch (mode) {
    case "play-next":
      return pool
        .map((g) => ({
          game: g,
          score: compositeScore(g, weights, budget),
          reason: describeComposite(g, budget),
        }))
        .sort((a, b) => b.score - a.score);

    case "quick-wins":
      return pool
        .filter((g) => g.hltb_main != null && g.hltb_main <= (budget ?? 12) && g.playtime_minutes < 120)
        .map((g) => {
          const rating = effectiveRating(g) ?? 40;
          return {
            game: g,
            score: (rating / 100) * (1 - (g.hltb_main ?? 0) / 40),
            reason: `${g.hltb_main}h main story, rated ${Math.round(rating)}`,
          };
        })
        .sort((a, b) => b.score - a.score);

    case "backlog-shame":
      return pool
        .filter((g) => {
          const rating = effectiveRating(g);
          return rating != null && rating >= 80 && g.playtime_minutes < 120;
        })
        .map((g) => {
          const rating = effectiveRating(g)!;
          return {
            game: g,
            score: rating / 100,
            reason: `rated ${Math.round(rating)} but you've played ${formatMinutes(g.playtime_minutes)}`,
          };
        })
        .sort((a, b) => b.score - a.score);

    case "hidden-gems":
      return pool
        .filter(
          (g) =>
            g.steam_review_pct != null &&
            g.steam_review_pct >= 90 &&
            g.steam_review_count != null &&
            g.steam_review_count > 50 &&
            g.steam_review_count < 5000,
        )
        .map((g) => ({
          game: g,
          score: g.steam_review_pct! / 100,
          reason: `${g.steam_review_pct}% positive from only ${g.steam_review_count} reviews`,
        }))
        .sort((a, b) => b.score - a.score);

    case "classics-missed":
      return pool
        .filter((g) => {
          const rating = effectiveRating(g);
          if (rating == null || rating < 85 || g.playtime_minutes >= 120) return false;
          if (!g.release_date) return false;
          const age = (Date.now() - new Date(g.release_date).getTime()) / (365.25 * 24 * 3600 * 1000);
          return age >= 8;
        })
        .map((g) => ({
          game: g,
          score: effectiveRating(g)! / 100,
          reason: `${new Date(g.release_date!).getFullYear()} classic rated ${Math.round(effectiveRating(g)!)}`,
        }))
        .sort((a, b) => b.score - a.score);

    case "surprise": {
      // Weighted-random pick among the top composite candidates.
      const ranked = recommend(games, "play-next", opts).slice(0, 20);
      if (!ranked.length) return [];
      const total = ranked.reduce((a, r) => a + r.score, 0);
      let roll = Math.random() * total;
      for (const r of ranked) {
        roll -= r.score;
        if (roll <= 0) return [{ ...r, reason: `surprise pick — ${r.reason}` }];
      }
      return [ranked[0]];
    }
  }
}

function describeComposite(g: GameRow, budget: number | null): string {
  const bits: string[] = [];
  const rating = effectiveRating(g);
  if (rating != null) bits.push(`rated ${Math.round(rating)}`);
  if (g.hltb_main != null) {
    bits.push(budget && g.hltb_main <= budget ? `${g.hltb_main}h — fits your budget` : `${g.hltb_main}h main story`);
  }
  if (g.playtime_minutes === 0) bits.push("never played");
  else if (g.playtime_minutes < 120) bits.push(`only ${formatMinutes(g.playtime_minutes)} played`);
  return bits.join(", ") || "in your backlog";
}

export function formatMinutes(minutes: number): string {
  if (minutes === 0) return "0h";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 6) / 10}h`;
}
