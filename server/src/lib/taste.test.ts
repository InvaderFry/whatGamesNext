import { describe, expect, it } from "vitest";
import type { GameRow } from "../db.js";
import { computeTasteProfile, tasteScore, tasteHighlights } from "./taste.js";

let nextId = 1;
function game(over: Partial<GameRow> & { genres?: string[] | string }): GameRow {
  const genres = Array.isArray(over.genres) ? JSON.stringify(over.genres) : (over.genres ?? "[]");
  return {
    id: nextId++,
    title: `Game ${nextId}`,
    status: "unplayed",
    personal_rating: null,
    tags: "[]",
    ...over,
    genres,
  } as GameRow;
}

const rpg = (over: Partial<GameRow> = {}) => game({ genres: ["RPG"], ...over });
const shooter = (over: Partial<GameRow> = {}) => game({ genres: ["Shooter"], ...over });

describe("computeTasteProfile", () => {
  it("says nothing when there's no history", () => {
    const profile = computeTasteProfile([rpg(), shooter(), rpg({ status: "playing" })]);
    expect(profile.observations).toBe(0);
    // Flat, so the component adds a constant and changes no ordering.
    expect(tasteScore(rpg(), profile)).toBe(0.5);
    expect(tasteScore(shooter(), profile)).toBe(0.5);
  });

  it("moves further from the baseline as evidence accumulates", () => {
    // A mix, so the baseline is a real midpoint rather than "likes everything".
    const drops = Array.from({ length: 3 }, () => shooter({ status: "abandoned" }));
    const thin = computeTasteProfile([rpg({ status: "finished" }), ...drops]);
    const thick = computeTasteProfile([
      ...Array.from({ length: 6 }, () => rpg({ status: "finished" })),
      ...drops,
    ]);

    // One finished RPG is not "loves RPGs"; six of them is.
    expect(tasteScore(rpg(), thin)).toBeLessThan(tasteScore(rpg(), thick));
    expect(tasteScore(rpg(), thin) - thin.globalRate).toBeLessThan(0.25);
  });

  it("separates a genre you finish from one you drop", () => {
    const profile = computeTasteProfile([
      ...Array.from({ length: 5 }, () => rpg({ status: "finished" })),
      ...Array.from({ length: 5 }, () => shooter({ status: "abandoned" })),
    ]);
    expect(tasteScore(rpg(), profile)).toBeGreaterThan(0.7);
    expect(tasteScore(shooter(), profile)).toBeLessThan(0.3);
  });

  it("stays flat for someone who finishes everything", () => {
    const profile = computeTasteProfile([
      ...Array.from({ length: 5 }, () => rpg({ status: "finished" })),
      ...Array.from({ length: 5 }, () => shooter({ status: "finished" })),
    ]);
    // Both are liked, but neither stands out from this person's own baseline,
    // so nothing gets reordered relative to anything else.
    expect(Math.abs(tasteScore(rpg(), profile) - tasteScore(shooter(), profile))).toBeLessThan(
      0.01,
    );
    expect(profile.globalRate).toBe(1);
  });

  it("lets a rating overrule the status it sits on", () => {
    const liked = computeTasteProfile([
      ...Array.from({ length: 4 }, () => rpg({ status: "abandoned", personal_rating: 9 })),
    ]);
    // Abandoned, but rated 9 — dropping a game you loved isn't a complaint.
    expect(tasteScore(rpg(), liked)).toBeGreaterThan(0.6);

    const disliked = computeTasteProfile([
      ...Array.from({ length: 4 }, () => rpg({ status: "finished", personal_rating: 2 })),
    ]);
    // Finished, but rated 2 — you saw it through and still didn't like it.
    expect(tasteScore(rpg(), disliked)).toBeLessThan(0.4);
  });

  it("treats a middling rating as no opinion", () => {
    const profile = computeTasteProfile([rpg({ personal_rating: 5 }), rpg({ personal_rating: 6 })]);
    expect(Math.abs(tasteScore(rpg(), profile) - profile.globalRate)).toBeLessThan(0.1);
  });

  it("grades ratings rather than treating them all as approval", () => {
    const profile = computeTasteProfile([
      game({ genres: ["RPG"], personal_rating: 10 }),
      game({ genres: ["Puzzle"], personal_rating: 7 }),
      game({ genres: ["Racing"], status: "abandoned" }),
    ]);
    // A 10 is a louder yes than a 7. A bare "finished" is worth a full point,
    // which puts it above a lukewarm 7 — seeing a game through says more than
    // shrugging at it.
    expect(profile.affinity.rpg).toBeGreaterThan(profile.affinity.puzzle);
    expect(profile.affinity.puzzle).toBeGreaterThan(profile.affinity.racing);
  });

  it("counts tags as well as genres, without double-counting a repeat", () => {
    const profile = computeTasteProfile([
      game({ genres: ["RPG"], tags: JSON.stringify(["Story Rich"]), status: "finished" }),
      game({ genres: ["RPG"], tags: JSON.stringify(["rpg"]), status: "finished" }),
    ]);
    expect(profile.affinity["story rich"]).toBeGreaterThan(0.5);
    // The second game lists "rpg" twice; it should count once.
    expect(profile.evidence.rpg).toBe(2);
  });

  it("falls back to the baseline for a game with nothing in common", () => {
    const profile = computeTasteProfile([rpg({ status: "finished" })]);
    expect(tasteScore(game({ genres: ["Racing"] }), profile)).toBe(profile.globalRate);
  });

  it("survives unparseable genre JSON", () => {
    const profile = computeTasteProfile([game({ genres: "{oops", status: "finished" })]);
    expect(profile.observations).toBe(1);
    expect(tasteScore(rpg(), profile)).toBe(profile.globalRate);
  });
});

describe("tasteHighlights", () => {
  it("splits either side of your own baseline and ignores thin evidence", () => {
    const profile = computeTasteProfile([
      ...Array.from({ length: 4 }, () => rpg({ status: "finished" })),
      ...Array.from({ length: 4 }, () => shooter({ status: "abandoned" })),
      game({ genres: ["Racing"], status: "finished" }), // one game only
    ]);
    const { liked, disliked } = tasteHighlights(profile);

    expect(liked.map((r) => r.key)).toContain("rpg");
    expect(disliked.map((r) => r.key)).toContain("shooter");
    // One game isn't a finding.
    expect([...liked, ...disliked].map((r) => r.key)).not.toContain("racing");
  });

  it("returns nothing when there's no history", () => {
    expect(tasteHighlights(computeTasteProfile([]))).toEqual({ liked: [], disliked: [] });
  });
});
