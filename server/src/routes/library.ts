import { Router } from "express";
import { getDb, type GameRow } from "../db.js";
import { listGames, countGames, type GameFilters, type SortKey } from "../lib/library.js";
import { effectiveRating } from "../lib/score.js";

export const libraryRouter = Router();

const SORT_KEYS: SortKey[] = [
  "title",
  "rating",
  "metacritic",
  "length",
  "difficulty",
  "playtime",
  "release",
  "steam_reviews",
];

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
  const sort = SORT_KEYS.includes(q.sort as SortKey) ? (q.sort as SortKey) : "title";
  const dir =
    q.dir === "asc" ? "asc" : q.dir === "desc" ? "desc" : sort === "title" ? "asc" : "desc";
  const limit = num(q.limit);
  const offset = num(q.offset);
  const rows = listGames(filters, { sort, dir, limit, offset });
  // count is the total matching the filters, so paginated clients can page.
  const count = limit != null ? countGames(filters) : rows.length;
  res.json({ count, games: rows.map(toApi) });
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
    if (body.status !== game.status) {
      sets.push("status_changed_at = @now");
      params.now = new Date().toISOString();
      if (body.status === "finished") {
        sets.push("finished_at = @now");
      }
    }
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
