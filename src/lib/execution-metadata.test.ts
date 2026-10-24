import { describe, expect, it } from "vitest";

import { parseExecutionMetadata } from "./execution-metadata";

describe("parseExecutionMetadata", () => {
  it("accepts undefined and null as an empty bag", () => {
    expect(parseExecutionMetadata(undefined)).toEqual({ ok: true, value: {} });
    expect(parseExecutionMetadata(null)).toEqual({ ok: true, value: {} });
  });

  it("accepts a valid bag and trims values", () => {
    const parsed = parseExecutionMetadata({
      worker: "  courier  ",
      model: "gpt-5.5",
      reasoningEffort: "high",
      runtimeRevision: "abc123",
      cohortLabel: "exp-42",
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        worker: "courier",
        model: "gpt-5.5",
        reasoningEffort: "high",
        runtimeRevision: "abc123",
        cohortLabel: "exp-42",
      },
    });
  });

  it("rejects an empty object", () => {
    const parsed = parseExecutionMetadata({});
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/at least one/);
  });

  it("rejects an unknown key (fail closed)", () => {
    const parsed = parseExecutionMetadata({ worker: "courier", prompt: "leak" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/prompt is not a recognized key/);
  });

  it("rejects a value over 128 characters", () => {
    const parsed = parseExecutionMetadata({ worker: "x".repeat(129) });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/at most 128/);
  });

  it("rejects a value with a newline or control character", () => {
    expect(parseExecutionMetadata({ worker: "line1\nline2" }).ok).toBe(false);
    expect(parseExecutionMetadata({ worker: "line1\tline2" }).ok).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(parseExecutionMetadata({ worker: 42 }).ok).toBe(false);
    expect(parseExecutionMetadata({ worker: null }).ok).toBe(false);
    expect(parseExecutionMetadata({ worker: ["courier"] }).ok).toBe(false);
  });

  it("rejects a non-object bag", () => {
    expect(parseExecutionMetadata("courier").ok).toBe(false);
    expect(parseExecutionMetadata(["courier"]).ok).toBe(false);
    expect(parseExecutionMetadata(42).ok).toBe(false);
  });

  it("rejects a whitespace-only value", () => {
    const parsed = parseExecutionMetadata({ worker: "   " });
    expect(parsed.ok).toBe(false);
  });
});
