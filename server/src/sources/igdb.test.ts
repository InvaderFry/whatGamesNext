import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string>();
vi.mock("../lib/settings.js", () => ({
  getSetting: (key: string) => settings.get(key) ?? "",
}));

const { lookupIgdb, toGameData, resetIgdbTokenForTests } = await import("./igdb.js");

const HADES = {
  id: 113112,
  name: "Hades",
  first_release_date: 1600300800, // 2020-09-17
  aggregated_rating: 93.4,
  rating: 90.6,
  genres: [
    { name: "Role-playing (RPG)" },
    { name: "Hack and slash/Beat 'em up" },
    { name: "Indie" },
  ],
  themes: [{ name: "Action" }, { name: "Fantasy" }],
  keywords: [{ name: "roguelike" }, { name: "Roguelike" }],
  game_modes: [{ name: "Single player" }],
  cover: { image_id: "co39vc" },
  external_games: [
    { uid: "1145360", url: "https://store.steampowered.com/app/1145360", external_game_source: 1 },
    { uid: "2045112", url: "https://www.gog.com/game/hades", external_game_source: 5 },
  ],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  settings.clear();
  settings.set("igdb_client_id", "client");
  settings.set("igdb_client_secret", "secret");
  resetIgdbTokenForTests();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Route the mocked fetch: Twitch login answers with a token, IGDB with `games`. */
function respond(games: (body: string) => unknown[]) {
  fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith("https://id.twitch.tv/")) {
      return json({ access_token: "tok", expires_in: 5000000, token_type: "bearer" });
    }
    return json(games(String(init?.body ?? "")));
  });
}

describe("toGameData", () => {
  it("maps IGDB's genre names onto the app's vocabulary and gathers tags", () => {
    const d = toGameData(HADES);
    expect(d.genres).toEqual(["RPG", "Action", "Indie"]);
    // Game modes first, then themes and keywords, case-insensitively once each.
    expect(d.tags).toEqual(["Single player", "Action", "Fantasy", "roguelike"]);
    expect(d.criticRating).toBe(93);
    expect(d.userRating).toBe(91);
    expect(d.releaseDate).toBe("2020-09-17");
    expect(d.coverUrl).toBe("https://images.igdb.com/igdb/image/upload/t_cover_big/co39vc.jpg");
    expect(d.steamAppid).toBe(1145360);
  });

  it("keeps a difficulty hint that the broad genre would lose", () => {
    const d = toGameData({ id: 1, name: "VN", genres: [{ name: "Visual Novel" }] });
    expect(d.tags).toContain("visual novel");
  });

  it("returns nulls when IGDB has no rating, date, cover or Steam link", () => {
    const d = toGameData({ id: 1, name: "Bare" });
    expect(d).toMatchObject({
      criticRating: null,
      userRating: null,
      releaseDate: null,
      coverUrl: null,
      steamAppid: null,
      genres: [],
      tags: [],
    });
  });
});

describe("lookupIgdb", () => {
  it("logs in once and sends the credentials IGDB expects", async () => {
    respond(() => [HADES]);
    await lookupIgdb("Hades", null);
    await lookupIgdb("Hades", null);

    const logins = fetchMock.mock.calls.filter(([u]) => String(u).startsWith("https://id.twitch"));
    expect(logins).toHaveLength(1);
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).includes("api.igdb.com"))!;
    expect(init.headers).toMatchObject({ "Client-ID": "client", Authorization: "Bearer tok" });
  });

  it("matches a Steam game exactly by its appid", async () => {
    respond((body) => (body.includes("where external_games.uid") ? [HADES] : []));
    const d = await lookupIgdb("Hades", 1145360);
    expect(d?.igdbId).toBe(113112);
    // One exact query, no title search needed.
    const queries = fetchMock.mock.calls.filter(([u]) => String(u).includes("api.igdb.com"));
    expect(queries).toHaveLength(1);
  });

  it("ignores a game that only shares the number on another store", async () => {
    const other = {
      ...HADES,
      id: 9,
      name: "Something Else",
      external_games: [
        { uid: "1145360", url: "https://www.gog.com/game/other", external_game_source: 5 },
      ],
    };
    respond((body) => (body.includes("where external_games.uid") ? [other] : [HADES]));
    const d = await lookupIgdb("Hades", 1145360);
    // Fell through to the title search and found the real one.
    expect(d?.igdbId).toBe(113112);
  });

  it("searches by title, escaping quotes", async () => {
    respond(() => [HADES]);
    await lookupIgdb('The "Hades" Game', null);
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).includes("api.igdb.com"))!;
    expect(init.body).toContain('search "The \\"Hades\\" Game";');
  });

  it("returns null when nothing is a confident match", async () => {
    respond(() => [{ ...HADES, name: "Completely Different" }]);
    expect(await lookupIgdb("Hades", null)).toBeNull();
  });

  it("logs in again once when the token is rejected", async () => {
    let igdbCalls = 0;
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).startsWith("https://id.twitch.tv/")) {
        return json({ access_token: "tok", expires_in: 5000000 });
      }
      igdbCalls++;
      return igdbCalls === 1 ? json({ message: "Authorization Failure" }, 401) : json([HADES]);
    });
    expect((await lookupIgdb("Hades", null))?.igdbId).toBe(113112);
  });

  it("throws on bad credentials rather than reporting no match", async () => {
    fetchMock.mockResolvedValue(json({ message: "invalid client secret" }, 403));
    await expect(lookupIgdb("Hades", null)).rejects.toThrow(/IGDB login failed/);
  });

  it("throws without credentials", async () => {
    settings.clear();
    await expect(lookupIgdb("Hades", null)).rejects.toThrow(/IGDB Client ID/);
  });
});
