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

/**
 * Only tags that say something about *challenge* belong here. "Story rich",
 * "atmospheric" and "exploration" were removed: they describe narrative and
 * mood, not difficulty — Disco Elysium and Dark Souls III are both story rich —
 * and "story rich" alone sits on roughly half a typical library, so it was
 * quietly shifting most of it toward easy.
 */
const EASY_TAGS: Record<string, number> = {
  casual: 1.5,
  relaxing: 2,
  "walking simulator": 2,
  "visual novel": 2,
  cozy: 2,
  "point and click": 1,
  "point & click": 1,
  family: 1,
  "family friendly": 1,
};

/**
 * Deliberately omits "action" and "indie". Both sit at the neutral 3 and are
 * attached to a large share of any library, so including them said nothing
 * about difficulty while dragging the average of every co-tagged genre back
 * toward the middle — an Action/Puzzle game scored higher than a Puzzle one for
 * no real reason. A game with no listed genre we recognise falls through to the
 * same neutral 3 anyway.
 */
const GENRE_BASELINE: Record<string, number> = {
  platformer: 3.5,
  fighting: 3.5,
  shooter: 3,
  strategy: 3,
  simulation: 2.5,
  rpg: 3,
  racing: 2.5,
  sports: 2.5,
  arcade: 3,
  adventure: 2.5,
  puzzle: 2.5,
  casual: 2,
  "board games": 2,
  educational: 1.5,
  card: 2.5,
};

/**
 * Cap on the total tag adjustment. Community tags stack — souls-like,
 * difficult, permadeath and bullet hell routinely appear on one game — and
 * uncapped they sum to well past the whole 1–5 range, pinning the score at an
 * extreme regardless of genre.
 *
 * Two is deliberate: a pair of strong tags (souls-like + difficult, worth 4
 * raw) still has to reach 5 from a mid genre, while a game whose genre is
 * genuinely gentle tops out around 4. Tightening it further started disagreeing
 * with itself — Sekiro (Action/Adventure) and Dark Souls III (Action/RPG) carry
 * identical tags but landed a level apart purely on their second genre.
 */
const MAX_TAG_ADJUSTMENT = 2;

/** Starting point when tags are the only signal and no genre is recognised. */
const NEUTRAL_BASE = 3;

/**
 * Returns 1–5, or null when nothing in the game's genres or tags is a
 * difficulty signal. Null matters: returning a confident "3 — Moderate" for a
 * game we know nothing about is indistinguishable from one we actually judged
 * to be moderate, and "Moderate" across a whole library carries no information.
 * The UI already renders a missing difficulty as "?" and sorts it last.
 */
export function deriveDifficulty(genres: string[], tags: string[]): number | null {
  const lowerGenres = genres.map((g) => g.toLowerCase());
  const lowerTags = tags.map((t) => t.toLowerCase());

  const baselines = lowerGenres
    .map((g) => GENRE_BASELINE[g])
    .filter((v): v is number => v !== undefined);

  let adjust = 0;
  let matchedTag = false;
  for (const t of lowerTags) {
    if (HARD_TAGS[t] !== undefined) {
      adjust += HARD_TAGS[t];
      matchedTag = true;
    }
    if (EASY_TAGS[t] !== undefined) {
      adjust -= EASY_TAGS[t];
      matchedTag = true;
    }
  }

  if (!baselines.length && !matchedTag) return null;

  const base = baselines.length
    ? baselines.reduce((a, b) => a + b, 0) / baselines.length
    : NEUTRAL_BASE;
  adjust = Math.min(MAX_TAG_ADJUSTMENT, Math.max(-MAX_TAG_ADJUSTMENT, adjust));

  return Math.min(5, Math.max(1, Math.round(base + adjust)));
}
