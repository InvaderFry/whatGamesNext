/**
 * Heuristic difficulty score (1 = relaxing, 5 = punishing), derived from
 * genres and community tags. No structured public source for difficulty
 * exists, so this is a best-effort estimate — the UI lets the user override
 * it per game (stored in difficulty_override).
 */

const HARD_TAGS: Record<string, number> = {
  "souls-like": 2,
  soulslike: 2,
  difficult: 2,
  "perma death": 1.5,
  permadeath: 1.5,
  roguelike: 1,
  "rogue-like": 1,
  roguelite: 0.5,
  "rogue-lite": 0.5,
  "bullet hell": 1.5,
  hardcore: 1,
  precision: 0.5,
  "survival horror": 0.5,
  competitive: 0.5,
};

const EASY_TAGS: Record<string, number> = {
  casual: 1.5,
  relaxing: 2,
  "walking simulator": 2,
  "visual novel": 2,
  cozy: 2,
  "point and click": 1,
  "point & click": 1,
  "story rich": 0.5,
  atmospheric: 0.25,
  family: 1,
  "family friendly": 1,
  exploration: 0.25,
};

const GENRE_BASELINE: Record<string, number> = {
  platformer: 3.5,
  fighting: 3.5,
  shooter: 3,
  action: 3,
  strategy: 3,
  simulation: 2.5,
  rpg: 3,
  racing: 2.5,
  sports: 2.5,
  arcade: 3,
  indie: 3,
  adventure: 2.5,
  puzzle: 2.5,
  casual: 2,
  "board games": 2,
  educational: 1.5,
  card: 2.5,
};

export function deriveDifficulty(genres: string[], tags: string[]): number {
  const lowerGenres = genres.map((g) => g.toLowerCase());
  const lowerTags = tags.map((t) => t.toLowerCase());

  let base = 3;
  const baselines = lowerGenres
    .map((g) => GENRE_BASELINE[g])
    .filter((v): v is number => v !== undefined);
  if (baselines.length) {
    base = baselines.reduce((a, b) => a + b, 0) / baselines.length;
  }

  let adjust = 0;
  for (const t of lowerTags) {
    if (HARD_TAGS[t] !== undefined) adjust += HARD_TAGS[t];
    if (EASY_TAGS[t] !== undefined) adjust -= EASY_TAGS[t];
  }

  return Math.min(5, Math.max(1, Math.round(base + adjust)));
}
