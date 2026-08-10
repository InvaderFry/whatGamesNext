import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Settings from "./Settings";
import { api, type SyncStatus } from "../api";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      syncStatus: vi.fn(),
      settings: vi.fn(),
      syncSteam: vi.fn(),
      startEnrich: vi.fn(),
      restoreBackup: vi.fn(),
    },
  };
});

const syncStatus = vi.mocked(api.syncStatus);
const syncSteam = vi.mocked(api.syncSteam);
const startEnrich = vi.mocked(api.startEnrich);
const restoreBackup = vi.mocked(api.restoreBackup);

function status(
  overrides: Partial<SyncStatus["library"]> = {},
  rest: Partial<Omit<SyncStatus, "library" | "config">> = {},
): SyncStatus {
  return {
    library: {
      total: 10,
      steam: 10,
      epic: 0,
      other: 0,
      enriched: 0,
      enrich_failed: 0,
      enrich_pending: 10,
      ...overrides,
    },
    enrichment: {
      running: false,
      total: 0,
      done: 0,
      failed: 0,
      current: null,
      lastError: null,
      hltbUnavailable: false,
      rawgUnavailable: false,
      etaSeconds: null,
      ...rest.enrichment,
    },
    lastRun: rest.lastRun ?? null,
    interrupted: rest.interrupted ?? null,
    config: { steamConfigured: true, rawgConfigured: true, demo: false },
  };
}

beforeEach(() => {
  vi.mocked(api.settings).mockReset();
  syncStatus.mockReset();
  syncSteam.mockReset();
  startEnrich.mockReset();
  restoreBackup.mockReset();
  syncStatus.mockResolvedValue(status());
  vi.mocked(api.settings).mockResolvedValue({
    steam_api_key: { configured: true, source: "settings", preview: "…1234" },
    steam_id: { configured: true, source: "settings", preview: "…5678" },
    rawg_api_key: { configured: true, source: "settings", preview: "…9012" },
  });
  syncSteam.mockResolvedValue({
    source: "steam",
    fetched: 100,
    added: 87,
    updated: 13,
    promoted: 0,
    merged: [],
  });
  startEnrich.mockResolvedValue({ started: true });
});

