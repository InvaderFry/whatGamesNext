import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { api } from "./api";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      games: vi.fn(),
      facets: vi.fn(),
      recommend: vi.fn(),
      queue: vi.fn(),
      stats: vi.fn(),
      settings: vi.fn(),
      syncStatus: vi.fn(),
    },
  };
});

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.mocked(api.games).mockResolvedValue({ count: 0, games: [] });
  vi.mocked(api.facets).mockResolvedValue({ genres: [], tags: [] });
  vi.mocked(api.recommend).mockResolvedValue({
    mode: "play-next",
    count: 0,
    total: 0,
    results: [],
  });
});

describe("App", () => {
  it("opens on the Recommend tab and leaves the URL clean", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "What next?" })).toHaveClass("active");
    expect(window.location.search).toBe("");
  });

  it("boots straight into the tab named in the URL", () => {
    window.history.replaceState(null, "", "/?view=library");
    render(<App />);
    expect(screen.getByRole("button", { name: "Library" })).toHaveClass("active");
    expect(screen.getByLabelText("Search titles")).toBeInTheDocument();
  });

  it("records the tab in the URL when it changes, and clears it on the default", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Library" }));
    expect(window.location.search).toBe("?view=library");

    await user.click(screen.getByRole("button", { name: "What next?" }));
    expect(window.location.search).toBe("");
  });

  it("marks the active page for assistive tech, not just visually", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole("button", { name: "What next?" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Library" })).not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("button", { name: "Library" }));
    expect(screen.getByRole("button", { name: "Library" })).toHaveAttribute("aria-current", "page");
  });

  it("routes to every tab it advertises", async () => {
    const user = userEvent.setup();
    vi.mocked(api.queue).mockResolvedValue({ games: [] });
    vi.mocked(api.stats).mockResolvedValue({
      statusCounts: { unplayed: 0, playing: 0, finished: 0, abandoned: 0 },
      finishedByYear: [],
      untrackedFinishes: 0,
      finishedThisYear: 0,
      finishedLastYear: 0,
      backlog: {
        games: 0,
        knownHours: 0,
        unknownLength: 0,
        estimatedHours: null,
        medianLength: null,
      },
      genres: [],
      personal: { rated: 0, average: null, top: [] },
      taste: { observations: 0, baseline: 50, liked: [], disliked: [] },
      totalPlaytimeHours: 0,
      abandonmentRate: null,
      recentFinishes: [],
    });
    render(<App />);

    // A tab in the nav that renders nothing is the failure mode here — each of
    // these pages arrived in a separate change.
    const pages: [string, () => Promise<HTMLElement>][] = [
      ["Shortlist", () => screen.findByText(/shortlist is empty/)],
      ["Library", () => screen.findByLabelText("Search titles")],
      ["Stats", () => screen.findByText("Library by status")],
    ];
    for (const [label, marker] of pages) {
      await user.click(screen.getByRole("button", { name: label }));
      expect(await marker(), `${label} rendered nothing`).toBeInTheDocument();
    }
  });

  it("ignores an unknown view rather than rendering nothing", () => {
    window.history.replaceState(null, "", "/?view=bogus");
    render(<App />);
    expect(screen.getByRole("button", { name: "What next?" })).toHaveClass("active");
  });
});
