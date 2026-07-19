import { getSetting } from "../lib/settings.js";
import { bestMatch } from "../lib/match.js";

export interface RawgGameData {
  rawgId: number;
  metacritic: number | null;
  rating: number | null; // RAWG user rating, 0–5
  genres: string[];
  tags: string[];
  releaseDate: string | null;
  coverUrl: string | null;
}

interface RawgSearchResult {
  id: number;
  name: string;
  released: string | null;
  metacritic: number | null;
  rating: number | null;
  background_image: string | null;
  genres?: Array<{ name: string }>;
  tags?: Array<{ name: string; language?: string }>;
}

/**
 * Search RAWG for a game by title and return the best-matching result's data,
 * or null when nothing matches confidently.
 */
export async function lookupRawg(title: string): Promise<RawgGameData | null> {
  const apiKey = getSetting("rawg_api_key");
  if (!apiKey) throw new Error("Add your RAWG API key in Settings (or .env) first");
  const url = new URL("https://api.rawg.io/api/games");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("search", title);
  url.searchParams.set("page_size", "5");
  url.searchParams.set("search_precise", "true");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`RAWG API error ${res.status}`);
  const body = (await res.json()) as { results?: RawgSearchResult[] };
  const results = body.results ?? [];
  if (!results.length) return null;

  const idx = bestMatch(
    title,
    results.map((r) => ({
      name: r.name,
      releaseYear: r.released ? new Date(r.released).getFullYear() : null,
    })),
  );
  if (idx < 0) return null;
  const r = results[idx];
  return {
    rawgId: r.id,
    metacritic: r.metacritic ?? null,
    rating: r.rating ?? null,
    genres: (r.genres ?? []).map((g) => g.name),
    tags: (r.tags ?? [])
      .filter((t) => !t.language || t.language === "eng")
      .map((t) => t.name)
      .slice(0, 25),
    releaseDate: r.released,
    coverUrl: r.background_image,
  };
}
