import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Library from "./Library";
import { api } from "../api";
import { makeGame } from "../test-utils";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { ...actual.api, games: vi.fn(), facets: vi.fn(), patchGame: vi.fn() },
  };
});

const games = vi.mocked(api.games);
const facets = vi.mocked(api.facets);
const patchGame = vi.mocked(api.patchGame);

beforeEach(() => {
  games.mockReset();
  facets.mockReset();
  patchGame.mockReset();
  games.mockResolvedValue({ count: 1, games: [makeGame()] });
  facets.mockResolvedValue({ genres: ["Action"], tags: ["Roguelike"] });
});

describe("Library", () => {
  it("loads and renders games with facet options", async () => {
    render(<Library />);
    expect(await screen.findByText("Hades")).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Action" })).toBeInTheDocument();
  });

  it("refetches with the status filter applied", async () => {
    const user = userEvent.setup();
    render(<Library />);
    await screen.findByText("Hades");

    await user.selectOptions(screen.getByLabelText("Filter by status"), "unplayed");
    const params = games.mock.calls.at(-1)![0];
    expect(params.get("status")).toBe("unplayed");
  });

  it("reloads the list after a card edit, so filters re-apply", async () => {
    const user = userEvent.setup();
    patchGame.mockResolvedValue(makeGame({ status: "finished" }));
    render(<Library />);
    await screen.findByText("Hades");
    const callsBefore = games.mock.calls.length;

    await user.selectOptions(screen.getByLabelText("Play status for Hades"), "finished");
    expect(games.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("shows the empty state when the library is empty", async () => {
    games.mockResolvedValue({ count: 0, games: [] });
    render(<Library />);
    expect(await screen.findByText(/No games found/)).toBeInTheDocument();
  });
});
