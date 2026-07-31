import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { setDbForTests, getDb } from "../db.js";
import { listQueue, addToQueue, removeFromQueue, moveInQueue } from "./queue.js";

function seed(titles: string[]) {
  const insert = getDb().prepare(
    "INSERT INTO games (title, normalized_title, store) VALUES (?, ?, 'steam')",
  );
  for (const t of titles) insert.run(t, t.toLowerCase());
}

const id = (title: string) =>
  (getDb().prepare("SELECT id FROM games WHERE title = ?").get(title) as { id: number }).id;

const order = () => listQueue().map((g) => g.title);
const positions = () => listQueue().map((g) => g.queue_position);

beforeEach(() => {
  setDbForTests(new Database(":memory:"));
  seed(["A", "B", "C", "D"]);
});

describe("shortlist queue", () => {
  it("starts empty and appends in the order things are added", () => {
    expect(order()).toEqual([]);
    addToQueue(id("C"));
    addToQueue(id("A"));
    expect(order()).toEqual(["C", "A"]);
    expect(positions()).toEqual([1, 2]);
  });

  it("ignores a game that is already on the list", () => {
    expect(addToQueue(id("A"))).toBe(true);
    expect(addToQueue(id("A"))).toBe(false);
    expect(order()).toEqual(["A"]);
  });

  it("refuses a game that doesn't exist", () => {
    expect(addToQueue(9999)).toBe(false);
    expect(order()).toEqual([]);
  });

  it("closes the gap when something is removed", () => {
    for (const t of ["A", "B", "C"]) addToQueue(id(t));
    expect(removeFromQueue(id("B"))).toBe(true);

    expect(order()).toEqual(["A", "C"]);
    // Contiguous, so the next add lands at 3 rather than colliding.
    expect(positions()).toEqual([1, 2]);
    addToQueue(id("D"));
    expect(positions()).toEqual([1, 2, 3]);
  });

  it("reports removing something that was never on the list", () => {
    expect(removeFromQueue(id("A"))).toBe(false);
  });

  it("swaps with the neighbour when moved", () => {
    for (const t of ["A", "B", "C"]) addToQueue(id(t));

    expect(moveInQueue(id("C"), "up")).toBe(true);
    expect(order()).toEqual(["A", "C", "B"]);

    expect(moveInQueue(id("A"), "down")).toBe(true);
    expect(order()).toEqual(["C", "A", "B"]);
    expect(positions()).toEqual([1, 2, 3]);
  });

  it("does nothing at the ends", () => {
    for (const t of ["A", "B"]) addToQueue(id(t));

    expect(moveInQueue(id("A"), "up")).toBe(false);
    expect(moveInQueue(id("B"), "down")).toBe(false);
    expect(order()).toEqual(["A", "B"]);
  });

  it("won't move a game that isn't on the list", () => {
    addToQueue(id("A"));
    expect(moveInQueue(id("D"), "up")).toBe(false);
  });
});
