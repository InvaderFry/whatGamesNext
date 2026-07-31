import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Stats from "./Stats";
import { api, type Stats as StatsData } from "../api";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, stats: vi.fn() } };
});

const stats = vi.mocked(api.stats);

function data(overrides: Partial<StatsData> = {}): StatsData {
  return {
    statusCounts: { unplayed: 40, playing: 3, finished: 12, abandoned: 5 },
    finishedByYear: [{ year: "2026", n: 12 }],
    untrackedFinishes: 0,
    finishedThisYear: 12,
    finishedLastYear: 8,
    backlog: {
      games: 40,
      knownHours: 300,
      unknownLength: 10,
      estimatedHours: 420,
      medianLength: 12,
    },
    genres: [
      { genre: "RPG", games: 8, hours: 120 },
      { genre: "Action", games: 12, hours: 60 },
    ],
    personal: { rated: 2, average: 7.5, top: [{ id: 1, title: "Hades", personal_rating: 9 }] },
    totalPlaytimeHours: 900,
    abandonmentRate: 29,
    recentFinishes: [],
    ...overrides,
  };
}

beforeEach(() => {
  stats.mockReset();
  stats.mockResolvedValue(data());
});

describe("Stats", () => {
  it("shows the estimated backlog, saying how the unsized games were costed", async () => {
    render(<Stats />);
    expect(await screen.findByText(/~420h/)).toBeInTheDocument();
    expect(screen.getByText(/300h known, 10 unsized costed at the 12h median/)).toBeInTheDocument();
  });

  it("falls back to known hours when nothing has a length", async () => {
    stats.mockResolvedValue(
      data({
        backlog: {
          games: 40,
          knownHours: 0,
          unknownLength: 40,
          estimatedHours: null,
          medianLength: null,
        },
      }),
    );
    render(<Stats />);
    expect(await screen.findByText("0h")).toBeInTheDocument();
    expect(screen.getByText("of backlog ahead of you")).toBeInTheDocument();
  });

  it("compares this year against last", async () => {
    render(<Stats />);
    expect(await screen.findByText(/4 more than last year/)).toBeInTheDocument();
  });

  it("says 'same as' rather than '0 more'", async () => {
    stats.mockResolvedValue(data({ finishedThisYear: 8, finishedLastYear: 8 }));
    render(<Stats />);
    expect(await screen.findByText(/same as last year/)).toBeInTheDocument();
  });

  it("breaks playtime down by genre, flagging that the buckets overlap", async () => {
    render(<Stats />);
    expect(await screen.findByText("Where your time goes")).toBeInTheDocument();
    expect(screen.getByText(/these overlap rather than adding up/)).toBeInTheDocument();
    expect(screen.getByText("RPG")).toBeInTheDocument();
  });

  it("summarises your ratings, and explains the feature when there are none", async () => {
    render(<Stats />);
    expect(await screen.findByText(/2 games rated, averaging/)).toBeInTheDocument();

    stats.mockResolvedValue(data({ personal: { rated: 0, average: null, top: [] } }));
    render(<Stats />);
    expect(await screen.findByText(/haven.t rated anything yet/)).toBeInTheDocument();
  });

  it("shows a skeleton rather than a blank page while loading", () => {
    stats.mockReturnValue(new Promise(() => {}));
    render(<Stats />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });
});
