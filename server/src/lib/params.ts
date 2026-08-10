/**
 * Query-string numbers, kept inside a range they mean something in.
 *
 * Routes used to read these straight through `Number()`, which trusts the
 * caller about three separate things: that the value is a number at all, that
 * it's finite, and that it's in range. None of those hold for a URL somebody
 * typed. `limit=99999` served the whole library, `limit=-5` turned a
 * `slice(0, limit)` into "drop the last five", and `w_rating=-1` inverted the
 * ranking so the worst game in the library came out on top.
 */
export interface Bounds {
  min: number;
  max: number;
  /** Used when the value is absent or unreadable. Null means "no opinion". */
  fallback: number | null;
}

/**
 * Read one query param as a number within `bounds`.
 *
 * Out of range clamps rather than 400s. This is a single-user local tool, and a
 * slider that overshoots should still return games — the same instinct as
 * `score.ts` scoring an unknown component 0.4–0.5 instead of failing. It also
 * means a future UI can widen a slider without the API rejecting it outright.
 *
 * Only strings are read. Express turns a repeated `?limit=1&limit=2` into an
 * array, and `Number(["1", "2"])` is NaN — which would land on the fallback
 * anyway, but a nested object would not, so the type is checked rather than
 * inferred from the arithmetic.
 */
// Overloaded so a caller that supplies a real fallback gets `number` back rather
// than `number | null` it has to assert away.
export function boundedNumber(value: unknown, bounds: Bounds & { fallback: number }): number;
export function boundedNumber(value: unknown, bounds: Bounds): number | null;
export function boundedNumber(value: unknown, bounds: Bounds): number | null {
  if (typeof value !== "string" || value.trim() === "") return bounds.fallback;
  const n = Number(value);
  // Catches NaN and both infinities. An infinite budget would divide a length
  // by Infinity and score every game identically; NaN poisons the sort outright.
  if (!Number.isFinite(n)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}
