import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStoreDetails, parseSteamDate } from "./steam.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// Trimmed from a real appdetails response for Portal 2.
const PORTAL_2 = {
  "620": {
    success: true,
    data: {
      type: "game",
      name: "Portal 2",
      metacritic: { score: 95, url: "https://www.metacritic.com/game/pc/portal-2" },
      genres: [
        { id: "1", description: "Action" },
        { id: "25", description: "Adventure" },
        { id: "37", description: "Free to Play" },
      ],
      categories: [
        { id: 2, description: "Single-player" },
        { id: 9, description: "Co-op" },
        { id: 22, description: "Steam Achievements" },
        { id: 29, description: "Steam Trading Cards" },
      ],
      release_date: { coming_soon: false, date: "Apr 18, 2011" },
    },
  },
};

describe("fetchStoreDetails", () => {
  it("keeps Metacritic, real genres and play modes", async () => {
    fetchMock.mockResolvedValue(json(PORTAL_2));
    expect(await fetchStoreDetails(620)).toEqual({
      metacritic: 95,
      genres: ["Action", "Adventure"],
      tags: ["Single-player", "Co-op"],
      releaseDate: "2011-04-18",
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("appids=620");
  });

  it("returns null for an app Steam won't describe", async () => {
    fetchMock.mockResolvedValue(json({ "999": { success: false } }));
    expect(await fetchStoreDetails(999)).toBeNull();
  });

  it("returns null when rate limited", async () => {
    fetchMock.mockResolvedValue(json(null, 429));
    expect(await fetchStoreDetails(620)).toBeNull();
  });
});

describe("parseSteamDate", () => {
  it("parses Steam's English date format", () => {
    expect(parseSteamDate("Apr 18, 2011")).toBe("2011-04-18");
  });

  it("returns null for dates that aren't dates", () => {
    expect(parseSteamDate("Coming soon")).toBeNull();
    expect(parseSteamDate(undefined)).toBeNull();
  });
});
