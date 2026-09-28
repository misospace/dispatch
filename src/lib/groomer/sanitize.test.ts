import { describe, it, expect } from "vitest";

import { MAX_STORED_TEXT_CHARS, neutralizeMentions, sanitizeForStorage, sanitizeJsonForStorage } from "./sanitize";

describe("neutralizeMentions", () => {
  it("wraps a leading @-mention in backticks", () => {
    expect(neutralizeMentions("@reviewer please look")).toBe("`@reviewer` please look");
  });

  it("wraps a mid-sentence @-mention in backticks", () => {
    expect(neutralizeMentions("hey @octocat thanks for the report")).toBe(
      "hey `@octocat` thanks for the report",
    );
  });

  it("wraps a mention after punctuation (comma, paren, colon)", () => {
    expect(neutralizeMentions("thanks, @alice for the review")).toBe(
      "thanks, `@alice` for the review",
    );
    expect(neutralizeMentions("(see @bob) for details")).toBe("(see `@bob`) for details");
    expect(neutralizeMentions("ping: @carol now")).toBe("ping: `@carol` now");
  });

  it("leaves email addresses untouched", () => {
    const input = "contact foo@bar.com for details";
    expect(neutralizeMentions(input)).toBe(input);
  });

  it("leaves mention-shaped tokens inside inline backticks untouched", () => {
    const input = "use the `@reviewer` placeholder here";
    expect(neutralizeMentions(input)).toBe(input);
  });

  it("leaves mention-shaped tokens inside fenced code blocks untouched", () => {
    const input = "example:\n```\n@reviewer should stay literal\n```\nend";
    expect(neutralizeMentions(input)).toBe(input);
  });

  it("handles hyphenated usernames", () => {
    expect(neutralizeMentions("thanks @my-collaborator for the PR")).toBe(
      "thanks `@my-collaborator` for the PR",
    );
  });

  it("handles multiple mentions in one string", () => {
    expect(neutralizeMentions("@alice and @bob should coordinate")).toBe(
      "`@alice` and `@bob` should coordinate",
    );
  });

  it("returns empty / falsy input unchanged", () => {
    expect(neutralizeMentions("")).toBe("");
  });
});

describe("sanitizeForStorage (dispatch#1126)", () => {
  it("strips NUL and other C0 control characters but keeps newlines and tabs", () => {
    expect(sanitizeForStorage("a\u0000b\u0001c\u0007d\u001Be\u001Ff\rg\nh\ti")).toBe("abcdefg\nh\ti");
  });

  it("caps the length, ellipsis included", () => {
    const capped = sanitizeForStorage(`repo:${"x".repeat(500)}`, 200);
    expect(capped).toHaveLength(200);
    expect(capped.endsWith("…")).toBe(true);
    expect(sanitizeForStorage("x".repeat(200), 200)).toBe("x".repeat(200));
    expect(sanitizeForStorage("y".repeat(MAX_STORED_TEXT_CHARS + 10))).toHaveLength(MAX_STORED_TEXT_CHARS);
  });

  it("cleans every string and key of a JSON value without touching the original", () => {
    const raw = { "k\u0000ey": ["v\u0000", 1, null, { nested: "t\u0002ext\n" }], ok: true };
    const clean = sanitizeJsonForStorage(raw);
    expect(clean).toEqual({ key: ["v", 1, null, { nested: "text\n" }], ok: true });
    expect(raw["k\u0000ey"][0]).toBe("v\u0000");
    expect(JSON.stringify(clean)).not.toContain("\\u0000");
  });
});

