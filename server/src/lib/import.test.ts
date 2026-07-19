import { describe, expect, it } from "vitest";
import { parseImportText, splitCsvLine } from "./import.js";

describe("splitCsvLine", () => {
  it("splits plain fields", () => {
    expect(splitCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    expect(splitCsvLine('"Crusader Kings III, Royal Edition",10')).toEqual([
      "Crusader Kings III, Royal Edition",
      "10",
    ]);
    expect(splitCsvLine('"say ""hi""",x')).toEqual(['say "hi"', "x"]);
  });
});

describe("parseImportText", () => {
  it("parses a plain title list, tolerating bullets and blanks", () => {
    expect(parseImportText("The Witcher 3\n- Disco Elysium\n\n• Outer Wilds\n")).toEqual([
      { title: "The Witcher 3" },
      { title: "Disco Elysium" },
      { title: "Outer Wilds" },
    ]);
  });

  it("parses CSV with title and playtime_hours columns", () => {
    const rows = parseImportText("title,playtime_hours\nCyberpunk 2077,42\nStray,");
    expect(rows).toEqual([{ title: "Cyberpunk 2077", playtimeMinutes: 2520 }, { title: "Stray" }]);
  });

  it("finds the title column regardless of position and skips empty titles", () => {
    const rows = parseImportText("hours,title\n5,Celeste\n3,");
    expect(rows).toEqual([{ title: "Celeste", playtimeMinutes: 300 }]);
  });

  it("returns empty for empty input", () => {
    expect(parseImportText("  \n ")).toEqual([]);
  });
});
