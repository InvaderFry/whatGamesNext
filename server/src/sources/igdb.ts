import { getSetting } from "../lib/settings.js";
import { bestMatch } from "../lib/match.js";

/**
 * IGDB (igdb.com, owned by Twitch) — the primary source for ratings, genres
 * and tags. Free for non-commercial use, documented, and allows 4 requests a
 * second. It replaced RAWG as the main source because RAWG went through long
 * stretches of downtime; see sources/rawg.ts.
 *
 * Auth is Twitch's client-credentials flow: a Client ID and Client Secret are
 * swapped for an app access token that lasts about two months, which is cached
 * here and refreshed when it expires or is rejected.
 * Docs: https://api-docs.igdb.com/
 */

export interface IgdbGameData {
  igdbId: number;
  /** Average of professional critic reviews, 0–100 (IGDB's "aggregated_rating"). */
  criticRating: number | null;
  /** IGDB members' rating, 0–100. */
  userRating: number | null;
  genres: string[];
  tags: string[];
  releaseDate: string | null; // YYYY-MM-DD
  coverUrl: string | null;
  /**
   * The game's Steam appid when IGDB knows it. This is what lets an Epic or
   * pasted game pick up Steam's reviews and Metacritic score.
   */
  steamAppid: number | null;
}

interface IgdbExternalGame {
  uid?: string;
  url?: string;
  external_game_source?: number;
}

export interface IgdbGame {
  id: number;
  name: string;
  first_release_date?: number; // unix seconds
  aggregated_rating?: number;
  rating?: number;
  genres?: Array<{ name: string }>;
  themes?: Array<{ name: string }>;
  keywords?: Array<{ name: string }>;
  game_modes?: Array<{ name: string }>;
  cover?: { image_id?: string };
  external_games?: IgdbExternalGame[];
}

const API = "https://api.igdb.com/v4";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

/** IGDB's id for Steam in external_game_source. The URL check below backs it up. */
const STEAM_SOURCE = 1;

const FIELDS = [
  "name",
  "first_release_date",
  "aggregated_rating",
  "rating",
  "genres.name",
  "themes.name",
  "keywords.name",
  "game_modes.name",
  "cover.image_id",
  "external_games.uid",
  "external_games.url",
  "external_games.external_game_source",
].join(",");

/** Keywords on IGDB are crowd-sourced and can run to hundreds per game. */
const MAX_KEYWORDS = 20;
const MAX_TAGS = 30;

/**
 * IGDB's genre names, mapped onto the vocabulary the rest of the app already
 * speaks — the one RAWG and Steam use, and the one difficulty.ts keys on.
 * Mapping beats adding aliases everywhere downstream: the Library's genre
 * filter and the taste model both treat "RPG" and "Role-playing (RPG)" as two
 * different things otherwise. Genres not listed pass through unchanged.
 */
const GENRE_MAP: Record<string, string> = {
  "role-playing (rpg)": "RPG",
  platform: "Platformer",
  sport: "Sports",
  simulator: "Simulation",
  "real time strategy (rts)": "Strategy",
  "turn-based strategy (tbs)": "Strategy",
  tactical: "Strategy",
  "hack and slash/beat 'em up": "Action",
  "card & board game": "Card",
  pinball: "Arcade",
  "point-and-click": "Adventure",
  "quiz/trivia": "Casual",
};

/**
 * Some IGDB genres say something about difficulty that the coarser genre
 * loses, so they are kept as a tag as well: a visual novel is gentler than the
 * "Adventure" it maps to, and difficulty.ts already weighs these tags.
 */
const GENRE_AS_TAG: Record<string, string> = {
  "point-and-click": "point and click",
  "visual novel": "visual novel",
};

interface CachedToken {
  credentials: string;
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let pendingToken: Promise<string> | null = null;

/** For tests. */
export function resetIgdbTokenForTests(): void {
  cachedToken = null;
  pendingToken = null;
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = getSetting("igdb_client_id");
  const clientSecret = getSetting("igdb_client_secret");
  if (!clientId || !clientSecret) {
    throw new Error("Add your IGDB Client ID and Client Secret in Settings (or .env) first");
  }
  return { clientId, clientSecret };
}

export function igdbConfigured(): boolean {
  return !!(getSetting("igdb_client_id") && getSetting("igdb_client_secret"));
}

async function fetchToken(clientId: string, clientSecret: string): Promise<string> {
  const url = new URL(TOKEN_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("grant_type", "client_credentials");
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(
      `IGDB login failed (Twitch ${res.status}) — check the Client ID and Client Secret`,
    );
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("IGDB login returned no access token");
  cachedToken = {
    credentials: `${clientId}\n${clientSecret}`,
    token: body.access_token,
    // Refresh a minute early rather than racing the expiry.
    expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 0) - 60) * 1000,
  };
  return body.access_token;
}

