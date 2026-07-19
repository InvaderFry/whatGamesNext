import { Router } from "express";
import { getDb } from "../db.js";

export const statsRouter = Router();

statsRouter.get("/stats", (_req, res) => {
  const db = getDb();

  const byStatus = db
    .prepare("SELECT status, COUNT(*) AS n FROM games WHERE hidden = 0 GROUP BY status")
    .all() as { status: string; n: number }[];
  const statusCounts: Record<string, number> = {
    unplayed: 0,
    playing: 0,
    finished: 0,
    abandoned: 0,
  };
  for (const row of byStatus) statusCounts[row.status] = row.n;

  // Finishes grouped by year; games marked finished before timestamps existed
  // have no finished_at and are reported under `untracked`.
  const finishedByYear = db
    .prepare(
      `SELECT substr(finished_at, 1, 4) AS year, COUNT(*) AS n
       FROM games WHERE status = 'finished' AND finished_at IS NOT NULL
       GROUP BY year ORDER BY year`,
    )
    .all() as { year: string; n: number }[];
  const untrackedFinishes = (
    db
      .prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'finished' AND finished_at IS NULL")
      .get() as { n: number }
  ).n;

  const backlog = db
    .prepare(
      `SELECT COUNT(*) AS games,
        SUM(COALESCE(hltb_main, 0)) AS known_hours,
        SUM(CASE WHEN hltb_main IS NULL THEN 1 ELSE 0 END) AS unknown_length
       FROM games WHERE hidden = 0 AND status = 'unplayed'`,
    )
    .get() as { games: number; known_hours: number | null; unknown_length: number };

  const playtime =
    (db.prepare("SELECT SUM(playtime_minutes) AS m FROM games").get() as { m: number | null }).m ??
    0;

  const decided = statusCounts.finished + statusCounts.abandoned;

  const recentFinishes = db
    .prepare(
      `SELECT id, title, finished_at FROM games
       WHERE status = 'finished' AND finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT 5`,
    )
    .all() as { id: number; title: string; finished_at: string }[];

  res.json({
    statusCounts,
    finishedByYear,
    untrackedFinishes,
    backlog: {
      games: backlog.games,
      knownHours: Math.round(backlog.known_hours ?? 0),
      unknownLength: backlog.unknown_length,
    },
    totalPlaytimeHours: Math.round(playtime / 6) / 10,
    abandonmentRate: decided > 0 ? Math.round((statusCounts.abandoned / decided) * 100) : null,
    recentFinishes,
  });
});
