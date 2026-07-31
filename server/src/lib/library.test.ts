import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { setDbForTests, getDb, type GameRow } from "../db.js";
import { upsertSteamGames, upsertEpicGames, upsertImportedGames } from "./library.js";

beforeEach(() => {
  setDbForTests(new Database(":memory:"));
});

function rows(): GameRow[] {
  return getDb().prepare("SELECT * FROM games ORDER BY id").all() as GameRow[];
}

const steam = (appid: number, name: string, playtime = 0) => ({
  appid,
  name,
  playtime_forever: playtime,
});

describe("upsertSteamGames", () => {
  it("keeps two same-titled Steam games apart when their appids differ", () => {
    // The 1993 original and the 2016 reboot both normalize to "doom". Under the
    // old unique-title key the second one overwrote the first.
    upsertSteamGames([steam(2280, "DOOM"), steam(379720, "DOOM")]);

    const all = rows();
    expect(all).toHaveLength(2);
    expect(all.map((g) => g.steam_appid)).toEqual([2280, 379720]);
  });

  it("updates in place when the same appid is synced again", () => {
    upsertSteamGames([steam(1145360, "Hades", 90)]);
    const result = upsertSteamGames([steam(1145360, "Hades", 240)]);

    expect(result).toMatchObject({ added: 0, updated: 1 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].playtime_minutes).toBe(240);
  });

  it("follows the appid when Steam renames a game", () => {
    upsertSteamGames([steam(1145360, "Hades")]);
    upsertSteamGames([steam(1145360, "Hades: Definitive Edition", 30)]);

    // One row, not two: the id says it is the same game whatever it is called.
    expect(rows()).toHaveLength(1);
    expect(rows()[0].playtime_minutes).toBe(30);
  });

  it("still merges onto an Epic row with the same title, and says so", () => {
    upsertEpicGames([{ appName: "control-epic", title: "Control" }]);
    const result = upsertSteamGames([steam(870780, "Control", 60)]);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ store: "both", steam_appid: 870780, playtime_minutes: 60 });
    expect(result.merged).toEqual([{ title: "Control", into: "Control", store: "epic" }]);
  });

  it("reports nothing when a plain re-sync changes no stores", () => {
    upsertSteamGames([steam(620, "Portal 2")]);
    expect(upsertSteamGames([steam(620, "Portal 2")]).merged).toEqual([]);
  });
});

describe("upsertEpicGames", () => {
  it("keeps two same-titled Epic games apart when their app names differ", () => {
    upsertEpicGames([
      { appName: "prey-2006", title: "Prey" },
      { appName: "prey-2017", title: "Prey" },
    ]);

    expect(rows()).toHaveLength(2);
    expect(rows().map((g) => g.epic_app_name)).toEqual(["prey-2006", "prey-2017"]);
  });

  it("merges onto an existing Steam row rather than duplicating it", () => {
    upsertSteamGames([steam(1145360, "Hades")]);
    const result = upsertEpicGames([{ appName: "hades-epic", title: "Hades" }]);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ store: "both", epic_app_name: "hades-epic" });
    expect(result.merged).toEqual([{ title: "Hades", into: "Hades", store: "steam" }]);
  });

  it("matches pasted titles, which carry no app name, on the title alone", () => {
    upsertEpicGames([{ appName: "", title: "Alan Wake 2" }]);
    upsertEpicGames([{ appName: "", title: "Alan Wake 2" }]);

    expect(rows()).toHaveLength(1);
  });
});

describe("upsertImportedGames", () => {
  it("attaches to a game already in the library instead of duplicating it", () => {
    upsertSteamGames([steam(292030, "The Witcher 3: Wild Hunt")]);
    const result = upsertImportedGames([{ title: "The Witcher 3 Wild Hunt" }], "gog");

    expect(rows()).toHaveLength(1);
    // The row stays on Steam: it has an appid to launch with, and GOG has no id
    // to offer in exchange.
    expect(rows()[0].store).toBe("steam");
    expect(result.merged).toEqual([
      { title: "The Witcher 3 Wild Hunt", into: "The Witcher 3: Wild Hunt", store: "steam" },
    ]);
  });

  it("adds a title nothing else in the library matches", () => {
    const result = upsertImportedGames([{ title: "Disco Elysium", playtimeMinutes: 600 }], "gog");

    expect(result).toMatchObject({ added: 1, updated: 0, merged: [] });
    expect(rows()[0]).toMatchObject({ store: "gog", playtime_minutes: 600 });
  });

  it("attaches to the oldest row when several share a title", () => {
    upsertSteamGames([steam(2280, "DOOM"), steam(379720, "DOOM")]);
    upsertImportedGames([{ title: "DOOM", playtimeMinutes: 120 }], "other");

    expect(rows()).toHaveLength(2);
    expect(rows()[0].playtime_minutes).toBe(120);
    expect(rows()[1].playtime_minutes).toBe(0);
  });
});
