import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GameCard from "./GameCard";
import { api } from "../api";
import { makeGame } from "../test-utils";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { ...actual.api, patchGame: vi.fn(), addToQueue: vi.fn(), removeFromQueue: vi.fn() },
  };
});

const patchGame = vi.mocked(api.patchGame);
const addToQueue = vi.mocked(api.addToQueue);
const removeFromQueue = vi.mocked(api.removeFromQueue);

beforeEach(() => {
  patchGame.mockReset();
  addToQueue.mockReset();
  removeFromQueue.mockReset();
  addToQueue.mockResolvedValue({ games: [] });
  removeFromQueue.mockResolvedValue({ games: [] });
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

  it("links to Steam when the game has an appid", () => {
    render(<GameCard game={makeGame()} />);

    expect(screen.getByLabelText("Launch Hades in Steam")).toHaveAttribute(
      "href",
      "steam://rungameid/1145360",
    );
    const store = screen.getByLabelText("Open Hades on the Steam store");
    expect(store).toHaveAttribute("href", "https://store.steampowered.com/app/1145360/");
    expect(store).toHaveAttribute("target", "_blank");
  });

  it("omits the Steam links when there is no appid to launch", () => {
    render(<GameCard game={makeGame({ title: "Control", store: "epic", steam_appid: null })} />);

    expect(screen.queryByLabelText("Launch Control in Steam")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Open Control on the Steam store")).not.toBeInTheDocument();
  });

  it("links a game owned on both stores, since the appid is what matters", () => {
    render(<GameCard game={makeGame({ store: "both" })} />);
    expect(screen.getByLabelText("Launch Hades in Steam")).toBeInTheDocument();
  });

  it("shortlists a game and flips the button without a reload", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(<GameCard game={makeGame()} onChanged={onChanged} />);

    const button = screen.getByRole("button", { name: "Add Hades to the shortlist" });
    expect(button).toHaveAttribute("aria-pressed", "false");

    await user.click(button);
    expect(addToQueue).toHaveBeenCalledWith(1);
    expect(onChanged).toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: "Remove Hades from the shortlist" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("takes a game back off the shortlist", async () => {
    const user = userEvent.setup();
    render(<GameCard game={makeGame({ queue_position: 2 })} />);

    await user.click(screen.getByRole("button", { name: "Remove Hades from the shortlist" }));
    expect(removeFromQueue).toHaveBeenCalledWith(1);
    expect(
      await screen.findByRole("button", { name: "Add Hades to the shortlist" }),
    ).toBeInTheDocument();
  });

  it("keeps the old state and shows the error when shortlisting fails", async () => {
    const user = userEvent.setup();
    addToQueue.mockRejectedValue(new Error("queue full"));
    render(<GameCard game={makeGame()} />);

    await user.click(screen.getByRole("button", { name: "Add Hades to the shortlist" }));
    expect(await screen.findByText("queue full")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Hades to the shortlist" })).toBeInTheDocument();
  });

  it("falls back to the title placeholder when the cover fails to load", () => {
    render(<GameCard game={makeGame()} />);
    fireEvent.error(screen.getByAltText("Hades cover art"));
    expect(screen.queryByAltText("Hades cover art")).not.toBeInTheDocument();
    expect(screen.getAllByText("Hades").length).toBeGreaterThan(1); // placeholder + title
  });
});
