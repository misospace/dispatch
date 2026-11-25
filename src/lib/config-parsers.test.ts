import { describe, expect, it } from "vitest";

import { hasControlChars } from "./config-parsers";

// Single source of truth for the single-line wire-field rule enforced by
// `parseContributionInput` (server) and mirrored by the #1539 operator form.
describe("hasControlChars", () => {
  it("accepts ordinary printable text, spaces, and non-ASCII words", () => {
    expect(hasControlChars("contribution")).toBe(false);
    expect(hasControlChars("team alpha/rebase — v2 ✓")).toBe(false);
  });

  it("rejects C0 controls and DEL anywhere in the string", () => {
    expect(hasControlChars("contrib\tution")).toBe(true);
    expect(hasControlChars("contrib\nution")).toBe(true);
    expect(hasControlChars("contrib\rution")).toBe(true);
    expect(hasControlChars("contrib\u0000ution")).toBe(true);
    expect(hasControlChars("contrib\u007fution")).toBe(true);
    expect(hasControlChars("\nleading")).toBe(true);
  });

  it("accepts the empty string", () => {
    expect(hasControlChars("")).toBe(false);
  });
});
