import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Recommend from "./Recommend";
import { api } from "../api";
import { makeGame } from "../test-utils";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { ...actual.api, recommend: vi.fn(), facets: vi.fn(), patchGame: vi.fn() },
  };
});

const recommend = vi.mocked(api.recommend);
const facets = vi.mocked(api.facets);

beforeEach(() => {
  recommend.mockReset();
  facets.mockReset();
  recommend.mockResolvedValue({
    mode: "play-next",
    count: 1,
    total: 1,
    results: [{ score: 0.9, reason: "rated 93", breakdown: null, game: makeGame() }],
  });
  facets.mockResolvedValue({ genres: ["Action"], tags: ["Roguelike"] });
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

    await user.click(screen.getByRole("tab", { name: "Quick wins" }));
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
    recommend.mockResolvedValue({ mode: "play-next", count: 0, total: 0, results: [] });
    render(<Recommend />);
    expect(await screen.findByText(/Nothing matched this mode/)).toBeInTheDocument();
  });

  it("shows an error notice when the request fails", async () => {
    recommend.mockRejectedValue(new Error("api down"));
    render(<Recommend />);
    expect(await screen.findByText("api down")).toBeInTheDocument();
  });

  it("sends the default score weights", async () => {
    render(<Recommend />);
    await screen.findByText("Hades");

    const params = recommend.mock.calls[0][0];
    expect(params.get("w_rating")).toBe("1");
    expect(params.get("w_unplayed")).toBe("0.8");
    expect(params.get("w_lengthFit")).toBe("0.6");
    expect(params.get("w_recency")).toBe("0.3");
  });

  it("refetches with an adjusted weight", async () => {
    const user = userEvent.setup();
    render(<Recommend />);
    await screen.findByText("Hades");

    await user.click(screen.getByRole("button", { name: "Tune" }));
    fireEvent.change(screen.getByLabelText("Rating weight"), { target: { value: "0" } });

    await waitFor(() => expect(recommend.mock.calls.at(-1)![0].get("w_rating")).toBe("0"));
  });

  it("hides the weight sliders for modes that ignore them, but keeps the filters", async () => {
    const user = userEvent.setup();
    render(<Recommend />);
    await screen.findByText("Hades");
    await user.click(screen.getByRole("button", { name: "Tune" }));
    expect(screen.getByLabelText("Rating weight")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Quick wins" }));
    expect(screen.queryByLabelText("Rating weight")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Filter by genre")).toBeInTheDocument();
  });

  it("refetches with the genre and difficulty filters applied", async () => {
    const user = userEvent.setup();
    render(<Recommend />);
    await screen.findByText("Hades");
    await user.click(screen.getByRole("button", { name: "Tune" }));

    await user.selectOptions(screen.getByLabelText("Filter by genre"), "Action");
    expect(recommend.mock.calls.at(-1)![0].get("genre")).toBe("Action");

    await user.selectOptions(screen.getByLabelText("Maximum difficulty"), "3");
    expect(recommend.mock.calls.at(-1)![0].get("maxDifficulty")).toBe("3");
  });

  it("restores the defaults after a reset", async () => {
    const user = userEvent.setup();
    render(<Recommend />);
    await screen.findByText("Hades");
    await user.click(screen.getByRole("button", { name: "Tune" }));

    const reset = screen.getByRole("button", { name: "Reset to defaults" });
    expect(reset).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Recency weight"), { target: { value: "2" } });
    await waitFor(() => expect(reset).toBeEnabled());

    await user.click(reset);
    await waitFor(() => expect(recommend.mock.calls.at(-1)![0].get("w_recency")).toBe("0.3"));
  });

  it("announces which mode is selected", async () => {
    const user = userEvent.setup();
    render(<Recommend />);
    await screen.findByText("Hades");

    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Play next");

    await user.click(screen.getByRole("tab", { name: "Quick wins" }));
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Quick wins");
  });

  it("moves between modes with the arrow keys, wrapping at the ends", async () => {
    const user = userEvent.setup();
    render(<Recommend />);
    await screen.findByText("Hades");

    // Only the selected tab is reachable by Tab; arrows move within the list.
    screen.getByRole("tab", { name: "Play next" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Tonight");
    expect(screen.getByRole("tab", { name: "Tonight" })).toHaveFocus();

    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Surprise me");

    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Play next");
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Surprise me");
  });

  it("keeps only the selected mode in the tab order", async () => {
    render(<Recommend />);
    await screen.findByText("Hades");

    const tabs = screen.getAllByRole("tab");
    expect(tabs.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Play next" })).toHaveAttribute("tabindex", "0");
  });

  it("shows placeholder cards rather than an empty page while loading", async () => {
    let resolve!: (v: Awaited<ReturnType<typeof api.recommend>>) => void;
    recommend.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<Recommend />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    resolve({ mode: "play-next", count: 0, total: 0, results: [] });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("points at the filters when they are what excluded everything", async () => {
    const user = userEvent.setup();
    render(<Recommend />);
    await screen.findByText("Hades");
    await user.click(screen.getByRole("button", { name: "Tune" }));

    recommend.mockResolvedValue({ mode: "play-next", count: 0, total: 0, results: [] });
    await user.selectOptions(screen.getByLabelText("Filter by genre"), "Action");

    expect(await screen.findByText(/with your current filters/)).toBeInTheDocument();
  });
});
