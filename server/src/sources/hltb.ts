import { bestMatch } from "../lib/match.js";

/**
 * HowLongToBeat has no official API. Its site queries POST /api/seek/<token>,
 * where the token is embedded in the site's bundled JS. We extract the token
 * once per process and cache it; if HLTB changes their bundle format this
 * fails soft (games simply keep null lengths).
 */

export interface HltbData {
  main: number | null; // hours
  extra: number | null;
  completionist: number | null;
}

const HLTB = "https://howlongtobeat.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

let cachedEndpoint: string | null = null;

async function findSeekEndpoint(): Promise<string> {
  if (cachedEndpoint) return cachedEndpoint;
  const home = await fetch(HLTB, { headers: { "User-Agent": UA } });
  if (!home.ok) throw new Error(`HLTB homepage ${home.status}`);
  const html = await home.text();
  const scripts = [...html.matchAll(/src="(\/_next\/static\/chunks\/pages\/_app-[^"]+\.js)"/g)];
  for (const [, src] of scripts) {
    const js = await (await fetch(HLTB + src, { headers: { "User-Agent": UA } })).text();
    // Matches fetch("/api/<name>/".concat("a").concat("b") style token assembly
    const m = js.match(/\/api\/(\w+)\/"(?:\.concat\("([^"]*)"\))(?:\.concat\("([^"]*)"\))?/);
    if (m) {
      cachedEndpoint = `${HLTB}/api/${m[1]}/${m[2] ?? ""}${m[3] ?? ""}`;
      return cachedEndpoint;
    }
  }
  throw new Error("Could not locate HLTB search endpoint token");
}

interface HltbSearchEntry {
  game_name: string;
  release_world?: number;
  comp_main: number; // seconds
  comp_plus: number;
  comp_100: number;
}

export async function lookupHltb(title: string): Promise<HltbData | null> {
  const endpoint = await findSeekEndpoint();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Referer: HLTB + "/",
      Origin: HLTB,
    },
    body: JSON.stringify({
      searchType: "games",
      searchTerms: title.split(/\s+/),
      searchPage: 1,
      size: 5,
      searchOptions: {
        games: {
          userId: 0,
          platform: "",
          sortCategory: "popular",
          rangeCategory: "main",
          rangeTime: { min: null, max: null },
          gameplay: { perspective: "", flow: "", genre: "", difficulty: "" },
          rangeYear: { min: "", max: "" },
          modifier: "",
        },
        users: { sortCategory: "postcount" },
        lists: { sortCategory: "follows" },
        filter: "",
        sort: 0,
        randomizer: 0,
      },
      useCache: true,
    }),
  });
  if (!res.ok) {
    // A stale token returns 404 — drop the cache so the next call re-derives it.
    cachedEndpoint = null;
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
