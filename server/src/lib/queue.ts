import { getDb, type GameRow } from "../db.js";

/**
 * The shortlist: an ordered "next up" list, so a good recommendation survives a
 * page refresh instead of being re-rolled away.
 *
 * Positions are kept contiguous and 1-based. Compacting on every removal costs
 * one cheap UPDATE over a list a human curates by hand, and in exchange
 * reordering is a swap rather than fractional-index bookkeeping.
 */

export function listQueue(): GameRow[] {
  return getDb()
    .prepare("SELECT * FROM games WHERE queue_position IS NOT NULL ORDER BY queue_position")
    .all() as GameRow[];
}

/**
 * Renumber the list to 1..n, preserving order. Exported for restore, which
 * writes back whatever positions a backup carried — a list exported with a
 * game since deleted would otherwise come back with a gap in it.
 */
export function compactQueue(db = getDb()): void {
  // Ranked rather than counted: a restore can write a position another game is
  // already sitting on, and counting rows at-or-before a tie hands both of them
  // the same number. ROW_NUMBER breaks the tie on id and always lands on 1..n.
  db.exec(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY queue_position, id) AS pos
      FROM games WHERE queue_position IS NOT NULL
    )
    UPDATE games SET queue_position = (SELECT pos FROM ranked WHERE ranked.id = games.id)
    WHERE queue_position IS NOT NULL
  `);
}

/** Appends to the end. Adding a game already on the list is a no-op. */
export function addToQueue(id: number): boolean {
  const db = getDb();
  return db.transaction(() => {
    const game = db.prepare("SELECT queue_position FROM games WHERE id = ?").get(id) as
      { queue_position: number | null } | undefined;
    if (!game || game.queue_position != null) return false;
    const { max } = db
      .prepare("SELECT COALESCE(MAX(queue_position), 0) AS max FROM games")
      .get() as { max: number };
    db.prepare("UPDATE games SET queue_position = ? WHERE id = ?").run(max + 1, id);
    return true;
  })();
}

export function removeFromQueue(id: number): boolean {
  const db = getDb();
  return db.transaction(() => {
    const info = db
      .prepare("UPDATE games SET queue_position = NULL WHERE id = ? AND queue_position IS NOT NULL")
      .run(id);
    if (!info.changes) return false;
    compactQueue(db);
    return true;
  })();
}

/** Swaps a game with its neighbour. Moving off either end is a no-op. */
export function moveInQueue(id: number, direction: "up" | "down"): boolean {
  const db = getDb();
  return db.transaction(() => {
    const game = db.prepare("SELECT queue_position FROM games WHERE id = ?").get(id) as
      { queue_position: number | null } | undefined;
    if (!game?.queue_position) return false;

    const target = game.queue_position + (direction === "up" ? -1 : 1);
    const neighbour = db.prepare("SELECT id FROM games WHERE queue_position = ?").get(target) as
      { id: number } | undefined;
    if (!neighbour) return false;

    const swap = db.prepare("UPDATE games SET queue_position = ? WHERE id = ?");
    swap.run(game.queue_position, neighbour.id);
    swap.run(target, id);
    return true;
  })();
}
