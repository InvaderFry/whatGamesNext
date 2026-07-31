import { Router } from "express";
import { type GameRow } from "../db.js";
import { listQueue, addToQueue, removeFromQueue, moveInQueue } from "../lib/queue.js";
import { effectiveRating } from "../lib/score.js";

export const queueRouter = Router();

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

const respond = (res: Parameters<Parameters<typeof queueRouter.get>[1]>[1]) =>
  res.json({ games: listQueue().map(toApi) });

queueRouter.get("/queue", (_req, res) => respond(res));

queueRouter.post("/queue/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id must be an integer" });
  if (!addToQueue(id))
    return res.status(404).json({ error: "no such game, or already shortlisted" });
  return respond(res);
});

queueRouter.delete("/queue/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id must be an integer" });
  if (!removeFromQueue(id)) return res.status(404).json({ error: "not on the shortlist" });
  return respond(res);
});

queueRouter.post("/queue/:id/move", (req, res) => {
  const id = Number(req.params.id);
  const direction = (req.body as { direction?: string }).direction;
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id must be an integer" });
  if (direction !== "up" && direction !== "down") {
    return res.status(400).json({ error: "direction must be 'up' or 'down'" });
  }
  // Moving off either end is a no-op rather than an error — the buttons are
  // disabled at the ends, so this only happens on a stale click.
  moveInQueue(id, direction);
  return respond(res);
});
