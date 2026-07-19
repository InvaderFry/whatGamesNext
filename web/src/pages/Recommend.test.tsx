import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Recommend from "./Recommend";
import { api } from "../api";
import { makeGame } from "../test-utils";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, recommend: vi.fn(), patchGame: vi.fn() } };
});

const recommend = vi.mocked(api.recommend);

beforeEach(() => {
  recommend.mockReset();
  recommend.mockResolvedValue({
    mode: "play-next",
    count: 1,
    results: [{ score: 0.9, reason: "rated 93", breakdown: null, game: makeGame() }],
  });
});

describe("Recommend", () => {
  it("loads play-next on mount and shows results", async () => {
    render(<Recommend />);
    expect(await screen.findByText("Hades")).toBeInTheDocument();
    const params = recommend.mock.calls[0][0];
    expect(params.get("mode")).toBe("play-next");
    expect(params.get("budget")).toBe("20");
  });

  it("refetches when switching modes", async () => {
    const user = userEvent.setup();
    render(<Recommend />);
    await screen.findByText("Hades");

    await user.click(screen.getByRole("button", { name: "Quick wins" }));
    const params = recommend.mock.calls.at(-1)![0];
    expect(params.get("mode")).toBe("quick-wins");
  });

  it("omits the budget when the checkbox is unticked", async () => {
    const user = userEvent.setup();
    render(<Recommend />);
    await screen.findByText("Hades");

    await user.click(screen.getByRole("checkbox"));
    const params = recommend.mock.calls.at(-1)![0];
    expect(params.get("budget")).toBeNull();
  });

  it("shows the empty state when nothing matches", async () => {
    recommend.mockResolvedValue({ mode: "play-next", count: 0, results: [] });
    render(<Recommend />);
    expect(await screen.findByText(/Nothing matched this mode/)).toBeInTheDocument();
  });

  it("shows an error notice when the request fails", async () => {
    recommend.mockRejectedValue(new Error("api down"));
    render(<Recommend />);
    expect(await screen.findByText("api down")).toBeInTheDocument();
  });
});
