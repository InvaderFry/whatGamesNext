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

  it("ignores an unknown view rather than rendering nothing", () => {
    window.history.replaceState(null, "", "/?view=bogus");
    render(<App />);
    expect(screen.getByRole("button", { name: "What next?" })).toHaveClass("active");
  });
});
