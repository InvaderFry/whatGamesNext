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

  it("stays within 1-5", () => {
    const max = deriveDifficulty(["Platformer", "Fighting"], ["Souls-like", "Difficult", "Perma Death", "Bullet Hell"]);
    expect(max).toBe(5);
    const min = deriveDifficulty(["Casual"], ["Casual", "Relaxing", "Cozy", "Visual Novel"]);
    expect(min).toBe(1);
  });
});
