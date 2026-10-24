import { describe, expect, it } from "vitest";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, parseListLimit } from "./query-limit";

describe("parseListLimit", () => {
  it("returns the default when the param is absent, blank, or whitespace", () => {
    expect(parseListLimit(null)).toBe(DEFAULT_LIST_LIMIT);
    expect(parseListLimit(undefined)).toBe(DEFAULT_LIST_LIMIT);
    expect(parseListLimit("")).toBe(DEFAULT_LIST_LIMIT);
    expect(parseListLimit("   ")).toBe(DEFAULT_LIST_LIMIT);
  });

  it("returns the default on non-numeric input", () => {
    expect(parseListLimit("abc")).toBe(DEFAULT_LIST_LIMIT);
  });

  it("returns the default on non-positive input", () => {
    expect(parseListLimit("0")).toBe(DEFAULT_LIST_LIMIT);
    expect(parseListLimit("-5")).toBe(DEFAULT_LIST_LIMIT);
  });

  it("caps explicit oversized values at the max", () => {
    expect(parseListLimit("999999999")).toBe(MAX_LIST_LIMIT);
    expect(parseListLimit("300")).toBe(MAX_LIST_LIMIT);
  });

  it("passes through small explicit values", () => {
    expect(parseListLimit("10")).toBe(10);
    expect(parseListLimit(DEFAULT_LIST_LIMIT.toString())).toBe(DEFAULT_LIST_LIMIT);
  });

  it("honors custom fallback and cap", () => {
    expect(parseListLimit(null, 25)).toBe(25);
    expect(parseListLimit("abc", 25)).toBe(25);
    expect(parseListLimit("500", DEFAULT_LIST_LIMIT, 100)).toBe(100);
  });
});
