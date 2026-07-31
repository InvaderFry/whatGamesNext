import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Shortlist from "./Shortlist";
import { api } from "../api";
import { makeGame } from "../test-utils";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      queue: vi.fn(),
      moveInQueue: vi.fn(),
      removeFromQueue: vi.fn(),
      patchGame: vi.fn(),
    },
  };
});

const queue = vi.mocked(api.queue);
const moveInQueue = vi.mocked(api.moveInQueue);
const removeFromQueue = vi.mocked(api.removeFromQueue);

const listed = [
  makeGame({ id: 1, title: "Hades", queue_position: 1 }),
  makeGame({ id: 2, title: "Celeste", queue_position: 2 }),
  makeGame({ id: 3, title: "Portal 2", queue_position: 3 }),
];

beforeEach(() => {
  queue.mockReset();
  moveInQueue.mockReset();
  removeFromQueue.mockReset();
  queue.mockResolvedValue({ games: listed });
});

describe("Shortlist", () => {
  it("lists the queue in order", async () => {
    render(<Shortlist />);
    await screen.findByText("Hades");
    expect(
      screen.getAllByRole("listitem").map((li) => li.querySelector(".title")?.textContent),
    ).toEqual(["Hades", "Celeste", "Portal 2"]);
  });

  it("points somewhere useful when nothing is queued", async () => {
    queue.mockResolvedValue({ games: [] });
    render(<Shortlist />);
    expect(await screen.findByText(/shortlist is empty/)).toBeInTheDocument();
  });

  it("reorders without a full reload, using the list the server returns", async () => {
    const user = userEvent.setup();
    moveInQueue.mockResolvedValue({
      games: [listed[1], listed[0], listed[2]].map((g, i) => ({ ...g, queue_position: i + 1 })),
    });
    render(<Shortlist />);
    await screen.findByText("Hades");

    await user.click(screen.getByRole("button", { name: "Move Celeste up" }));
    expect(moveInQueue).toHaveBeenCalledWith(2, "up");

    await waitFor(() =>
      expect(
        screen.getAllByRole("listitem").map((li) => li.querySelector(".title")?.textContent),
      ).toEqual(["Celeste", "Hades", "Portal 2"]),
    );
    expect(queue).toHaveBeenCalledTimes(1); // no refetch
  });

  it("disables the moves that would fall off the ends", async () => {
    render(<Shortlist />);
    await screen.findByText("Hades");

    expect(screen.getByRole("button", { name: "Move Hades up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Hades down" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move Portal 2 down" })).toBeDisabled();
  });

  it("removes an entry", async () => {
    const user = userEvent.setup();
    removeFromQueue.mockResolvedValue({ games: [listed[1], listed[2]] });
    render(<Shortlist />);
    await screen.findByText("Hades");

    await user.click(screen.getByRole("button", { name: "Remove Hades from the shortlist" }));
    expect(removeFromQueue).toHaveBeenCalledWith(1);
    await waitFor(() => expect(screen.queryByText("Hades")).not.toBeInTheDocument());
  });

  it("shows an error rather than an empty list when the fetch fails", async () => {
    queue.mockRejectedValue(new Error("api down"));
    render(<Shortlist />);
    expect(await screen.findByText("api down")).toBeInTheDocument();
  });
});
