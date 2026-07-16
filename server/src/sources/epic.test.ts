import { describe, it, expect } from "vitest";
import { parseLegendaryList, parseManualTitles } from "./epic.js";

describe("parseLegendaryList", () => {
  it("extracts app names and titles", () => {
    const json = JSON.stringify([
      { app_name: "Sugar", app_title: "Alan Wake 2" },
      { app_name: "Calluna", metadata: { title: "Control" } },
      { app_name: "NoTitle" },
    ]);
    expect(parseLegendaryList(json)).toEqual([
      { appName: "Sugar", title: "Alan Wake 2" },
      { appName: "Calluna", title: "Control" },
    ]);
  });
});

describe("parseManualTitles", () => {
  it("splits lines, trims bullets and blanks", () => {
    const text = "Alan Wake 2\n- Control\n• Outer Wilds\n\n  A Short Hike  \n";
    expect(parseManualTitles(text)).toEqual(["Alan Wake 2", "Control", "Outer Wilds", "A Short Hike"]);
  });
});
