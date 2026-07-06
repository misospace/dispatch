import { describe, it, expect } from "vitest";

import { neutralizeMentions } from "./sanitize";

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