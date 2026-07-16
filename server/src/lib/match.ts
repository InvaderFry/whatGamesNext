/**
 * Title normalization + fuzzy matching used to dedupe Steam/Epic entries
 * and to pick the right RAWG / HowLongToBeat search result.
 */

// Roman numerals commonly used in sequel titles. "i" and "x" are excluded —
// they are too often real words or letters (e.g. Mega Man X).
const ROMAN: Record<string, string> = {
  ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7",
  viii: "8", ix: "9", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15",
};

const EDITION_SUFFIXES =
  /\b(game of the year|goty|definitive|deluxe|ultimate|complete|enhanced|remastered|anniversary|gold|premium|standard|special|collector'?s?|digital|legendary|royal)\s*(edition|cut|version)?\b/g;

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[™®©]/g, "") // ™ ® ©
    .replace(/[’‘]/g, "'")
    .replace(EDITION_SUFFIXES, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => ROMAN[word] ?? word)
    .join(" ");
}

/** Levenshtein distance, iterative two-row implementation. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr.slice();
  }
  return prev[b.length];
}

/** Similarity in [0, 1] between two raw titles (normalized internally). */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na.length && !nb.length) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

export interface Candidate {
  name: string;
  releaseYear?: number | null;
}

/**
 * Pick the best-matching candidate for a title. Prefers high title similarity;
 * release-year proximity (if both known) breaks near-ties. Returns the index
 * into `candidates`, or -1 if nothing clears `minSimilarity`.
 */
export function bestMatch(
  title: string,
  candidates: Candidate[],
  opts: { releaseYear?: number | null; minSimilarity?: number } = {},
): number {
  const minSimilarity = opts.minSimilarity ?? 0.75;
  let bestIdx = -1;
  let bestScore = -1;
  for (let i = 0; i < candidates.length; i++) {
    let score = titleSimilarity(title, candidates[i].name);
    if (score < minSimilarity) continue;
    const cy = candidates[i].releaseYear;
    if (opts.releaseYear && cy) {
      const gap = Math.abs(opts.releaseYear - cy);
      score += gap === 0 ? 0.05 : gap <= 1 ? 0.02 : -0.05;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}
