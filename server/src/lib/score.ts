import type { GameRow } from "../db.js";
import { tasteScore, EMPTY_PROFILE, type TasteProfile } from "./taste.js";

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
  taste: number; // match against the genres/tags you actually finish
}

export const DEFAULT_WEIGHTS: Weights = {
  rating: 1,
  unplayed: 0.8,
  lengthFit: 0.6,
  recency: 0.3,
  // On by default: with no history every game scores the same here, so it
  // contributes a constant and reorders nothing until there's something to learn.
  taste: 0.7,
};

/**
 * Best available rating on a 0–100 scale, or null when nothing is known.
 * Your own score wins where you've given one — you've played the thing, and a
 * critic hasn't played it *for you*.
 */
export function effectiveRating(g: GameRow): number | null {
  if (g.personal_rating != null) return g.personal_rating * 10; // stored 1–10
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

export type ScoreBreakdown = Record<keyof Weights, number>;

function componentScores(
  g: GameRow,
  budgetHours: number | null,
  taste: TasteProfile,
): ScoreBreakdown {
  const rating = effectiveRating(g);
  return {
    rating: rating != null ? rating / 100 : 0.4,
    unplayed: unplayedScore(g.playtime_minutes),
    lengthFit: lengthFitScore(g.hltb_main, budgetHours),
    recency: recencyScore(g.release_date),
    taste: tasteScore(g, taste),
  };
}

export function compositeScore(
  g: GameRow,
  weights: Weights = DEFAULT_WEIGHTS,
  budgetHours: number | null = null,
  taste: TasteProfile = EMPTY_PROFILE,
): number {
  const scores = componentScores(g, budgetHours, taste);
  const keys = Object.keys(scores) as (keyof Weights)[];
  const totalWeight = keys.reduce((a, k) => a + weights[k], 0);
  if (totalWeight === 0) return 0;
  return keys.reduce((a, k) => a + weights[k] * scores[k], 0) / totalWeight;
}

/**
 * Each component's share of the final composite score (fractions summing to 1),
 * so the UI can explain what drove a recommendation.
 */
export function scoreBreakdown(
  g: GameRow,
  weights: Weights = DEFAULT_WEIGHTS,
  budgetHours: number | null = null,
  taste: TasteProfile = EMPTY_PROFILE,
): ScoreBreakdown | null {
  const scores = componentScores(g, budgetHours, taste);
  const keys = Object.keys(scores) as (keyof Weights)[];
  const total = keys.reduce((a, k) => a + weights[k] * scores[k], 0);
  if (total <= 0) return null;
  const out = {} as ScoreBreakdown;
  for (const k of keys) out[k] = Math.round(((weights[k] * scores[k]) / total) * 100) / 100;
  return out;
}

export type RecommendMode =
  | "play-next"
  | "tonight"
  | "quick-wins"
  | "backlog-shame"
  | "hidden-gems"
  | "classics-missed"
  | "surprise";

export interface RecommendOptions {
  budgetHours?: number | null;
  weights?: Weights;
  /** Built from the whole library by the caller — see routes/recommend.ts. */
  taste?: TasteProfile;
}

/**
 * The floor for Quick Wins. Deliberately lower than backlog-shame's 80: that
 * mode is about games you *should* be embarrassed to have skipped, while this
 * one only needs to keep out the ones you'd regret the evening on. 70 is also
 * where Metacritic's own green band starts, which is the scale most of these
 * ratings arrive on.
 */
const QUICK_WIN_MIN_RATING = 70;

interface Scored {
  game: GameRow;
  score: number;
  reason: string;
  breakdown?: ScoreBreakdown | null;
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
  const taste = opts.taste ?? EMPTY_PROFILE;

  switch (mode) {
    case "play-next":
      return pool
        .map((g) => ({
          game: g,
          score: compositeScore(g, weights, budget, taste),
          reason: describeComposite(g, budget),
          breakdown: scoreBreakdown(g, weights, budget, taste),
        }))
        .sort((a, b) => b.score - a.score);

    // "I have two hours" is a different question from "what should I start".
    // These are games already under way, ranked by what's *left* rather than by
    // how good they are — that call was made when they were started.
    case "tonight":
      return pool
        .filter((g) => g.status === "playing")
        .map((g) => {
          const playedHours = g.playtime_minutes / 60;
          const remaining = g.hltb_main != null ? Math.max(0, g.hltb_main - playedHours) : null;
          const rating = effectiveRating(g);
          return {
            game: g,
            // Fit of the remaining time dominates; rating only breaks ties.
            score:
              lengthFitScore(remaining, budget) * 0.8 + (rating != null ? rating / 100 : 0.5) * 0.2,
            reason: describeRemaining(g, remaining, playedHours),
          };
        })
        .sort((a, b) => b.score - a.score);

    // "Short and highly rated" is the promise, so a game already known to be
    // poorly reviewed doesn't belong here however short it is. An *unrated*
    // game does: without a RAWG key almost nothing has a rating, and a hard
    // floor would empty the mode entirely. Unknowns score 40 below, which sinks
    // them beneath anything rated without pretending to know they're bad.
    case "quick-wins":
      return pool
        .filter((g) => {
          const rating = effectiveRating(g);
          return (
            (rating == null || rating >= QUICK_WIN_MIN_RATING) &&
            g.hltb_main != null &&
            g.hltb_main <= (budget ?? 12) &&
            g.playtime_minutes < 120
          );
        })
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
          const age =
            (Date.now() - new Date(g.release_date).getTime()) / (365.25 * 24 * 3600 * 1000);
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

function describeRemaining(g: GameRow, remaining: number | null, playedHours: number): string {
  const played = formatMinutes(g.playtime_minutes);
  if (remaining == null) return `${played} in — main story length unknown`;
  if (remaining <= 0) return `${played} in, past the ${g.hltb_main}h main story`;
  const pct = Math.round((playedHours / g.hltb_main!) * 100);
  return `about ${Math.round(remaining)}h left of ${g.hltb_main}h — ${pct}% through`;
}

function describeComposite(g: GameRow, budget: number | null): string {
  const bits: string[] = [];
  const rating = effectiveRating(g);
  if (rating != null) bits.push(`rated ${Math.round(rating)}`);
  if (g.hltb_main != null) {
    bits.push(
      budget && g.hltb_main <= budget
        ? `${g.hltb_main}h — fits your budget`
        : `${g.hltb_main}h main story`,
    );
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
