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
    },
  };
});

const syncStatus = vi.mocked(api.syncStatus);
const syncSteam = vi.mocked(api.syncSteam);
const startEnrich = vi.mocked(api.startEnrich);

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
            etaSeconds: 900,
          },
        },
      ),
    );
    render(<Settings />);
    expect(await screen.findByText(/currently: Hades/)).toBeInTheDocument();
    expect(screen.getByText(/about 15 min left/)).toBeInTheDocument();
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
    });
    render(<Settings />);
    await screen.findByText(/10 games total/);

    await user.click(screen.getByRole("button", { name: "Sync Steam library" }));
    expect(
      await screen.findByText(/23 games marked as playing based on playtime/),
    ).toBeInTheDocument();
  });
});
