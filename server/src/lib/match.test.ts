import { describe, it, expect } from "vitest";
import { normalizeTitle, titleSimilarity, bestMatch } from "./match.js";

describe("normalizeTitle", () => {
  it("lowercases and strips trademark symbols", () => {
    expect(normalizeTitle("ELDEN RING™")).toBe("elden ring");
    expect(normalizeTitle("Sid Meier's Civilization® VI")).toBe("sid meier s civilization 6");
  });

  it("converts sequel roman numerals to digits", () => {
    expect(normalizeTitle("Dark Souls III")).toBe("dark souls 3");
    expect(normalizeTitle("Final Fantasy VII")).toBe("final fantasy 7");
    expect(normalizeTitle("Mega Man X")).toBe("mega man x");
  });

  it("strips edition suffixes", () => {
    expect(normalizeTitle("The Witcher 3: Wild Hunt - Game of the Year Edition")).toBe(
      "the witcher 3 wild hunt",
    );
    expect(normalizeTitle("Control Ultimate Edition")).toBe("control");
    expect(normalizeTitle("Skyrim Special Edition")).toBe("skyrim");
  });

  it("normalizes ampersands and punctuation", () => {
    expect(normalizeTitle("Ori & the Blind Forest")).toBe("ori and the blind forest");
    expect(normalizeTitle("NieR:Automata™")).toBe("nier automata");
  });
});

describe("titleSimilarity", () => {
  it("returns 1 for equivalent titles", () => {
    expect(titleSimilarity("Hades", "HADES™")).toBe(1);
    expect(titleSimilarity("Control Ultimate Edition", "Control")).toBe(1);
  });

  it("returns high similarity for near matches", () => {
    expect(titleSimilarity("Dark Souls III", "Dark Souls 3")).toBe(1);
    expect(titleSimilarity("Divinity Original Sin 2", "Divinity: Original Sin II")).toBe(1);
  });

  it("returns low similarity for different games", () => {
    expect(titleSimilarity("Hades", "Celeste")).toBeLessThan(0.5);
  });
});

describe("bestMatch", () => {
  const candidates = [
    { name: "Half-Life 2", releaseYear: 2004 },
    { name: "Half-Life", releaseYear: 1998 },
    { name: "Half-Life: Alyx", releaseYear: 2020 },
  ];

  it("picks the exact title over prefixes", () => {
    expect(bestMatch("Half-Life 2", candidates)).toBe(0);
    expect(bestMatch("Half-Life", candidates)).toBe(1);
  });

  it("uses release year to break near-ties", () => {
    const twins = [
      { name: "Doom", releaseYear: 1993 },
      { name: "Doom", releaseYear: 2016 },
    ];
    expect(bestMatch("DOOM", twins, { releaseYear: 2016 })).toBe(1);
  });

  it("returns -1 when nothing is close enough", () => {
    expect(bestMatch("Stardew Valley", candidates)).toBe(-1);
  });
});
