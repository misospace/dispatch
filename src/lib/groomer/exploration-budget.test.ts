import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_MODE,
  deriveFromContextTokens,
  resolveExplorationBudget,
} from "./exploration-budget";

describe("resolveExplorationBudget", () => {
  it("defaults to medium when nothing is set", () => {
    const b = resolveExplorationBudget({});
    expect(b.source).toBe(DEFAULT_CONTEXT_MODE);
    expect(b.maxTotalBytes).toBe(24_576);
    expect(b.maxFileBytes).toBe(8_192);
    expect(b.timeoutMs).toBe(150_000);
  });

  it("honours each named mode", () => {
    expect(resolveExplorationBudget({ DISPATCH_GROOMER_CONTEXT_MODE: "small" })).toMatchObject({
      source: "small",
      maxTotalBytes: 8_192,
    });
    expect(resolveExplorationBudget({ DISPATCH_GROOMER_CONTEXT_MODE: "large" })).toMatchObject({
      source: "large",
      maxTotalBytes: 98_304,
    });
  });

  it("grows monotonically across the modes", () => {
    const s = resolveExplorationBudget({ DISPATCH_GROOMER_CONTEXT_MODE: "small" });
    const m = resolveExplorationBudget({ DISPATCH_GROOMER_CONTEXT_MODE: "medium" });
    const l = resolveExplorationBudget({ DISPATCH_GROOMER_CONTEXT_MODE: "large" });
    expect(s.maxTotalBytes).toBeLessThan(m.maxTotalBytes);
    expect(m.maxTotalBytes).toBeLessThan(l.maxTotalBytes);
    expect(s.maxFileBytes).toBeLessThan(m.maxFileBytes);
    expect(m.maxFileBytes).toBeLessThan(l.maxFileBytes);
    expect(s.timeoutMs).toBeLessThanOrEqual(m.timeoutMs);
    expect(m.timeoutMs).toBeLessThanOrEqual(l.timeoutMs);
  });

  it("falls back to the default mode on an unrecognised value", () => {
    expect(resolveExplorationBudget({ DISPATCH_GROOMER_CONTEXT_MODE: "enormous" }).source).toBe(
      DEFAULT_CONTEXT_MODE,
    );
  });

  it("derives from the model's context window when given one, ignoring the mode", () => {
    const b = resolveExplorationBudget({
      DISPATCH_GROOMER_CONTEXT_MODE: "small",
      DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS: "131072",
    });
    expect(b.source).toBe("derived");
    // Well above what "small" would have allowed, and a fraction of the window.
    expect(b.maxTotalBytes).toBeGreaterThan(100_000);
    expect(b.maxTotalBytes).toBeLessThan(131_072 * 3.5);
  });

  it("derives a small budget for a small window", () => {
    const b = resolveExplorationBudget({ DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS: "8192" });
    expect(b.source).toBe("derived");
    expect(b.maxTotalBytes).toBeLessThan(24_576);
    expect(b.maxTotalBytes).toBeGreaterThanOrEqual(4_096);
  });

  it("never lets a single file exceed the whole budget", () => {
    const b = resolveExplorationBudget({
      DISPATCH_GROOMER_EXPLORE_MAX_BYTES: "10000",
      DISPATCH_GROOMER_EXPLORE_MAX_FILE_BYTES: "999999",
    });
    expect(b.maxFileBytes).toBe(10_000);
  });

  it("lets individual env vars override a mode", () => {
    const b = resolveExplorationBudget({
      DISPATCH_GROOMER_CONTEXT_MODE: "small",
      DISPATCH_GROOMER_EXPLORE_MAX_BYTES: "50000",
      DISPATCH_GROOMER_EXPLORE_TIMEOUT_MS: "200000",
    });
    expect(b.source).toBe("env");
    expect(b.maxTotalBytes).toBe(50_000);
    expect(b.timeoutMs).toBe(200_000);
    // Unset override still comes from the mode.
    expect(b.maxFileBytes).toBe(4_096);
  });

  it("ignores non-numeric and out-of-range overrides", () => {
    const b = resolveExplorationBudget({
      DISPATCH_GROOMER_EXPLORE_MAX_BYTES: "not-a-number",
      DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS: "0",
    });
    expect(b.source).toBe(DEFAULT_CONTEXT_MODE);
    expect(b.maxTotalBytes).toBe(24_576);
  });
});

describe("deriveFromContextTokens", () => {
  it("reserves most of the window for everything exploration does not own", () => {
    const d = deriveFromContextTokens(100_000);
    expect(d.maxTotalBytes).toBeLessThan(100_000 * 3.5 * 0.5);
  });

  it("keeps a floor so a tiny window still gets a usable budget", () => {
    expect(deriveFromContextTokens(1_024).maxTotalBytes).toBeGreaterThanOrEqual(4_096);
  });

  it("caps the timeout at five minutes however large the window", () => {
    expect(deriveFromContextTokens(1_000_000).timeoutMs).toBe(300_000);
  });

  it("keeps per-file at a quarter of the budget", () => {
    const d = deriveFromContextTokens(131_072);
    expect(d.maxFileBytes).toBe(Math.floor(d.maxTotalBytes / 4));
  });
});
