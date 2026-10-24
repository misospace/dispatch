import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_LIMIT,
  MAX_ISSUE_NUMBER,
  MAX_LIST_LIMIT,
  parseIssueNumber,
  parseListLimit,
} from "./query-limit";

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

  it("returns the default on partially numeric input", () => {
    expect(parseListLimit("42abc")).toBe(DEFAULT_LIST_LIMIT);
    expect(parseListLimit("42.5")).toBe(DEFAULT_LIST_LIMIT);
  });

  it("caps an out-of-range value instead of falling back to the default", () => {
    expect(parseListLimit("999999999999999999999")).toBe(MAX_LIST_LIMIT);
  });

  it("accepts a leading sign", () => {
    expect(parseListLimit("+5")).toBe(5);
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

describe("parseIssueNumber", () => {
  it("returns undefined when the param is absent, blank, or whitespace", () => {
    expect(parseIssueNumber(null)).toBeUndefined();
    expect(parseIssueNumber(undefined)).toBeUndefined();
    expect(parseIssueNumber("")).toBeUndefined();
    expect(parseIssueNumber("   ")).toBeUndefined();
  });

  it("returns undefined on non-numeric input", () => {
    expect(parseIssueNumber("abc")).toBeUndefined();
  });

  it("returns undefined on partially numeric input instead of selecting a wrong issue", () => {
    expect(parseIssueNumber("42abc")).toBeUndefined();
    expect(parseIssueNumber("42.5")).toBeUndefined();
    expect(parseIssueNumber("0x1f")).toBeUndefined();
    expect(parseIssueNumber("42 ")).toBe(42);
  });

  it("accepts a leading sign", () => {
    expect(parseIssueNumber("+42")).toBe(42);
  });

  it("returns undefined on out-of-range input that would overflow a Prisma Int", () => {
    expect(parseIssueNumber("999999999999999999999")).toBeUndefined();
    expect(parseIssueNumber("-5")).toBeUndefined();
  });

  it("passes through integers within range unclamped", () => {
    expect(parseIssueNumber("42")).toBe(42);
    expect(parseIssueNumber("10")).toBe(10);
    expect(parseIssueNumber(MAX_ISSUE_NUMBER.toString())).toBe(MAX_ISSUE_NUMBER);
  });
});
