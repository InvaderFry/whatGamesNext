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
}

export interface Recommendation {
  score: number;
  reason: string;
  game: Game;
}

export interface SyncStatus {
  library: {
    total: number;
    steam: number;
    epic: number;
    other: number;
    enriched: number;
    enrich_failed: number;
  };
  enrichment: {
    running: boolean;
    total: number;
    done: number;
    failed: number;
    current: string | null;
    lastError: string | null;
    hltbUnavailable: boolean;
  };
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
  backlog: { games: number; knownHours: number; unknownLength: number };
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
    patch: Partial<{ status: string; hidden: boolean; difficulty_override: number | null }>,
  ) =>
    request<Game>(`/api/games/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  recommend: (params: URLSearchParams) =>
    request<{ mode: string; count: number; results: Recommendation[] }>(`/api/recommend?${params}`),
  syncStatus: () => request<SyncStatus>("/api/sync/status"),
  syncSteam: () =>
    request<{ fetched: number; added: number; updated: number }>("/api/sync/steam", {
      method: "POST",
    }),
  syncEpic: () =>
    request<{ fetched: number; added: number; updated: number }>("/api/sync/epic", {
      method: "POST",
    }),
  syncImport: (store: string, text: string) =>
    request<{ fetched: number; added: number; updated: number }>("/api/sync/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store, text }),
    }),
  syncEpicManual: (titles: string) =>
    request<{ fetched: number; added: number; updated: number }>("/api/sync/epic/manual", {
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
