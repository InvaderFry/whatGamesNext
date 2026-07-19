import { afterEach, describe, expect, it, vi } from "vitest";
import { extractAppScriptPaths, extractSeekPath, lookupHltb } from "./hltb.js";

const HOMEPAGE_FIXTURE = `
<!doctype html><html><head>
<script src="/_next/static/chunks/framework-abc123.js" defer></script>
<script src="/_next/static/chunks/pages/_app-9f8e7d6c5b4a.js" defer></script>
</head><body></body></html>`;

const BUNDLE_FIXTURE = `
(self.webpackChunk=self.webpackChunk||[]).push([[123],{456:function(e,t,n){
var r=fetch("/api/seek/".concat("d4b2b330").concat("bd26a8af"),{method:"POST"});
}}]);`;

describe("extractAppScriptPaths", () => {
  it("finds _app chunk paths in the homepage HTML", () => {
    expect(extractAppScriptPaths(HOMEPAGE_FIXTURE)).toEqual([
      "/_next/static/chunks/pages/_app-9f8e7d6c5b4a.js",
    ]);
  });

  it("returns empty for HTML without app chunks", () => {
    expect(extractAppScriptPaths("<html><body>nope</body></html>")).toEqual([]);
  });
});

describe("extractSeekPath", () => {
  it("reassembles the concat-built token from the bundle", () => {
    expect(extractSeekPath(BUNDLE_FIXTURE)).toBe("/api/seek/d4b2b330bd26a8af");
  });

  it("handles a single-concat token", () => {
    expect(extractSeekPath('fetch("/api/find/".concat("onlyone"))')).toBe("/api/find/onlyone");
  });

  it("returns null when the pattern is missing", () => {
    expect(extractSeekPath("var x = 1;")).toBeNull();
  });
});

describe("lookupHltb", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-derives a stale token and retries the search once", async () => {
    const searchHit = {
      data: [
        {
          game_name: "Hades",
          release_world: 2020,
          comp_main: 36000,
          comp_plus: 72000,
          comp_100: 0,
        },
      ],
    };
    let posts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts++;
        return posts === 1 ? new Response("not found", { status: 404 }) : Response.json(searchHit);
      }
      if (url.endsWith(".js")) return new Response(BUNDLE_FIXTURE);
      return new Response(HOMEPAGE_FIXTURE);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupHltb("Hades");
    expect(posts).toBe(2);
    expect(result).toEqual({ main: 10, extra: 20, completionist: null });
  });
});
