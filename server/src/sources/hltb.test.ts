import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupHltb, RATE_LIMIT_COOLDOWN_MS, resetHltbTokenForTests, searchBody } from "./hltb.js";

const HADES_HIT = {
  data: [
    // Real numbers from the live site, November 2026.
    { game_name: "Hades", release_world: 2020, comp_main: 84899, comp_plus: 175220, comp_100: 0 },
    {
      game_name: "Hades II",
      release_world: 2025,
      comp_main: 115210,
      comp_plus: 192375,
      comp_100: 0,
    },
  ],
};

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

let fetchMock: ReturnType<typeof vi.fn>;
let tokensIssued: number;

function route(onSearch: Handler) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/search/site/init")) {
      tokensIssued++;
      return Response.json({ token: `token-${tokensIssued}` });
    }
    if (url.endsWith("/api/search/site")) return onSearch(url, init);
    return new Response("unexpected", { status: 500 });
  });
}

function searches() {
  return fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/api/search/site"));
}

beforeEach(() => {
  resetHltbTokenForTests();
  tokensIssued = 0;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupHltb", () => {
  it("gets a token, sends it with the search, and converts seconds to hours", async () => {
    route(() => Response.json(HADES_HIT));

    expect(await lookupHltb("Hades")).toEqual({ main: 23.6, extra: 48.7, completionist: null });

    const [initUrl, initReq] = fetchMock.mock.calls[0];
    expect(String(initUrl)).toContain("/api/search/site/init?t=");
    // The init endpoint 403s without a Referer.
    expect(initReq.headers).toMatchObject({ Referer: "https://howlongtobeat.com/" });

    const [, searchReq] = searches()[0];
    expect(searchReq.method).toBe("POST");
    expect(searchReq.headers).toMatchObject({ "x-auth-token": "token-1" });
    // The token is bound to the User-Agent, so both requests must send the same one.
    expect(searchReq.headers["User-Agent"]).toBe(initReq.headers["User-Agent"]);
    expect(JSON.parse(searchReq.body).searchTerms).toEqual(["Hades"]);
  });

  it("reuses one token across lookups", async () => {
    route(() => Response.json(HADES_HIT));
    await lookupHltb("Hades");
    await lookupHltb("Hades");
    expect(tokensIssued).toBe(1);
  });

  it("gets a fresh token and retries once when the token is rejected", async () => {
    route((_, init) => {
      const token = (init?.headers as Record<string, string>)["x-auth-token"];
      return token === "token-1"
        ? new Response("forbidden", { status: 403 })
        : Response.json(HADES_HIT);
    });

    expect((await lookupHltb("Hades"))?.main).toBe(23.6);
    expect(tokensIssued).toBe(2);
    expect(searches()).toHaveLength(2);
  });

  it("doesn't throw away a refreshed token when a stale 403 arrives late", async () => {
    // Two lookups send the same expired token. One 403 comes back at once and
    // that lookup refreshes; the other's 403 is slow and lands afterwards. It
    // must not discard the fresh token and log in again.
    let releaseLate!: () => void;
    const late = new Promise<Response>((resolve) => {
      releaseLate = () => resolve(new Response("forbidden", { status: 403 }));
    });
    let staleSeen = 0;
    route((_, init) => {
      const token = (init?.headers as Record<string, string>)["x-auth-token"];
      if (token !== "token-1") return Response.json(HADES_HIT);
      staleSeen++;
      return staleSeen === 1 ? new Response("forbidden", { status: 403 }) : late;
    });

    const fast = lookupHltb("Hades");
    const slow = lookupHltb("Hades");
    expect((await fast)?.main).toBe(23.6);
    expect(tokensIssued).toBe(2);

    releaseLate();
    expect((await slow)?.main).toBe(23.6);
    // The slow lookup retried with token-2 instead of fetching a token-3.
    expect(tokensIssued).toBe(2);
    const [, slowRetry] = searches().at(-1)!;
    expect(slowRetry.headers["x-auth-token"]).toBe("token-2");
  });

  it("throws when the retry is rejected too, so the breaker can count it", async () => {
    route(() => new Response("forbidden", { status: 403 }));
    await expect(lookupHltb("Hades")).rejects.toThrow("HLTB search 403");
    expect(searches()).toHaveLength(2);
  });

  it("after a 429, holds off, drops the dead token and retries with a fresh one", async () => {
    vi.useFakeTimers();
    try {
      let searchesSeen = 0;
      route(() => {
        searchesSeen++;
        return searchesSeen === 1
          ? Response.json({ error: "Too many requests" }, { status: 429 })
          : Response.json(HADES_HIT);
      });

      const pending = lookupHltb("Hades");
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_COOLDOWN_MS - 1000);
      // Still cooling down: nothing retried yet.
      expect(searches()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);

      expect((await pending)?.main).toBe(23.6);
      // The token that hit the limit is dead, so the retry used a new one.
      expect(tokensIssued).toBe(2);
      const [, retry] = searches()[1];
      expect(retry.headers["x-auth-token"]).toBe("token-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes other lookups wait out the cooldown too", async () => {
    vi.useFakeTimers();
    try {
      let searchesSeen = 0;
      route(() => {
        searchesSeen++;
        return searchesSeen === 1
          ? Response.json({ error: "Too many requests" }, { status: 429 })
          : Response.json(HADES_HIT);
      });

      const first = lookupHltb("Hades");
      await vi.advanceTimersByTimeAsync(0);
      const second = lookupHltb("Hades");
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_COOLDOWN_MS / 2);
      // The second lookup hasn't gone out into the rate limit.
      expect(searches()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_COOLDOWN_MS);
      await Promise.all([first, second]);
      expect(searches()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes a lookup whose token was revoked by another's 429 wait out the cooldown", async () => {
    vi.useFakeTimers();
    try {
      // A and B both send token-1. A's search hits the limit; B's comes back
      // 403 a moment later because the 429 revoked the token they shared.
      let releaseB!: () => void;
      const bResponse = new Promise<Response>((resolve) => {
        releaseB = () => resolve(new Response("forbidden", { status: 403 }));
      });
      let staleSeen = 0;
      route((_, init) => {
        const token = (init?.headers as Record<string, string>)["x-auth-token"];
        if (token !== "token-1") return Response.json(HADES_HIT);
        staleSeen++;
        return staleSeen === 1
          ? Response.json({ error: "Too many requests" }, { status: 429 })
          : bResponse;
      });

      const a = lookupHltb("Hades");
      const b = lookupHltb("Hades");
      await vi.advanceTimersByTimeAsync(0);
      releaseB();
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_COOLDOWN_MS / 2);
      // B must not spend its one retry while the limit is still in force.
      expect(searches()).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(RATE_LIMIT_COOLDOWN_MS);
      expect((await a)?.main).toBe(23.6);
      expect((await b)?.main).toBe(23.6);
      expect(searches()).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps waiting when another 429 extends the cooldown", async () => {
    vi.useFakeTimers();
    try {
      // A and B both send token-1. A is limited straight away; B's 429 arrives
      // 10s later and pushes the cooldown out to 40s. A must not wake at 30s.
      let releaseB!: () => void;
      const bResponse = new Promise<Response>((resolve) => {
        releaseB = () => resolve(Response.json({ error: "Too many requests" }, { status: 429 }));
      });
      let staleSeen = 0;
      route((_, init) => {
        const token = (init?.headers as Record<string, string>)["x-auth-token"];
        if (token !== "token-1") return Response.json(HADES_HIT);
        staleSeen++;
        return staleSeen === 1
          ? Response.json({ error: "Too many requests" }, { status: 429 })
          : bResponse;
      });

      const a = lookupHltb("Hades");
      const b = lookupHltb("Hades");
      await vi.advanceTimersByTimeAsync(10_000);
      releaseB();
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_COOLDOWN_MS - 5_000); // t = 35s
      expect(searches()).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(5_000); // t = 40s
      expect((await a)?.main).toBe(23.6);
      expect((await b)?.main).toBe(23.6);
      expect(searches()).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says it was rate limited when the retry is limited too", async () => {
    vi.useFakeTimers();
    try {
      route(() => Response.json({ error: "Too many requests" }, { status: 429 }));
      const pending = lookupHltb("Hades");
      const assertion = expect(pending).rejects.toThrow(/429 — rate limited/);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_COOLDOWN_MS);
      await assertion;
      expect(searches()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the token endpoint fails", async () => {
    fetchMock.mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(lookupHltb("Hades")).rejects.toThrow("HLTB search init 403");
  });

  it("returns null when nothing is a confident match", async () => {
    route(() => Response.json({ data: [{ ...HADES_HIT.data[0], game_name: "Unrelated" }] }));
    expect(await lookupHltb("Hades")).toBeNull();
  });
});

describe("searchBody", () => {
  it("leaves every filter at 'any', in the shape the site sends", () => {
    const body = searchBody("  Disco   Elysium ");
    expect(body.searchTerms).toEqual(["Disco", "Elysium"]);
    expect(body.searchOptions.games.platform).toEqual({ mode: "include", values: [] });
    expect(body.searchOptions.games.year).toEqual({ mode: "include", values: [] });
  });
});
