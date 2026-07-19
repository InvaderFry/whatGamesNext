import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GameCard from "./GameCard";
import { api } from "../api";
import { makeGame } from "../test-utils";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, patchGame: vi.fn() } };
});

const patchGame = vi.mocked(api.patchGame);

beforeEach(() => {
  patchGame.mockReset();
});

describe("GameCard", () => {
  it("renders title, badges, and the score breakdown", () => {
    render(
      <GameCard
        game={makeGame()}
        reason="rated 93, never played"
        breakdown={{ rating: 0.5, unplayed: 0.3, lengthFit: 0.15, recency: 0.05 }}
      />,
    );
    expect(screen.getByText("Hades")).toBeInTheDocument();
    expect(screen.getByText("★ 93")).toBeInTheDocument();
    expect(screen.getByText("rated 93, never played")).toBeInTheDocument();
    expect(
      screen.getByText("why: rating 50% · untouched 30% · length fit 15% · recency 5%"),
    ).toBeInTheDocument();
  });

  it("patches status and notifies onChanged", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    patchGame.mockResolvedValue(makeGame({ status: "finished" }));

    render(<GameCard game={makeGame()} onChanged={onChanged} />);
    await user.selectOptions(screen.getByLabelText("Play status for Hades"), "finished");

    expect(patchGame).toHaveBeenCalledWith(1, { status: "finished" });
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByLabelText("Play status for Hades")).toHaveValue("finished");
  });

  it("shows an inline error when the patch fails and keeps the old value", async () => {
    const user = userEvent.setup();
    patchGame.mockRejectedValue(new Error("server exploded"));

    render(<GameCard game={makeGame()} />);
    await user.click(screen.getByRole("button", { name: "Hide Hades" }));

    expect(await screen.findByText("server exploded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide Hades" })).toBeInTheDocument();
  });

  it("falls back to the title placeholder when the cover fails to load", () => {
    render(<GameCard game={makeGame()} />);
    fireEvent.error(screen.getByAltText("Hades cover art"));
    expect(screen.queryByAltText("Hades cover art")).not.toBeInTheDocument();
    expect(screen.getAllByText("Hades").length).toBeGreaterThan(1); // placeholder + title
  });
});
