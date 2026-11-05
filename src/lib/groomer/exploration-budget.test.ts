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
    // The derived source ignores the named mode and scales with the window.
    expect(b.maxTotalBytes).toBe(Math.floor(131_072 * 0.35 * 3.5));
    expect(b.maxTotalBytes).toBeGreaterThan(98_304);
  });

  it("derives a small budget for a small window", () => {
    const b = resolveExplorationBudget({ DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS: "8192" });
    expect(b.source).toBe("derived");
    expect(b.maxTotalBytes).toBeLessThan(24_576);
    expect(b.maxTotalBytes).toBeGreaterThanOrEqual(4_096);
  });

  it("lets an explicit byte override win over a derived budget", () => {
    const b = resolveExplorationBudget({
      DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS: "262144",
      DISPATCH_GROOMER_EXPLORE_MAX_BYTES: "40960",
    });
    expect(b.source).toBe("env");
    expect(b.maxTotalBytes).toBe(40_960);
    expect(b.maxTotalBytes).toBeLessThan(Math.floor(262_144 * 0.35 * 3.5));
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

  it("scales derived budgets across small, 131k and 245k windows", () => {
    const small = deriveFromContextTokens(8_192);
    const mid = deriveFromContextTokens(131_072);
    const large = deriveFromContextTokens(245_760);
    expect(small.maxTotalBytes).toBe(Math.floor(8_192 * 0.35 * 3.5));
    expect(mid.maxTotalBytes).toBe(Math.floor(131_072 * 0.35 * 3.5));
    expect(large.maxTotalBytes).toBe(Math.floor(245_760 * 0.35 * 3.5));
    expect(small.maxTotalBytes).toBeLessThan(mid.maxTotalBytes);
    expect(mid.maxTotalBytes).toBeLessThan(large.maxTotalBytes);
    // Neither window is pinned to the legacy 96 KiB `large` preset cap.
    expect(mid.maxTotalBytes).toBeGreaterThan(98_304);
    expect(large.maxTotalBytes).toBeGreaterThan(98_304);
  });

  it("lets exploration exceed the legacy 96 KiB cap when the window permits it", () => {
    const d = deriveFromContextTokens(245_760);
    expect(d.maxTotalBytes).toBeGreaterThan(98_304);
    expect(d.maxFileBytes).toBeGreaterThan(24_576);
    expect(d.maxFileBytes).toBe(Math.floor(d.maxTotalBytes / 4));
    // Still bounded: a whole quarter of the budget per file, never more.
    expect(d.maxFileBytes).toBeLessThan(d.maxTotalBytes);
  });

  it("keeps the derived timeout a bounded runaway limit", () => {
    const d = deriveFromContextTokens(245_760);
    expect(d.timeoutMs).toBe(300_000);
    expect(deriveFromContextTokens(8_192).timeoutMs).toBeLessThanOrEqual(300_000);
  });

  it("keeps per-file at a quarter of the budget", () => {
    const d = deriveFromContextTokens(131_072);
    expect(d.maxFileBytes).toBe(Math.floor(d.maxTotalBytes / 4));
  });
});
