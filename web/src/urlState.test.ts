import { beforeEach, describe, expect, it } from "vitest";
import { readUrl, writeUrl } from "./urlState";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("urlState", () => {
  it("reads the current query string", () => {
    window.history.replaceState(null, "", "/?status=unplayed&page=2");
    expect(readUrl().get("status")).toBe("unplayed");
    expect(readUrl().get("page")).toBe("2");
  });

  it("merges without disturbing keys it wasn't given", () => {
    window.history.replaceState(null, "", "/?view=library");
    writeUrl({ status: "playing" });
    expect(readUrl().get("view")).toBe("library");
    expect(readUrl().get("status")).toBe("playing");
  });

  it("drops keys set to null or empty", () => {
    window.history.replaceState(null, "", "/?status=playing&sort=title");
    writeUrl({ status: null, sort: "" });
    expect(readUrl().get("status")).toBeNull();
    expect(readUrl().get("sort")).toBeNull();
  });

  it("leaves no dangling question mark once everything is cleared", () => {
    writeUrl({ status: "playing" });
    expect(window.location.search).toBe("?status=playing");

    writeUrl({ status: null });
    expect(window.location.search).toBe("");
  });
});
