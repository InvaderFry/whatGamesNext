import { getSetting } from "../lib/settings.js";

export interface SteamOwnedGame {
  appid: number;
  name: string;
  playtime_forever: number; // minutes
}

export async function fetchOwnedGames(): Promise<SteamOwnedGame[]> {
  const apiKey = getSetting("steam_api_key");
  const steamId = getSetting("steam_id");
  if (!apiKey || !steamId) {
    throw new Error("Add your Steam API key and SteamID64 in Settings (or .env) first");
  }
  const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamid", steamId);
  url.searchParams.set("include_appinfo", "1");
  url.searchParams.set("include_played_free_games", "1");
  url.searchParams.set("format", "json");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Steam API error ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    response?: { games?: SteamOwnedGame[]; game_count?: number };
  };
  const games = body.response?.games;
  if (!games) {
    throw new Error(
      "Steam returned no games — check that your profile's game details are set to public and STEAM_ID is your SteamID64",
    );
  }
  return games;
}

export interface SteamReviewSummary {
  reviewPct: number | null;
  reviewCount: number | null;
}

/** Keyless review summary for a Steam app (positive %, total count). */
export async function fetchReviewSummary(appid: number): Promise<SteamReviewSummary> {
  const url = `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`;
  const res = await fetch(url);
  if (!res.ok) return { reviewPct: null, reviewCount: null };
  const body = (await res.json()) as {
    query_summary?: { total_positive?: number; total_reviews?: number };
  };
  const s = body.query_summary;
  if (!s || !s.total_reviews) return { reviewPct: null, reviewCount: null };
  return {
    reviewPct: Math.round(((s.total_positive ?? 0) / s.total_reviews) * 100),
    reviewCount: s.total_reviews,
  };
}

export interface SteamStoreDetails {
  /** Metacritic score as shown on the Steam store page, when it has one. */
  metacritic: number | null;
  /** Steam's broad genres — Action, RPG, Indie… Labels like "Free to Play" are dropped. */
  genres: string[];
  /** Play-mode features worth knowing (co-op, multiplayer…), not storefront extras. */
  tags: string[];
  releaseDate: string | null; // YYYY-MM-DD
}

/**
 * Steam lists these as genres, but they describe a price or a release stage
 * rather than the kind of game. Kept out so the taste model doesn't learn that
 * you "like Early Access".
 */
const NOT_GENRES = new Set(["free to play", "early access"]);

/**
 * The one slice of Steam's store categories that describes how a game plays.
 * The rest — achievements, trading cards, cloud saves, controller support —
 * would swamp the tag list with storefront features.
 */
const PLAY_MODE_CATEGORIES = new Set([
  "single-player",
  "multi-player",
  "co-op",
  "online co-op",
  "lan co-op",
  "shared/split screen co-op",
  "pvp",
  "online pvp",
  "shared/split screen pvp",
  "mmo",
]);

/** "Apr 18, 2011" → "2011-04-18". Null for "Coming soon", "Q3 2026" and the like. */
export function parseSteamDate(text: string | undefined): string | null {
  if (!text) return null;
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return null;
  // Parsed as local midnight, so read it back in local time too — going
  // through toISOString could shift it a day either side of UTC.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface AppDetailsResponse {
  [appid: string]: {
    success?: boolean;
    data?: {
      metacritic?: { score?: number };
      genres?: Array<{ description?: string }>;
      categories?: Array<{ description?: string }>;
      release_date?: { coming_soon?: boolean; date?: string };
    };
  };
}

/**
 * Keyless store-page details for a Steam app. Valve doesn't document this
 * endpoint and holds it to roughly 200 requests every five minutes, so it's
 * treated like the review summary: best effort, and null when it won't answer.
 */
export async function fetchStoreDetails(appid: number): Promise<SteamStoreDetails | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=english`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = (await res.json()) as AppDetailsResponse | null;
  const entry = body?.[String(appid)];
  if (!entry?.success || !entry.data) return null;
  const d = entry.data;
  const names = (list: Array<{ description?: string }> | undefined) =>
    (list ?? []).map((x) => x.description ?? "").filter(Boolean);
  return {
    metacritic: d.metacritic?.score ?? null,
    genres: names(d.genres).filter((g) => !NOT_GENRES.has(g.toLowerCase())),
    tags: [
      ...new Set(names(d.categories).filter((c) => PLAY_MODE_CATEGORIES.has(c.toLowerCase()))),
    ],
    releaseDate: d.release_date?.coming_soon ? null : parseSteamDate(d.release_date?.date),
  };
}

export function steamCoverUrl(appid: number): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
}