describe("Settings", () => {
  it("offers to enrich the games a sync just brought in", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await screen.findByText(/10 games total/);

    expect(screen.queryByRole("button", { name: /Enrich 10 games now/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sync Steam library" }));

    const offer = await screen.findByRole("button", { name: "Enrich 10 games now" });
    expect(screen.getByText(/Added 87 games/)).toBeInTheDocument();

    await user.click(offer);
    expect(startEnrich).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Enrich 10 games now/ })).not.toBeInTheDocument(),
    );
  });

  it("takes 'Later' for an answer", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await screen.findByText(/10 games total/);

    await user.click(screen.getByRole("button", { name: "Sync Steam library" }));
    await screen.findByRole("button", { name: "Enrich 10 games now" });

    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("button", { name: /Enrich 10 games now/ })).not.toBeInTheDocument();
    expect(startEnrich).not.toHaveBeenCalled();
  });

  it("stays quiet when a sync added nothing new", async () => {
    const user = userEvent.setup();
    syncSteam.mockResolvedValue({
      source: "steam",
      fetched: 100,
      added: 0,
      updated: 100,
      promoted: 0,
      merged: [],
    });
    render(<Settings />);
    await screen.findByText(/10 games total/);

    await user.click(screen.getByRole("button", { name: "Sync Steam library" }));
    await screen.findByText(/fetched 100 games, 0 new/);
    expect(screen.queryByRole("button", { name: /Enrich/ })).not.toBeInTheDocument();
  });

  it("stays quiet when there is nothing left to enrich", async () => {
    const user = userEvent.setup();
    syncStatus.mockResolvedValue(status({ enriched: 10, enrich_pending: 0 }));
    render(<Settings />);
    await screen.findByText(/10 games total/);

    await user.click(screen.getByRole("button", { name: "Sync Steam library" }));
    await screen.findByText(/87 new/);
    expect(screen.queryByRole("button", { name: /Enrich .* now/ })).not.toBeInTheDocument();
  });

  it("shows how much longer a running enrichment has to go", async () => {
    syncStatus.mockResolvedValue(
      status(
        {},
        {
          enrichment: {
            running: true,
            total: 100,
            done: 40,
            failed: 0,
            current: "Hades",
            lastError: null,
            hltbUnavailable: false,
            rawgUnavailable: false,
            etaSeconds: 900,
          },
        },
      ),
    );
    render(<Settings />);
    expect(await screen.findByText(/currently: Hades/)).toBeInTheDocument();
    expect(screen.getByText(/about 15 min left/)).toBeInTheDocument();
  });

  it("keeps polling a run that was already going when the page loaded", async () => {
    vi.useFakeTimers();
    try {
      // No click starts this one — the run began before the page did, which is
      // what a reload mid-enrichment looks like.
      syncStatus.mockResolvedValue(
        status(
          {},
          {
            enrichment: {
              running: true,
              total: 100,
              done: 40,
              failed: 0,
              current: "Hades",
              lastError: null,
              hltbUnavailable: false,
              rawgUnavailable: false,
              etaSeconds: 900,
            },
          },
        ),
      );
      render(<Settings />);
      await vi.waitFor(() => expect(syncStatus).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(2000);
      expect(syncStatus).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(syncStatus).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once the run finishes", async () => {
    vi.useFakeTimers();
    try {
      syncStatus.mockResolvedValue(
        status(
          {},
          {
            enrichment: {
              running: true,
              total: 100,
              done: 40,
              failed: 0,
              current: "Hades",
              lastError: null,
              hltbUnavailable: false,
              rawgUnavailable: false,
              etaSeconds: 900,
            },
          },
        ),
      );
      render(<Settings />);
      await vi.waitFor(() => expect(syncStatus).toHaveBeenCalledTimes(1));

      syncStatus.mockResolvedValue(status());
      await vi.advanceTimersByTimeAsync(2000);
      const settled = syncStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10000);
      expect(syncStatus).toHaveBeenCalledTimes(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns when RAWG keeps failing, so a dead key isn't mistaken for a clean run", async () => {
    syncStatus.mockResolvedValue(
      status({}, { enrichment: { rawgUnavailable: true } as SyncStatus["enrichment"] }),
    );
    render(<Settings />);
    expect(await screen.findByText(/RAWG keeps returning errors/)).toBeInTheDocument();
  });

  it("explains an interrupted run instead of just showing nothing", async () => {
    syncStatus.mockResolvedValue(
      status({}, { interrupted: { startedAt: new Date().toISOString(), total: 500 } }),
    );
    render(<Settings />);
    expect(await screen.findByText(/enrichment run was interrupted/)).toBeInTheDocument();
    expect(screen.getByText(/10 games still pending/)).toBeInTheDocument();
  });

  it("summarises the last completed run", async () => {
    syncStatus.mockResolvedValue(
      status(
        {},
        {
          lastRun: {
            finishedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            total: 50,
            done: 48,
            failed: 2,
          },
        },
      ),
    );
    render(<Settings />);
    expect(
      await screen.findByText(/48 games processed, 2 failed, finished 5 min ago/),
    ).toBeInTheDocument();
  });

  it("reports games promoted to playing in the sync message", async () => {
    const user = userEvent.setup();
    syncSteam.mockResolvedValue({
      source: "steam",
      fetched: 100,
      added: 87,
      updated: 13,
      promoted: 23,
      merged: [],
    });
    render(<Settings />);
    await screen.findByText(/10 games total/);

    await user.click(screen.getByRole("button", { name: "Sync Steam library" }));
    expect(
      await screen.findByText(/23 games marked as playing based on playtime/),
    ).toBeInTheDocument();
  });

  it("names the games a sync folded into entries you already had", async () => {
    const user = userEvent.setup();
    syncSteam.mockResolvedValue({
      source: "steam",
      fetched: 100,
      added: 0,
      updated: 100,
      promoted: 0,
      merged: [{ title: "Control", into: "Control", store: "epic" }],
    });
    render(<Settings />);
    await screen.findByText(/10 games total/);

    await user.click(screen.getByRole("button", { name: "Sync Steam library" }));
    // The count alone would say a merge happened without saying to what — the
    // whole point is being able to spot a wrong one.
    expect(await screen.findByText(/Control → Control/)).toBeInTheDocument();
    expect(screen.getByText(/Folded 1 title into entries you already had/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Control → Control/)).not.toBeInTheDocument();
  });

  it("drops the merge list when the next action starts", async () => {
    const user = userEvent.setup();
    syncSteam.mockResolvedValue({
      source: "steam",
      fetched: 100,
      added: 0,
      updated: 100,
      promoted: 0,
      merged: [{ title: "Control", into: "Control", store: "epic" }],
    });
    restoreBackup.mockResolvedValue({ restored: 1, unchanged: 0, notFound: [] });
    render(<Settings />);
    await screen.findByText(/10 games total/);

    await user.click(screen.getByRole("button", { name: "Sync Steam library" }));
    await screen.findByText(/Control → Control/);

    // Left up, the list reads as if the restore had done the merging.
    await user.upload(
      screen.getByLabelText("Restore"),
      new File(["{}"], "backup.json", { type: "application/json" }),
    );
    await screen.findByText(/Restored 1 game/);
    expect(screen.queryByText(/Control → Control/)).not.toBeInTheDocument();
  });

  it("restores a backup file and says what came back", async () => {
    const user = userEvent.setup();
    restoreBackup.mockResolvedValue({ restored: 12, unchanged: 3, notFound: [] });
    render(<Settings />);
    await screen.findByText(/10 games total/);

    const file = new File(['{"version":1,"games":[]}'], "backup.json", {
      type: "application/json",
    });
    await user.upload(screen.getByLabelText("Restore"), file);

    expect(restoreBackup).toHaveBeenCalledWith('{"version":1,"games":[]}');
    expect(await screen.findByText(/Restored 12 games/)).toBeInTheDocument();
    expect(screen.getByText(/3 already matched the backup/)).toBeInTheDocument();
  });

  it("names the games a restore couldn't place, so you know to sync first", async () => {
    const user = userEvent.setup();
    restoreBackup.mockResolvedValue({
      restored: 1,
      unchanged: 0,
      notFound: ["Hades", "Celeste"],
    });
    render(<Settings />);
    await screen.findByText(/10 games total/);

    await user.upload(
      screen.getByLabelText("Restore"),
      new File(["{}"], "backup.json", { type: "application/json" }),
    );

    expect(await screen.findByText(/Not in your library yet: Hades, Celeste/)).toBeInTheDocument();
  });

  it("surfaces a rejected backup file rather than failing quietly", async () => {
    const user = userEvent.setup();
    restoreBackup.mockRejectedValue(new Error("Hades: personal_rating must be between 1 and 10"));
    render(<Settings />);
    await screen.findByText(/10 games total/);

    await user.upload(
      screen.getByLabelText("Restore"),
      new File(["bad"], "backup.csv", { type: "text/csv" }),
    );

    expect(await screen.findByText(/personal_rating must be between 1 and 10/)).toBeInTheDocument();
  });
});
