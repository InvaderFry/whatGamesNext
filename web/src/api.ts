export interface Game {
  id: number;
  title: string;
  store: "steam" | "epic" | "both" | "gog" | "itch" | "other";
  steam_appid: number | null;
  playtime_minutes: number;
  metacritic: number | null;
  rawg_rating: number | null;
  steam_review_pct: number | null;
  steam_review_count: number | null;
  hltb_main: number | null;
  hltb_extra: number | null;
  hltb_completionist: number | null;
  difficulty: number | null;
  difficulty_override: number | null;
  effective_rating: number | null;
  effective_difficulty: number | null;
  genres: string[];
  tags: string[];
  release_date: string | null;
  cover_url: string | null;
  status: "unplayed" | "playing" | "finished" | "abandoned";
  hidden: boolean;
  enrich_status: "pending" | "done" | "failed";
  /** 1-based position on the shortlist, or null when not shortlisted. */
  queue_position: number | null;
  /** Your own 1–10 score, which outranks critic ratings where it's set. */
  personal_rating: number | null;
  notes: string | null;
}

export const STORE_LABEL: Record<Game["store"], string> = {
  steam: "Steam",
  epic: "Epic",
  both: "Steam + Epic",
  gog: "GOG",
  itch: "itch.io",
  other: "Other",
};

export interface ScoreBreakdown {
  rating: number;
  unplayed: number;
  lengthFit: number;
  recency: number;
  taste: number;
}

export type Weights = ScoreBreakdown;

/** Mirrors DEFAULT_WEIGHTS in server/src/lib/score.ts, which is the source of truth. */
export const DEFAULT_WEIGHTS: Weights = {
  rating: 1,
  unplayed: 0.8,
  lengthFit: 0.6,
  recency: 0.3,
  taste: 0.7,
};

export const WEIGHT_LABELS: [keyof Weights, string][] = [
  ["rating", "Rating"],
  ["unplayed", "Untouched"],
  ["lengthFit", "Length fit"],
  ["recency", "Recency"],
  ["taste", "Your taste"],
];

export interface Recommendation {
  score: number;
  reason: string;
  breakdown: ScoreBreakdown | null;
  game: Game;
}

/** A game folded into an entry you already had, matched on its title. */
export interface MergeNote {
  title: string;
  into: string;
  store: Game["store"];
}

export interface SyncResult {
  source: string;
  fetched: number;
  added: number;
  updated: number;
  /** Games moved from 'unplayed' to 'playing' because they have real hours on them. */
  promoted: number;
  /** Cross-store merges, reported so a wrong one is visible instead of silent. */
  merged: MergeNote[];
}

export interface SyncStatus {
  library: {
    total: number;
    steam: number;
    epic: number;
    other: number;
    enriched: number;
    enrich_failed: number;
    enrich_pending: number;
  };
  enrichment: {
    running: boolean;
    total: number;
    done: number;
    failed: number;
    current: string | null;
    lastError: string | null;
    hltbUnavailable: boolean;
    etaSeconds: number | null;
  };
  lastRun: { finishedAt: string; total: number; done: number; failed: number } | null;
  /** Set when a previous run died mid-flight — the server restarted while enriching. */
  interrupted: { startedAt: string; total: number } | null;
  config: {
    steamConfigured: boolean;
    rawgConfigured: boolean;
    demo: boolean;
  };
}

export interface Facets {
  genres: string[];
  tags: string[];
}

export interface Stats {
  statusCounts: Record<"unplayed" | "playing" | "finished" | "abandoned", number>;
  finishedByYear: { year: string; n: number }[];
  untrackedFinishes: number;
  finishedThisYear: number;
  finishedLastYear: number;
  backlog: {
    games: number;
    knownHours: number;
    unknownLength: number;
    /** Known hours plus unsized games costed at the median known length. */
    estimatedHours: number | null;
    medianLength: number | null;
  };
  genres: { genre: string; games: number; hours: number }[];
  personal: {
    rated: number;
    average: number | null;
    top: { id: number; title: string; personal_rating: number }[];
  };
  taste: {
    /** Games that said anything at all — rated, finished or abandoned. */
    observations: number;
    /** Share of your verdicts that were positive, as a percentage. */
    baseline: number;
    liked: { key: string; affinity: number; evidence: number }[];
    disliked: { key: string; affinity: number; evidence: number }[];
  };
  totalPlaytimeHours: number;
  abandonmentRate: number | null;
  recentFinishes: { id: number; title: string; finished_at: string }[];
}

export interface SettingInfo {
  configured: boolean;
  source: "settings" | "env" | null;
  preview: string | null;
}

export type SettingsMap = Record<"steam_api_key" | "steam_id" | "rawg_api_key", SettingInfo>;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

export const api = {
  games: (params: URLSearchParams) =>
    request<{ count: number; games: Game[] }>(`/api/games?${params}`),
  facets: () => request<Facets>("/api/games/facets"),
  patchGame: (
    id: number,
    patch: Partial<{
      status: string;
      hidden: boolean;
      difficulty_override: number | null;
      personal_rating: number | null;
      notes: string | null;
    }>,
  ) =>
    request<Game>(`/api/games/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  queue: () => request<{ games: Game[] }>("/api/queue"),
  addToQueue: (id: number) => request<{ games: Game[] }>(`/api/queue/${id}`, { method: "POST" }),
  removeFromQueue: (id: number) =>
    request<{ games: Game[] }>(`/api/queue/${id}`, { method: "DELETE" }),
  moveInQueue: (id: number, direction: "up" | "down") =>
    request<{ games: Game[] }>(`/api/queue/${id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction }),
    }),
  recommend: (params: URLSearchParams) =>
    request<{ mode: string; count: number; total: number; results: Recommendation[] }>(
      `/api/recommend?${params}`,
    ),
  syncStatus: () => request<SyncStatus>("/api/sync/status"),
  syncSteam: () => request<SyncResult>("/api/sync/steam", { method: "POST" }),
  syncEpic: () => request<SyncResult>("/api/sync/epic", { method: "POST" }),
  syncImport: (store: string, text: string) =>
    request<SyncResult>("/api/sync/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store, text }),
    }),
  syncEpicManual: (titles: string) =>
    request<SyncResult>("/api/sync/epic/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titles }),
    }),
  stats: () => request<Stats>("/api/stats"),
  settings: () => request<SettingsMap>("/api/settings"),
  saveSettings: (patch: Partial<Record<keyof SettingsMap, string | null>>) =>
    request<SettingsMap>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  startEnrich: () => request<{ started: boolean }>("/api/sync/enrich", { method: "POST" }),
  retryFailedEnrich: () =>
    request<{ requeued: number }>("/api/sync/enrich/retry-failed", { method: "POST" }),
  refreshEnrich: () =>
    request<{ requeued: number }>("/api/sync/enrich/refresh", { method: "POST" }),
};

export function formatPlaytime(minutes: number): string {
  if (minutes === 0) return "never played";
  if (minutes < 60) return `${minutes}m played`;
  return `${Math.round(minutes / 6) / 10}h played`;
}

export function difficultyLabel(d: number | null): string {
  if (d == null) return "?";
  return ["", "Relaxing", "Easy", "Moderate", "Hard", "Punishing"][d] ?? "?";
}
