import type { GameRow } from "../db.js";

/**
 * What you actually like, learned from your own history.
 *
 * Hand-tuned weights can say that ratings matter more than recency; they can't
 * say that *you* finish RPGs and drop shooters. This is a frequency model over
 * the genres and tags of games you rated, finished or abandoned — deliberately
 * simple, because it has to be explainable in a sentence and it runs over the
 * whole library on every recommendation.
 */

/**
 * Prior strength, in units of games. A genre needs roughly this much evidence
 * behind it before its affinity moves halfway from the baseline to what the
 * evidence alone would say. Without it, one finished RPG reads as "loves RPGs".
 */
const PRIOR_STRENGTH = 4;

/** Ratings pivot here: 10 is full approval, 1 full disapproval, 5–6 a shrug. */
const RATING_MIDPOINT = 5.5;

export interface TasteProfile {
  /** Affinity in [0,1] per genre and tag, keyed lowercase. */
  affinity: Record<string, number>;
  /**
   * How many games are behind each key. A plain count, not the summed strength
   * used for the affinity itself: "two games" is what a threshold should mean
   * and what a reader expects to see, whereas two lukewarm verdicts sum to less
   * than 2 and would silently fall under it.
   */
  evidence: Record<string, number>;
  /** Your own baseline: the share of your verdicts that were positive. */
  globalRate: number;
  /** Number of games that said anything at all. */
  observations: number;
}

export const EMPTY_PROFILE: TasteProfile = {
  affinity: {},
  evidence: {},
  globalRate: 0.5,
  observations: 0,
};

/**
 * One signed observation per game, in [-1, 1]. Zero means the game says
 * nothing and is skipped.
 *
 * A rating is the most direct statement available, so it wins outright where
 * there is one — also counting that game's status would be the same opinion
 * counted twice.
 */
function verdict(g: GameRow): number {
  if (g.personal_rating != null) {
    return (g.personal_rating - RATING_MIDPOINT) / (10 - RATING_MIDPOINT);
  }
  if (g.status === "finished") return 1;
  if (g.status === "abandoned") return -1;
  return 0;
}

function keysOf(g: GameRow): string[] {
  const parse = (json: string): string[] => {
    try {
      return JSON.parse(json) as string[];
    } catch {
      return [];
    }
  };
  const all = [...parse(g.genres), ...parse(g.tags)];
  // A game listing the same word as both genre and tag shouldn't count twice.
  return [...new Set(all.map((s) => s.toLowerCase()))];
}

export function computeTasteProfile(games: GameRow[]): TasteProfile {
  const pos: Record<string, number> = {};
  const neg: Record<string, number> = {};
  const counts: Record<string, number> = {};
  let totalPos = 0;
  let totalNeg = 0;
  let observations = 0;

  for (const game of games) {
    const v = verdict(game);
    if (v === 0) continue;
    observations++;
    if (v > 0) totalPos += v;
    else totalNeg += -v;

    for (const key of keysOf(game)) {
      counts[key] = (counts[key] ?? 0) + 1;
      if (v > 0) pos[key] = (pos[key] ?? 0) + v;
      else neg[key] = (neg[key] ?? 0) + -v;
    }
  }

  if (totalPos + totalNeg === 0) return EMPTY_PROFILE;

  const globalRate = totalPos / (totalPos + totalNeg);
  const affinity: Record<string, number> = {};
  const evidence: Record<string, number> = {};

  for (const key of new Set([...Object.keys(pos), ...Object.keys(neg)])) {
    const p = pos[key] ?? 0;
    const n = neg[key] ?? 0;
    // Shrunk toward the user's own baseline rather than toward 0.5: someone who
    // finishes most of what they start would otherwise look like they love
    // everything. This way the score only reacts to how a genre differs from
    // that person's normal, and a library with no real preferences produces
    // near-equal affinities — which shifts every game alike and reorders none.
    affinity[key] = (p + PRIOR_STRENGTH * globalRate) / (p + n + PRIOR_STRENGTH);
    evidence[key] = counts[key] ?? 0;
  }

  return { affinity, evidence, globalRate, observations };
}

/**
 * How well a game matches the profile, in [0,1]. Games with nothing to go on —
 * and every game when there's no history yet — sit at the baseline, which adds
 * a constant to the composite and therefore changes no ordering.
 */
export function tasteScore(game: GameRow, profile: TasteProfile): number {
  if (profile.observations === 0) return 0.5;
  const scores = keysOf(game)
    .map((k) => profile.affinity[k])
    .filter((v): v is number => v !== undefined);
  if (!scores.length) return profile.globalRate;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

export interface TasteHighlight {
  key: string;
  affinity: number;
  evidence: number;
}

/**
 * The genres and tags furthest from your baseline in each direction, for
 * showing the user what the model thinks it has learned. Keys with little
 * behind them are dropped rather than presented as findings.
 */
export function tasteHighlights(
  profile: TasteProfile,
  { limit = 5, minEvidence = 2 } = {},
): { liked: TasteHighlight[]; disliked: TasteHighlight[] } {
  const rows = Object.entries(profile.affinity)
    .filter(([key]) => (profile.evidence[key] ?? 0) >= minEvidence)
    .map(([key, affinity]) => ({ key, affinity, evidence: profile.evidence[key] ?? 0 }));

  const liked = rows
    .filter((r) => r.affinity > profile.globalRate)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, limit);
  const disliked = rows
    .filter((r) => r.affinity < profile.globalRate)
    .sort((a, b) => a.affinity - b.affinity)
    .slice(0, limit);

  return { liked, disliked };
}
