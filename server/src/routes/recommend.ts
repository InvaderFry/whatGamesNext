import { Router } from "express";
import { listGames } from "../lib/library.js";
import { boundedNumber } from "../lib/params.js";
import { computeTasteProfile } from "../lib/taste.js";
import {
  recommend,
  DEFAULT_WEIGHTS,
  effectiveRating,
  type RecommendMode,
  type Weights,
} from "../lib/score.js";
import type { GameRow } from "../db.js";

export const recommendRouter = Router();

/**
 * Bounds for every number this route reads. The values are the ranges the
 * controls in `Recommend.tsx` actually offer, so the API accepts what the UI can
 * send and nothing stranger.
 */

/**
 * The time-budget slider runs 2–100 hours. Nothing on HowLongToBeat has a main
 * story anywhere near 1,000 hours, so past that the length-fit score can't move
 * — the cap is only here to keep the value finite and the sort meaningful.
 * `lengthFitScore` already reads 0 as "no budget", the same as null, so a zero
 * floor costs nothing.
 */
const BUDGET_BOUNDS = { min: 0, max: 1000, fallback: null };

/** The difficulty estimate is a 1–5 scale; nothing outside it means anything. */
const DIFFICULTY_BOUNDS = { min: 1, max: 5, fallback: null };

/**
 * Each weight slider is 0–2. Zero is the meaningful floor: it switches a
 * component off. Negative was the actual bug — it doesn't weaken a component,
 * it reverses it, so a negative rating weight ranks the worst-reviewed game in
 * the library first.
 */
const WEIGHT_BOUNDS = { min: 0, max: 2 };

/**
 * The UI never sends a limit and takes the default. 200 is past any plausible
 * page of recommendations and well short of serializing a 1,500-game library
 * into one response; the floor of 1 is what stops a negative limit turning
 * `slice(0, limit)` into "everything except the last few".
 */
const LIMIT_BOUNDS = { min: 1, max: 200, fallback: 25 };

const MODES: RecommendMode[] = [
  "play-next",
  "tonight",
  "quick-wins",
  "backlog-shame",
  "hidden-gems",
  "classics-missed",
  "surprise",
];

function toApi(g: GameRow) {
  return {
    ...g,
    genres: JSON.parse(g.genres) as string[],
    tags: JSON.parse(g.tags) as string[],
    hidden: !!g.hidden,
    effective_rating: effectiveRating(g),
    effective_difficulty: g.difficulty_override ?? g.difficulty,
  };
}

recommendRouter.get("/recommend", (req, res) => {
  const q = req.query;
  const mode = (typeof q.mode === "string" ? q.mode : "play-next") as RecommendMode;
  if (!MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${MODES.join(", ")}` });
  }
  const budgetHours = boundedNumber(q.budget, BUDGET_BOUNDS);

  const weights: Weights = { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(weights) as (keyof Weights)[]) {
    // Each weight falls back to its own default, so one unreadable slider value
    // doesn't drag the whole ranking to zero.
    weights[k] = boundedNumber(q[`w_${k}`], { ...WEIGHT_BOUNDS, fallback: DEFAULT_WEIGHTS[k] });
  }

  const games = listGames({
    genre: typeof q.genre === "string" ? q.genre : undefined,
    tag: typeof q.tag === "string" ? q.tag : undefined,
    maxDifficulty: boundedNumber(q.maxDifficulty, DIFFICULTY_BOUNDS) ?? undefined,
  });

  // Learned from the whole library, deliberately not from `games` above: that
  // list is already narrowed by the genre/tag/difficulty filters, so learning
  // taste from it would just reflect the filter back. Hidden and finished games
  // are evidence even though they're never recommended.
  const taste = computeTasteProfile(listGames({ includeHidden: true }));

  const limit = boundedNumber(q.limit, LIMIT_BOUNDS);
  const scored = recommend(games, mode, { budgetHours, weights, taste });
  const results = scored.slice(0, limit);
  res.json({
    mode,
    count: results.length,
    // Pre-slice, so callers can say how many games actually matched the filters
    // rather than just how many fit on the page.
    total: scored.length,
    results: results.map((r) => ({
      score: Math.round(r.score * 1000) / 1000,
      reason: r.reason,
      breakdown: r.breakdown ?? null,
      game: toApi(r.game),
    })),
  });
});
