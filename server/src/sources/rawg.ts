import { getSetting } from "../lib/settings.js";
import { bestMatch } from "../lib/match.js";

/*
 * RAWG — BACKUP SOURCE, LIKELY TO BE DEPRECATED.
 *
 * RAWG was the original ratings source, but it has proven undependable: the
 * site and API go down for days at a time (in November 2026 it was down on two
 * checks three days apart, and outage trackers disagreed), and other projects have
 * dropped it for the same reason — GameVault called it unmaintained
 * abandonware in 2024 and moved to IGDB.
 *
 * IGDB (sources/igdb.ts) plus Steam's store data (sources/steam.ts) now do its
 * job. RAWG is only asked when IGDB isn't set up, errored, or had no match for
 * a game, and only if a RAWG key is configured at all.
 *
 * To remove it: delete this file and its key from lib/settings.ts, env.ts,
 * .env.example and the Settings page; drop the RAWG block and breaker from
 * lib/enrich.ts; leave the rawg_id / rawg_rating columns in place (or migrate
 * them out) so existing databases keep the ratings RAWG already fetched; and
 * take `rawg_rating * 20` out of effectiveRating (lib/score.ts) and RATING_SQL
 * (lib/library.ts) once nothing carries a RAWG rating any more.
 */

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