/**
 * A valid token for the current credentials. Several games are enriched at
 * once, so concurrent callers share one in-flight login rather than each
 * starting their own.
 */
async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const key = `${clientId}\n${clientSecret}`;
  if (cachedToken && cachedToken.credentials === key && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }
  pendingToken ??= fetchToken(clientId, clientSecret).finally(() => {
    pendingToken = null;
  });
  return pendingToken;
}

/** POST an Apicalypse query to an IGDB endpoint. */
async function query<T>(endpoint: string, body: string): Promise<T> {
  const { clientId, clientSecret } = credentials();
  const send = async (token: string) =>
    fetch(`${API}/${endpoint}`, {
      method: "POST",
      headers: {
        "Client-ID": clientId,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      body,
    });

  let res = await send(await getToken(clientId, clientSecret));
  // A token revoked or expired early: log in again once, then give up.
  if (res.status === 401) {
    cachedToken = null;
    res = await send(await getToken(clientId, clientSecret));
  }
  if (!res.ok) throw new Error(`IGDB API error ${res.status}`);
  return (await res.json()) as T;
}

/** Apicalypse strings are double-quoted; a title with a quote in it must not end one early. */
function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function steamAppidOf(game: IgdbGame): number | null {
  for (const ext of game.external_games ?? []) {
    const fromUrl = ext.url?.match(/store\.steampowered\.com\/app\/(\d+)/)?.[1];
    if (fromUrl) return Number(fromUrl);
    if (ext.external_game_source === STEAM_SOURCE && ext.uid && /^\d+$/.test(ext.uid)) {
      return Number(ext.uid);
    }
  }
  return null;
}

function isoDate(unixSeconds: number | undefined): string | null {
  if (unixSeconds == null) return null;
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = v.toLowerCase();
    if (!v || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Turn an IGDB game into the shape the rest of the app stores. */
export function toGameData(game: IgdbGame): IgdbGameData {
  const rawGenres = (game.genres ?? []).map((g) => g.name);
  const genres = dedupe(rawGenres.map((g) => GENRE_MAP[g.toLowerCase()] ?? g));
  const genreTags = rawGenres
    .map((g) => GENRE_AS_TAG[g.toLowerCase()])
    .filter((t): t is string => !!t);
  const tags = dedupe([
    ...(game.game_modes ?? []).map((m) => m.name),
    ...genreTags,
    ...(game.themes ?? []).map((t) => t.name),
    ...(game.keywords ?? []).slice(0, MAX_KEYWORDS).map((k) => k.name),
  ]).slice(0, MAX_TAGS);

  const round = (n: number | undefined) => (n == null ? null : Math.round(n));
  return {
    igdbId: game.id,
    criticRating: round(game.aggregated_rating),
    userRating: round(game.rating),
    genres,
    tags,
    releaseDate: isoDate(game.first_release_date),
    coverUrl: game.cover?.image_id
      ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
      : null,
    steamAppid: steamAppidOf(game),
  };
}

/** The IGDB entry linked to a Steam appid — an exact match, no title guessing. */
async function lookupBySteamAppid(appid: number): Promise<IgdbGame | null> {
  const games = await query<IgdbGame[]>(
    "games",
    `fields ${FIELDS}; where external_games.uid = ${quote(String(appid))}; limit 10;`,
  );
  // The filter matches the uid on *any* store, and another store could use the
  // same number for something else — so confirm it's the Steam link.
  return games.find((g) => steamAppidOf(g) === appid) ?? null;
}

async function lookupByTitle(title: string): Promise<IgdbGame | null> {
  const games = await query<IgdbGame[]>(
    "games",
    // version_parent = null drops the "Deluxe Edition"-style duplicates, which
    // share the main game's name and would otherwise compete with it.
    `search ${quote(title)}; fields ${FIELDS}; where version_parent = null; limit 10;`,
  );
  if (!games.length) return null;
  const idx = bestMatch(
    title,
    games.map((g) => ({
      name: g.name,
      releaseYear: g.first_release_date
        ? new Date(g.first_release_date * 1000).getUTCFullYear()
        : null,
    })),
  );
  return idx < 0 ? null : games[idx];
}

/**
 * Look a game up on IGDB. A known Steam appid is tried first, since it's an
 * exact match; otherwise (Epic, pasted lists, or a Steam game IGDB hasn't
 * linked) it falls back to searching by title.
 *
 * Returns null when IGDB has no confident match — a real answer, not worth
 * retrying. Throws for a bad login, a rate limit or an outage.
 */
export async function lookupIgdb(
  title: string,
  steamAppid: number | null,
): Promise<IgdbGameData | null> {
  let game: IgdbGame | null = null;
  if (steamAppid != null) game = await lookupBySteamAppid(steamAppid);
  game ??= await lookupByTitle(title);
  return game ? toGameData(game) : null;
}
