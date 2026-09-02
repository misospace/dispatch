/**
 * Budget for the groomer's repository exploration loop.
 *
 * Exploration used to borrow `maxContextBytes` and `timeoutMs` from the single
 * grooming call. Those were sized for one pre-computed context and one request,
 * not for a multi-turn tool loop, so the loop routinely exhausted its budget
 * partway through an investigation and stopped early.
 *
 * Three ways to size it, most specific first:
 *   1. the individual env overrides,
 *   2. `DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS` — derive from the model's real
 *      context window, which is the honest answer for a self-hosted model whose
 *      window does not match what a named mode assumes,
 *   3. `DISPATCH_GROOMER_CONTEXT_MODE` — small | medium | large.
 */

export type ContextMode = "small" | "medium" | "large";

export interface ExplorationBudget {
  /** Bytes of tool output the loop may accumulate across all turns. */
  maxTotalBytes: number;
  /** Bytes of any single file handed back to the model. */
  maxFileBytes: number;
  /** Wall-clock cap on the whole loop. */
  timeoutMs: number;
  /** Which of the three sizing paths produced this budget. */
  source: "env" | "derived" | ContextMode;
}

const MODES: Record<ContextMode, Omit<ExplorationBudget, "source">> = {
  small: { maxTotalBytes: 8_192, maxFileBytes: 4_096, timeoutMs: 90_000 },
  medium: { maxTotalBytes: 24_576, maxFileBytes: 8_192, timeoutMs: 150_000 },
  large: { maxTotalBytes: 98_304, maxFileBytes: 24_576, timeoutMs: 300_000 },
};

export const DEFAULT_CONTEXT_MODE: ContextMode = "medium";

/** Bytes per token. Deliberately conservative so a derived budget under-fills
 *  the window rather than overflowing it. */
const BYTES_PER_TOKEN = 3.5;
/** Share of the window exploration may occupy. The rest is the system prompt,
 *  the issue context, the findings block and the model's own output. */
const WINDOW_SHARE = 0.35;

function parseMode(raw: string | undefined): ContextMode | null {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "small" || v === "medium" || v === "large" ? v : null;
}

function parseIntEnv(raw: string | undefined, min = 1): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : null;
}

/**
 * Derive a budget from the model's context window, reserving the rest of the
 * window for everything exploration does not own.
 */
export function deriveFromContextTokens(tokens: number): Omit<ExplorationBudget, "source"> {
  const usable = Math.floor(tokens * WINDOW_SHARE * BYTES_PER_TOKEN);
  const maxTotalBytes = Math.max(4_096, usable);
  return {
    maxTotalBytes,
    // A quarter of the budget, so no single file can consume the whole thing
    // and leave nothing for the searches that found it.
    maxFileBytes: Math.max(2_048, Math.floor(maxTotalBytes / 4)),
    // 60s of headroom plus 5s per KB, matching the grooming call's own curve.
    timeoutMs: Math.max(60_000, Math.min(300_000, 60_000 + Math.ceil(maxTotalBytes / 1024) * 5_000)),
  };
}

export function resolveExplorationBudget(
  env: Record<string, string | undefined> = process.env,
): ExplorationBudget {
  const mode = parseMode(env.DISPATCH_GROOMER_CONTEXT_MODE) ?? DEFAULT_CONTEXT_MODE;
  const contextTokens = parseIntEnv(env.DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS, 1024);

  const base = contextTokens ? deriveFromContextTokens(contextTokens) : MODES[mode];
  const source: ExplorationBudget["source"] = contextTokens ? "derived" : mode;

  const totalOverride = parseIntEnv(env.DISPATCH_GROOMER_EXPLORE_MAX_BYTES, 1024);
  const fileOverride = parseIntEnv(env.DISPATCH_GROOMER_EXPLORE_MAX_FILE_BYTES, 512);
  const timeoutOverride = parseIntEnv(env.DISPATCH_GROOMER_EXPLORE_TIMEOUT_MS, 1_000);
  const anyOverride = totalOverride !== null || fileOverride !== null || timeoutOverride !== null;

  const maxTotalBytes = totalOverride ?? base.maxTotalBytes;
  return {
    maxTotalBytes,
    // Never let a single file exceed the whole budget, however it was set.
    maxFileBytes: Math.min(fileOverride ?? base.maxFileBytes, maxTotalBytes),
    timeoutMs: timeoutOverride ?? base.timeoutMs,
    source: anyOverride ? "env" : source,
  };
}
