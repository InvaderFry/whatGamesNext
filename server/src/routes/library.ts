import { Router } from "express";
import { getDb, type GameRow } from "../db.js";
import { listGames, type GameFilters } from "../lib/library.js";
import { effectiveRating } from "../lib/score.js";

export const libraryRouter = Router();

type SortKey =
  | "title"
  | "rating"
  | "metacritic"
  | "length"
  | "difficulty"
  | "playtime"
  | "release"
  | "steam_reviews";

function sortGames(rows: GameRow[], sort: SortKey, dir: "asc" | "desc"): GameRow[] {
  const mul = dir === "asc" ? 1 : -1;
  const key = (g: GameRow): number | string | null => {
    switch (sort) {
      case "title":
        return g.title.toLowerCase();
      case "rating":
        return effectiveRating(g);
      case "metacritic":
        return g.metacritic;
      case "length":
        return g.hltb_main;
      case "difficulty":
        return g.difficulty_override ?? g.difficulty;
      case "playtime":
        return g.playtime_minutes;
      case "release":
        return g.release_date;
      case "steam_reviews":
        return g.steam_review_pct;
    }
  };
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka == null && kb == null) return 0;
    if (ka == null) return 1; // nulls always last
    if (kb == null) return -1;
    if (ka < kb) return -mul;
    if (ka > kb) return mul;
    return 0;
  });
}

function toApi(g: GameRow) {
  return {
    ...g,
    genres: JSON.parse(g.genres) as string[],
    tags: JSON.parse(g.tags) as string[],
    hidden: !!g.hidden,
    effective_rating: effectiveRating(g),
    effective_difficulty: g.difficulty_override ?? g.difficulty,
  };
}

libraryRouter.get("/games", (req, res) => {
  const q = req.query;
  const num = (v: unknown) =>
    v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined;
  const filters: GameFilters = {
    store: typeof q.store === "string" ? q.store : undefined,
    status: typeof q.status === "string" ? q.status : undefined,
    genre: typeof q.genre === "string" ? q.genre : undefined,
    tag: typeof q.tag === "string" ? q.tag : undefined,
    search: typeof q.search === "string" ? q.search : undefined,
    maxLength: num(q.maxLength),
    minLength: num(q.minLength),
    maxDifficulty: num(q.maxDifficulty),
    minRating: num(q.minRating),
    includeHidden: q.includeHidden === "1",
  };
  const sort = (typeof q.sort === "string" ? q.sort : "title") as SortKey;
  const dir =
    q.dir === "asc" ? "asc" : q.dir === "desc" ? "desc" : sort === "title" ? "asc" : "desc";
  const rows = sortGames(listGames(filters), sort, dir);
  res.json({ count: rows.length, games: rows.map(toApi) });
});

libraryRouter.get("/games/facets", (_req, res) => {
  const rows = listGames({ includeHidden: true });
  const genres = new Set<string>();
  const tags = new Map<string, number>();
  for (const r of rows) {
    for (const g of JSON.parse(r.genres) as string[]) genres.add(g);
    for (const t of JSON.parse(r.tags) as string[]) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  res.json({
    genres: [...genres].sort(),
    // Only tags common enough to be useful filters
    tags: [...tags.entries()]
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([t]) => t),
  });
});

libraryRouter.patch("/games/:id", (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const game = db.prepare("SELECT * FROM games WHERE id = ?").get(id) as GameRow | undefined;
  if (!game) return res.status(404).json({ error: "game not found" });

  const body = req.body as Partial<{
    status: string;
    hidden: boolean;
    difficulty_override: number | null;
  }>;

  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (body.status !== undefined) {
    if (!["unplayed", "playing", "finished", "abandoned"].includes(body.status)) {
      return res.status(400).json({ error: "invalid status" });
    }
    sets.push("status = @status");
    params.status = body.status;
  }
  if (body.hidden !== undefined) {
    sets.push("hidden = @hidden");
    params.hidden = body.hidden ? 1 : 0;
  }
  if (body.difficulty_override !== undefined) {
    if (
      body.difficulty_override !== null &&
      (!Number.isInteger(body.difficulty_override) ||
        body.difficulty_override < 1 ||
        body.difficulty_override > 5)
    ) {
      return res.status(400).json({ error: "difficulty_override must be 1-5 or null" });
    }
    sets.push("difficulty_override = @diff");
    params.diff = body.difficulty_override;
  }
  if (!sets.length) return res.status(400).json({ error: "nothing to update" });

  db.prepare(`UPDATE games SET ${sets.join(", ")} WHERE id = @id`).run(params);
  const updated = db.prepare("SELECT * FROM games WHERE id = ?").get(id) as GameRow;
  res.json(toApi(updated));
});
