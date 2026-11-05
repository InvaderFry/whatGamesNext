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

let cachedToken: string | null = null;
let pendingToken: Promise<string> | null = null;

/** For tests. */
export function resetHltbTokenForTests(): void {
  cachedToken = null;
  pendingToken = null;
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
  let res = await search(await getToken(), title);
  if (res.status === 403) {
    // Expired or rejected token — get a fresh one and retry once, as the site does.
    cachedToken = null;
    res = await search(await getToken(), title);
  }
  if (!res.ok) {
    if (res.status === 403) cachedToken = null;
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
