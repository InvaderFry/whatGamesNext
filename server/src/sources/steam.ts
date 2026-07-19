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

export function steamCoverUrl(appid: number): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
}
