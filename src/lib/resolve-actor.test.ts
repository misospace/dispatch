import { describe, expect, it } from "vitest";

import { resolveActor } from "./resolve-actor";

describe("resolveActor", () => {
  describe("default fallback", () => {
    it("returns 'agent' when body is null", () => {
      expect(resolveActor(null)).toEqual({ actor: "agent" });
    });

    it("returns 'agent' when body is undefined", () => {
      expect(resolveActor(undefined)).toEqual({ actor: "agent" });
    });

    it("returns 'agent' when body is a primitive (string)", () => {
      expect(resolveActor("hello")).toEqual({ actor: "agent" });
    });

    it("returns 'agent' when body is a primitive (number)", () => {
      expect(resolveActor(42)).toEqual({ actor: "agent" });
    });

    it("returns 'agent' when body is an empty object", () => {
      expect(resolveActor({})).toEqual({ actor: "agent" });
    });

    it("returns 'agent' when body is an empty array", () => {
      expect(resolveActor([])).toEqual({ actor: "agent" });
    });
  });

  describe("field selection", () => {
    it("uses 'actor' when present", () => {
      expect(resolveActor({ actor: "saffron" })).toEqual({ actor: "saffron" });
    });

    it("uses 'agentName' as a fallback when 'actor' is missing", () => {
      expect(resolveActor({ agentName: "bot-7" })).toEqual({ actor: "bot-7" });
    });

    it("prefers 'actor' over 'agentName' when both are present", () => {
      expect(resolveActor({ actor: "primary", agentName: "secondary" })).toEqual({
        actor: "primary",
      });
    });

    it("ignores other unrelated fields", () => {
      expect(resolveActor({ foo: "bar", baz: 1, actor: "real" })).toEqual({
        actor: "real",
      });
    });

    it("returns an error when 'actor' is explicitly undefined and 'agentName' is also missing", () => {
      const result = resolveActor({ actor: undefined });
      expect(result.actor).toBe("");
      expect(result.error).toMatch(/must be a string/);
    });

    it("returns an error when 'actor' is explicitly null and 'agentName' is also missing", () => {
      const result = resolveActor({ actor: null });
      expect(result.actor).toBe("");
      expect(result.error).toMatch(/must be a string/);
    });
  });

  describe("trimming", () => {
    it("trims surrounding whitespace", () => {
      expect(resolveActor({ actor: "  saffron  " })).toEqual({ actor: "saffron" });
    });

    it("trims when value comes from 'agentName'", () => {
      expect(resolveActor({ agentName: "\tbot-7\n" })).toEqual({ actor: "bot-7" });
    });
  });

  describe("type validation", () => {
    it("returns an error when 'actor' is a number", () => {
      const result = resolveActor({ actor: 123 });
      expect(result.actor).toBe("");
      expect(result.error).toMatch(/must be a string/);
    });

    it("returns an error when 'actor' is an object", () => {
      const result = resolveActor({ actor: { name: "x" } });
      expect(result.actor).toBe("");
      expect(result.error).toMatch(/must be a string/);
    });

    it("returns an error when 'agentName' is an array", () => {
      const result = resolveActor({ agentName: ["saffron"] });
      expect(result.actor).toBe("");
      expect(result.error).toMatch(/must be a string/);
    });

    it("returns an error when 'actor' is a boolean", () => {
      const result = resolveActor({ actor: true });
      expect(result.actor).toBe("");
      expect(result.error).toMatch(/must be a string/);
    });
  });

  describe("empty after trim", () => {
    it("returns an error for whitespace-only 'actor'", () => {
      const result = resolveActor({ actor: "   " });
      expect(result.actor).toBe("");
      expect(result.error).toMatch(/empty/);
    });

    it("returns an error for whitespace-only 'agentName'", () => {
      const result = resolveActor({ agentName: "\t\n" });
      expect(result.actor).toBe("");
      expect(result.error).toMatch(/empty/);
    });

    it("returns an error for an empty-string 'actor'", () => {
      const result = resolveActor({ actor: "" });
      expect(result.actor).toBe("");
      expect(result.error).toMatch(/empty/);
    });
  });

  describe("length validation", () => {
    it("returns an error when 'actor' exceeds 100 characters", () => {
      const tooLong = "a".repeat(101);
      const result = resolveActor({ actor: tooLong });
      expect(result.actor).toBe("");
      expect(result.error).toMatch(/at most 100/);
    });

    it("accepts 'actor' of exactly 100 characters", () => {
      const exact = "a".repeat(100);
      expect(resolveActor({ actor: exact })).toEqual({ actor: exact });
    });

    it("does not count leading/trailing whitespace against the 100-char limit", () => {
      // 100 chars after trim, but the raw string is 104 chars
      const padded = "  " + "a".repeat(100) + "  ";
      expect(resolveActor({ actor: padded })).toEqual({ actor: "a".repeat(100) });
    });

    it("returns an error when 'agentName' exceeds 100 characters", () => {
      const tooLong = "b".repeat(101);
      const result = resolveActor({ agentName: tooLong });
      expect(result.actor).toBe("");
      expect(result.error).toMatch(/at most 100/);
    });
  });
});