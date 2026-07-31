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

  // Backlog hours previously counted only games with a known length, quietly
  // understating a backlog whose unsized half might be the bigger part of it.
  // The median of what we do know is a fairer stand-in than the mean, which a
  // couple of 200-hour RPGs would drag upward.
  const knownLengths = (
    db
      .prepare(
        `SELECT hltb_main FROM games
         WHERE hidden = 0 AND status = 'unplayed' AND hltb_main IS NOT NULL
         ORDER BY hltb_main`,
      )
      .all() as { hltb_main: number }[]
  ).map((r) => r.hltb_main);
  const medianLength = knownLengths.length
    ? knownLengths[Math.floor(knownLengths.length / 2)]
    : null;
  const estimatedHours =
    medianLength != null
      ? Math.round((backlog.known_hours ?? 0) + backlog.unknown_length * medianLength)
      : null;

  // Playtime by genre. Genres are a JSON array, so a game with three of them
  // contributes its full playtime to each — these are overlapping buckets, not
  // a partition, and the UI says so.
  const byGenre = db
    .prepare(
      `SELECT json_each.value AS genre,
              COUNT(*) AS games,
              SUM(games.playtime_minutes) AS minutes
       FROM games, json_each(games.genres)
       WHERE games.hidden = 0
       GROUP BY genre
       HAVING minutes > 0
       ORDER BY minutes DESC
       LIMIT 8`,
    )
    .all() as { genre: string; games: number; minutes: number }[];

  const thisYear = String(new Date().getFullYear());
  const lastYear = String(new Date().getFullYear() - 1);
  const finishedThisYear = finishedByYear.find((r) => r.year === thisYear)?.n ?? 0;
  const finishedLastYear = finishedByYear.find((r) => r.year === lastYear)?.n ?? 0;

  const rated = db
    .prepare(
      `SELECT COUNT(*) AS n, AVG(personal_rating) AS avg
       FROM games WHERE personal_rating IS NOT NULL`,
    )
    .get() as { n: number; avg: number | null };
  const topRated = db
    .prepare(
      `SELECT id, title, personal_rating FROM games
       WHERE personal_rating IS NOT NULL
       ORDER BY personal_rating DESC, title LIMIT 5`,
    )
    .all() as { id: number; title: string; personal_rating: number }[];

  res.json({
    statusCounts,
    finishedByYear,
    untrackedFinishes,
    finishedThisYear,
    finishedLastYear,
    backlog: {
      games: backlog.games,
      knownHours: Math.round(backlog.known_hours ?? 0),
      unknownLength: backlog.unknown_length,
      estimatedHours,
      medianLength,
    },
    genres: byGenre.map((g) => ({
      genre: g.genre,
      games: g.games,
      hours: Math.round(g.minutes / 6) / 10,
    })),
    personal: {
      rated: rated.n,
      average: rated.avg != null ? Math.round(rated.avg * 10) / 10 : null,
      top: topRated,
    },
    totalPlaytimeHours: Math.round(playtime / 6) / 10,
    abandonmentRate: decided > 0 ? Math.round((statusCounts.abandoned / decided) * 100) : null,
    recentFinishes,
  });
});
