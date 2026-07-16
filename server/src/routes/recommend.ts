import { Router } from "express";
import { listGames } from "../lib/library.js";
import {
  recommend,
  DEFAULT_WEIGHTS,
  effectiveRating,
  type RecommendMode,
  type Weights,
} from "../lib/score.js";
import type { GameRow } from "../db.js";

export const recommendRouter = Router();

const MODES: RecommendMode[] = [
  "play-next",
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
  const budgetHours = q.budget != null && q.budget !== "" ? Number(q.budget) : null;

  const weights: Weights = { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(weights) as (keyof Weights)[]) {
    const v = q[`w_${k}`];
    if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) {
      weights[k] = Number(v);
    }
  }

  const games = listGames({
    genre: typeof q.genre === "string" ? q.genre : undefined,
    tag: typeof q.tag === "string" ? q.tag : undefined,
    maxDifficulty:
      q.maxDifficulty != null && q.maxDifficulty !== "" ? Number(q.maxDifficulty) : undefined,
  });

  const limit = q.limit != null && !Number.isNaN(Number(q.limit)) ? Number(q.limit) : 25;
  const results = recommend(games, mode, { budgetHours, weights }).slice(0, limit);
  res.json({
    mode,
    count: results.length,
    results: results.map((r) => ({
      score: Math.round(r.score * 1000) / 1000,
      reason: r.reason,
      game: toApi(r.game),
    })),
  });
});
