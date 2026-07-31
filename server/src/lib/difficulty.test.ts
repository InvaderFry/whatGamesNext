import { describe, it, expect } from "vitest";
import { deriveDifficulty } from "./difficulty.js";

describe("deriveDifficulty", () => {
  it("rates souls-likes as very hard", () => {
    expect(deriveDifficulty(["Action", "RPG"], ["Souls-like", "Difficult"])).toBe(5);
  });

  it("rates cozy games as easy", () => {
    expect(deriveDifficulty(["Simulation", "Casual"], ["Relaxing", "Cozy"])).toBe(1);
  });

  it("rates walking simulators as easy", () => {
    expect(deriveDifficulty(["Adventure"], ["Walking Simulator", "Story Rich"])).toBe(1);
  });

  it("defaults to medium with no signals", () => {
    expect(deriveDifficulty([], [])).toBe(3);
  });

  it("lets the genre still matter when a game is piled with hard tags", () => {
    const hardTags = ["Souls-like", "Difficult", "Perma Death", "Bullet Hell"];
    // Uncapped these summed to +7, pinning anything they touched at 5.
    expect(deriveDifficulty(["Casual"], hardTags)).toBe(4);
    expect(deriveDifficulty(["Platformer"], hardTags)).toBe(5);
  });

  it("scores equally-tagged souls-likes the same, whatever their second genre", () => {
    const tags = ["Souls-like", "Difficult"];
    expect(deriveDifficulty(["Action", "Adventure"], tags)).toBe(5); // Sekiro
    expect(deriveDifficulty(["Action", "RPG"], tags)).toBe(5); // Dark Souls III
  });

  it("ignores 'action' and 'indie', which say nothing about difficulty", () => {
    // Adding a non-signal genre used to pull the score toward the middle.
    expect(deriveDifficulty(["Puzzle"], [])).toBe(deriveDifficulty(["Puzzle", "Action"], []));
    expect(deriveDifficulty(["Casual"], [])).toBe(deriveDifficulty(["Casual", "Indie"], []));
    // On their own they still land on the neutral default.
    expect(deriveDifficulty(["Action", "Indie"], [])).toBe(3);
  });

  it("stays within 1-5", () => {
    const max = deriveDifficulty(
      ["Platformer", "Fighting"],
      ["Souls-like", "Difficult", "Perma Death", "Bullet Hell"],
    );
    expect(max).toBe(5);
    const min = deriveDifficulty(["Casual"], ["Casual", "Relaxing", "Cozy", "Visual Novel"]);
    expect(min).toBe(1);
  });
});
