import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  window.history.replaceState(null, "", "/");
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

  it("requests a single page rather than the whole library", async () => {
    render(<Library />);
    await screen.findByText("Hades");

    const params = games.mock.calls[0][0];
    expect(params.get("limit")).toBe("60");
    expect(params.get("offset")).toBe("0");
  });

  it("pages forward and back", async () => {
    const user = userEvent.setup();
    games.mockResolvedValue({ count: 120, games: [makeGame()] });
    render(<Library />);
    await screen.findByText("Hades");

    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(games.mock.calls.at(-1)![0].get("offset")).toBe("60");

    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(games.mock.calls.at(-1)![0].get("offset")).toBe("0");
  });

  it("returns to the first page when a filter changes", async () => {
    const user = userEvent.setup();
    games.mockResolvedValue({ count: 120, games: [makeGame()] });
    render(<Library />);
    await screen.findByText("Hades");

    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(games.mock.calls.at(-1)![0].get("offset")).toBe("60");

    await user.selectOptions(screen.getByLabelText("Filter by status"), "unplayed");
    const params = games.mock.calls.at(-1)![0];
    expect(params.get("status")).toBe("unplayed");
    expect(params.get("offset")).toBe("0");
  });

  it("keeps the chosen page when a pending search debounce resolves", async () => {
    games.mockResolvedValue({ count: 120, games: [makeGame()] });
    render(<Library />);
    await screen.findByText("Hades");

    // The debounce armed on mount is still pending at this point; when it
    // resolves it must not drag the user back to the first page.
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(games.mock.calls.at(-1)![0].get("offset")).toBe("60"));

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(games.mock.calls.at(-1)![0].get("offset")).toBe("60");
  });

  it("hides the pager controls when everything fits on one page", async () => {
    render(<Library />);
    expect(await screen.findByText("1 game")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  });

  it("restores filters and the page number from the URL", async () => {
    window.history.replaceState(null, "", "/?status=unplayed&genre=Action&sort=title&page=2");
    games.mockResolvedValue({ count: 120, games: [makeGame()] });
    render(<Library />);
    await screen.findByText("Hades");

    const params = games.mock.calls[0][0];
    expect(params.get("status")).toBe("unplayed");
    expect(params.get("genre")).toBe("Action");
    expect(params.get("sort")).toBe("title");
    // page=2 in the URL is the second page, so the second block of 60.
    expect(params.get("offset")).toBe("60");
    expect(screen.getByLabelText("Filter by status")).toHaveValue("unplayed");
  });

  it("writes filter changes to the URL", async () => {
    const user = userEvent.setup();
    render(<Library />);
    await screen.findByText("Hades");

    await user.selectOptions(screen.getByLabelText("Filter by status"), "playing");
    await waitFor(() => expect(window.location.search).toContain("status=playing"));
  });

  it("writes the page number one-based, and drops it on the first page", async () => {
    const user = userEvent.setup();
    games.mockResolvedValue({ count: 120, games: [makeGame()] });
    render(<Library />);
    await screen.findByText("Hades");

    await user.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(window.location.search).toBe("?page=2"));

    await user.click(screen.getByRole("button", { name: "Previous page" }));
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("leaves an untouched view with a clean URL", async () => {
    render(<Library />);
    await screen.findByText("Hades");
    expect(window.location.search).toBe("");
  });

  it("puts the applied search in the URL, not every keystroke", async () => {
    const user = userEvent.setup();
    render(<Library />);
    await screen.findByText("Hades");

    await user.type(screen.getByLabelText("Search titles"), "hade");
    expect(window.location.search).toBe("");

    await waitFor(() => expect(window.location.search).toBe("?search=hade"));
  });

  it("keeps the newest filter's games when an older request resolves last", async () => {
    const user = userEvent.setup();
    // Two deferred responses, resolved out of order: the first filter's answer
    // comes back after the second's, which is what used to win the grid.
    const deferred: ((value: { count: number; games: ReturnType<typeof makeGame>[] }) => void)[] =
      [];
    games.mockImplementation(
      () => new Promise((resolve) => deferred.push(resolve)) as ReturnType<typeof api.games>,
    );
    render(<Library />);

    await user.selectOptions(screen.getByLabelText("Filter by status"), "finished");
    await waitFor(() => expect(deferred.length).toBe(2));

    deferred[1]({ count: 1, games: [makeGame({ id: 2, title: "Celeste" })] });
    deferred[0]({ count: 1, games: [makeGame({ id: 1, title: "Hades" })] });

    expect(await screen.findByText("Celeste")).toBeInTheDocument();
    expect(screen.queryByText("Hades")).not.toBeInTheDocument();
  });

  it("aborts the request it just replaced", async () => {
    const user = userEvent.setup();
    render(<Library />);
    await screen.findByText("Hades");

    await user.selectOptions(screen.getByLabelText("Filter by status"), "finished");
    // Each call is handed a signal, and the one from the superseded call is spent.
    const [, firstSignal] = games.mock.calls[0];
    expect(firstSignal?.aborted).toBe(true);
    expect(games.mock.calls.at(-1)![1]?.aborted).toBe(false);
  });

  it("doesn't report a request it cancelled as an error", async () => {
    games.mockRejectedValue(new DOMException("The user aborted a request.", "AbortError"));
    render(<Library />);

    await waitFor(() => expect(games).toHaveBeenCalled());
    // The skeleton stays up; what must not happen is a red banner blaming the
    // server for a request the page threw away itself.
    await waitFor(() => expect(document.querySelector(".notice.error")).not.toBeInTheDocument());
  });

  it("still surfaces a real failure", async () => {
    games.mockRejectedValue(new Error("500 Internal Server Error"));
    render(<Library />);
    expect(await screen.findByText("500 Internal Server Error")).toBeInTheDocument();
  });

  it("debounces the search box into a single request", async () => {
    const user = userEvent.setup();
    render(<Library />);
    await screen.findByText("Hades");
    expect(games).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText("Search titles"), "hade");
    await waitFor(() => expect(games.mock.calls.at(-1)![0].get("search")).toBe("hade"));

    // Four keystrokes; undebounced this would be five calls in total.
    expect(games).toHaveBeenCalledTimes(2);
  });
});
