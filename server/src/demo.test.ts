import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import request from "supertest";
import { setDbForTests, getDb } from "./db.js";
import { createApp } from "./app.js";
import { seedDemoData } from "./demo.js";

/**
 * The demo library exists so someone can clone this and see a working app with
 * no API keys — which only holds if every mode actually returns something. It's
 * curated to make that true, so a new mode or a scoring change can quietly
 * break the promise without breaking anything else.
 */

const app = createApp();

const MODES = [
  "play-next",
  "tonight",
  "quick-wins",
  "backlog-shame",
  "hidden-gems",
  "classics-missed",
  "surprise",
];

beforeEach(() => {
  setDbForTests(new Database(":memory:"));
});

describe("demo seed", () => {
  it("seeds once and then leaves an existing library alone", () => {
    expect(seedDemoData()).toBeGreaterThan(0);
    const count = () =>
      (getDb().prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number }).n;
    const seeded = count();

    expect(seedDemoData()).toBe(0);
    expect(count()).toBe(seeded);
  });

  it("gives every recommendation mode something to show", async () => {
    seedDemoData();
    for (const mode of MODES) {
      const res = await request(app).get(`/api/recommend?mode=${mode}&budget=20`);
      expect(res.status).toBe(200);
      expect(res.body.total, `${mode} returned nothing`).toBeGreaterThan(0);
    }
  });

  it("applies the same playtime inference a sync would", async () => {
    seedDemoData();
    // Several demo games carry real hours. Without this, 'Tonight' — which only
    // looks at games in progress — would be empty in the demo.
    const playing = (
      getDb().prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'playing'").get() as {
        n: number;
      }
    ).n;
    expect(playing).toBeGreaterThan(0);

    const res = await request(app).get("/api/recommend?mode=tonight");
    expect(res.body.total).toBe(playing);
  });

  it("leaves no game claiming a difficulty it can't support", async () => {
    seedDemoData();
    const rows = getDb().prepare("SELECT title, difficulty, genres, tags FROM games").all() as {
      title: string;
      difficulty: number | null;
      genres: string;
      tags: string;
    }[];

    for (const r of rows) {
      if (r.difficulty === null) continue;
      expect(r.difficulty, `${r.title} is out of range`).toBeGreaterThanOrEqual(1);
      expect(r.difficulty, `${r.title} is out of range`).toBeLessThanOrEqual(5);
    }
  });
});
