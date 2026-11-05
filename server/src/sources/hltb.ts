import { bestMatch } from "../lib/match.js";

/**
 * HowLongToBeat has no official API, so this talks to the same endpoints its
 * own search page does. Expect it to break whenever HLTB rebuilds the site;
 * enrichment treats it as best effort, and games simply keep null lengths.
 *
 * How the site's search works (as of November 2026):
 *   1. GET /api/search/site/init returns { token }. The token is signed and
 *      bound to the caller's IP and User-Agent, so both requests must go out
 *      with the same User-Agent. The request needs a Referer, or it's a 403.
 *   2. POST /api/search/site with the token in an `x-auth-token` header.
 *      An expired token comes back 403; the site fetches a new one and retries
 *      once, and so does this.
 *   3. Searches are limited to about 60 a minute per IP. The 61st comes back
 *      429 {"error":"Too many requests"} with no Retry-After header, and the
 *      token that hit it is dead from then on — every later search with it is
 *      a 403, however long you wait. A fresh token works again once the limit
 *      clears. Measured November 2026: the first 429 came after 60 searches
 *      whether they took 26 seconds or 63, and a fresh token worked 5 seconds
 *      later. So enrichment paces HLTB well under the limit (lib/enrich.ts),
 *      and a 429 here pauses every lookup, drops the token and retries once.
 *
 * The previous version scraped a token out of the site's `pages/_app` JS
 * bundle and POSTed to /api/seek/<token>. HLTB moved to a new bundler and that
 * file no longer exists, which is what made every lookup fail with "Could not
 * locate HLTB search endpoint token". If lookups start failing again, open
 * howlongtobeat.com in a browser, search for a game, and compare the request
 * the page makes (devtools → Network) with what's built here.
 */

export interface HltbData {
  main: number | null; // hours
  extra: number | null;
  completionist: number | null;
}

const HLTB = "https://howlongtobeat.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/**
 * How long to back off after a 429. The limit is per minute; a fresh token
 * worked again after 5 seconds when measured, so half a minute is a generous
 * margin without stalling a long run for long.
 */
export const RATE_LIMIT_COOLDOWN_MS = 30_000;

let cachedToken: string | null = null;
let pendingToken: Promise<string> | null = null;
/** No search goes out before this time — set by a 429, shared by every lookup. */
let cooldownUntil = 0;

/** For tests. */
export function resetHltbTokenForTests(): void {
  cachedToken = null;
  pendingToken = null;
  cooldownUntil = 0;
}

async function waitForCooldown(): Promise<void> {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function fetchToken(): Promise<string> {
  const res = await fetch(`${HLTB}/api/search/site/init?t=${Date.now()}`, {
    headers: { "User-Agent": UA, Referer: `${HLTB}/` },
  });
  if (!res.ok) throw new Error(`HLTB search init ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("HLTB search init returned no token");
  cachedToken = body.token;
  return body.token;
}

/**
 * Forget a token HLTB rejected — but only if it's still the cached one.
 * Lookups run concurrently and can all send the same expired token. The first
 * 403 back gets a fresh token; a slower 403 for the old token that lands
 * afterwards must not throw the fresh one away and log in again for nothing.
 */
function discardToken(rejected: string): void {
  if (cachedToken === rejected) cachedToken = null;
}

/** One token for every lookup until it's rejected; concurrent callers share one init. */
async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  pendingToken ??= fetchToken().finally(() => {
    pendingToken = null;
  });
  return pendingToken;
}

interface HltbSearchEntry {
  game_name: string;
  release_world?: number;
  comp_main: number; // seconds
  comp_plus: number;
  comp_100: number;
}

/** The site sends every filter as an include-list; empty means "any". */
const ANY = { mode: "include", values: [] };

/** The request body the site's own search page sends, with its filters left at "any". */
export function searchBody(title: string) {
  return {
    searchType: "games",
    searchTerms: title.trim().split(/\s+/),
    searchPage: 1,
    size: 5,
    searchOptions: {
      games: {
        userId: 0,
        platform: ANY,
        sortCategory: "popular",
        rangeCategory: "main",
        rangeTime: { min: null, max: null },
        gameplay: { perspective: ANY, flow: ANY, genre: ANY },
        year: ANY,
        modifier: "",
      },
      users: { sortCategory: "postcount" },
      lists: { sortCategory: "follows" },
      filter: "",
      sort: 0,
      randomizer: 0,
    },
    useCache: true,
  };
}

async function search(token: string, title: string): Promise<Response> {
  return fetch(`${HLTB}/api/search/site`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Referer: `${HLTB}/`,
      Origin: HLTB,
      "x-auth-token": token,
    },
    body: JSON.stringify(searchBody(title)),
  });
}

export async function lookupHltb(title: string): Promise<HltbData | null> {
  await waitForCooldown();
  let token = await getToken();
  let res = await search(token, title);
  if (res.status === 429) {
    // Rate limited. The token is dead now too, so drop it, hold every lookup
    // back until the limit has cleared, and retry once with a fresh token.
    discardToken(token);
    cooldownUntil = Math.max(cooldownUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS);
    await waitForCooldown();
    token = await getToken();
    res = await search(token, title);
  } else if (res.status === 403) {
    // Expired or rejected token — get a fresh one and retry once, as the site
    // does. If another lookup already replaced it, this reuses that one.
    discardToken(token);
    token = await getToken();
    res = await search(token, title);
  }
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) discardToken(token);
    if (res.status === 429) {
      cooldownUntil = Math.max(cooldownUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS);
      throw new Error("HLTB search 429 — rate limited (too many searches a minute)");
    }
    throw new Error(`HLTB search ${res.status}`);
  }
  const body = (await res.json()) as { data?: HltbSearchEntry[] };
  const results = body.data ?? [];
  if (!results.length) return null;

  const idx = bestMatch(
    title,
    results.map((r) => ({ name: r.game_name, releaseYear: r.release_world ?? null })),
  );
  if (idx < 0) return null;
  const r = results[idx];
  const hours = (sec: number) => (sec > 0 ? Math.round(sec / 360) / 10 : null);
  return {
    main: hours(r.comp_main),
    extra: hours(r.comp_plus),
    completionist: hours(r.comp_100),
  };
}
