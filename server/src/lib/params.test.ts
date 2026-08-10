import { describe, expect, it } from "vitest";
import { boundedNumber } from "./params.js";

const bounds = { min: 1, max: 200, fallback: 25 };

describe("boundedNumber", () => {
  it("reads a number that's already in range", () => {
    expect(boundedNumber("60", bounds)).toBe(60);
  });

  it("clamps to the ceiling instead of rejecting the request", () => {
    expect(boundedNumber("99999", bounds)).toBe(200);
  });

  it("clamps to the floor, so a negative limit can't slice from the end", () => {
    expect(boundedNumber("-5", bounds)).toBe(1);
  });

  it("falls back when the param is missing", () => {
    expect(boundedNumber(undefined, bounds)).toBe(25);
  });

  it("falls back on an empty or blank string, which is how a cleared input arrives", () => {
    expect(boundedNumber("", bounds)).toBe(25);
    expect(boundedNumber("   ", bounds)).toBe(25);
  });

  it("falls back on something that isn't a number at all", () => {
    expect(boundedNumber("soon", bounds)).toBe(25);
  });

  it("falls back on infinities rather than clamping them", () => {
    expect(boundedNumber("Infinity", bounds)).toBe(25);
    expect(boundedNumber("-Infinity", bounds)).toBe(25);
  });

  it("falls back on a repeated param, which Express hands over as an array", () => {
    expect(boundedNumber(["1", "2"], bounds)).toBe(25);
  });

  it("passes a null fallback through, for params where absent is a real answer", () => {
    expect(boundedNumber(undefined, { min: 0, max: 5, fallback: null })).toBeNull();
  });
});
