/**
 * The off/observe/auto rollout contract for automation dispositions (#1542).
 *
 * `observe` runs the full assessment against live inputs but performs no
 * external mutation; the durable record carries an explicit would-
 * disposition (`would_act`, `would_noop`, `would_refuse`,
 * `assessment_unavailable`) plus the proposed mutations and the evidence
 * revision they were based on, so an operator can measure precision before
 * enabling `auto`. The types and derivation here are deliberately groomer-
 * agnostic so other Dispatch automation can adopt the same contract later.
 *
 * Dependency-free and pure: everything here is unit-testable without Prisma
 * or GitHub.
 */

export type GroomerMode = "off" | "observe" | "auto";

export const GROOMER_MODES: readonly GroomerMode[] = ["off", "observe", "auto"];

/**
 * What an observe-mode run would have done had it been allowed to act.
 * - `would_act`: the plan carried at least one mutation that would have been
 *   written (labels, comment, close, children, title/body).
 * - `would_noop`: the assessment ran and decided, but nothing external would
 *   have changed (including a plan whose application key was already
 *   applied — auto would have replayed, writing nothing new).
 * - `would_refuse`: the pipeline would have declined to act on this issue
 *   (in-flight status, stale or unverifiable evidence, a held reply with no
 *   other mutation).
 * - `assessment_unavailable`: no decision exists — the evidence snapshot
 *   could not capture the live issue, or the model stage failed.
 */
export type ObserveDisposition =
  | "would_act"
  | "would_noop"
  | "would_refuse"
  | "assessment_unavailable";

export const OBSERVE_DISPOSITIONS: readonly ObserveDisposition[] = [
  "would_act",
  "would_noop",
  "would_refuse",
  "assessment_unavailable",
];

export function isGroomerMode(value: unknown): value is GroomerMode {
  return typeof value === "string" && (GROOMER_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the configured mode from the raw env value. A recognized value
 * wins; an unset value maps from the legacy dry-run boolean (true → observe,
 * false → auto), which is the exact behavior the boolean had. An
 * unrecognized value falls back to the same legacy mapping — the caller
 * warns, this module stays pure.
 */
export function resolveGroomerMode(raw: string | undefined, dryRun: boolean): GroomerMode {
  if (raw) {
    const normalized = raw.trim().toLowerCase();
    if (isGroomerMode(normalized)) return normalized;
  }
  return dryRun ? "observe" : "auto";
}

export interface WouldMutateInput {
  /** Final label set the labels step would write. */
  labelsStep: string[];
  labelsBefore: string[];
  /** Planned comment text; null when none. */
  comment: string | null;
  /** False when the reply gate would hold or suppress the comment. */
  commentWouldPost: boolean;
  close: boolean;
  children: boolean;
  title: string | null;
  body: string | null;
}

function sameLabelSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Map<string, number>();
  for (const label of a) seen.set(label, (seen.get(label) ?? 0) + 1);
  for (const label of b) {
    const count = seen.get(label) ?? 0;
    if (count === 0) return false;
    seen.set(label, count - 1);
  }
  return true;
}

/**
 * Whether auto mode would have written anything external for this diff.
 * Label comparison is order-insensitive: relabeling to the same set in a
 * different order writes nothing.
 */
export function wouldMutate(input: WouldMutateInput): boolean {
  if (!sameLabelSet(input.labelsStep, input.labelsBefore)) return true;
  if (input.comment !== null && input.commentWouldPost) return true;
  if (input.close) return true;
  if (input.children) return true;
  if (input.title !== null) return true;
  if (input.body !== null) return true;
  return false;
}

export interface DeriveObserveDispositionInput {
  /** The dry-run apply outcome this observation recorded. */
  applyOutcome: "dry_run" | "would_replay" | "stale" | "unverifiable";
  wouldMutate: boolean;
  /** The issue was in flight, so the plan was skipped outright. */
  inFlight: boolean;
  /** The evidence snapshot did not capture the live issue. */
  snapshotUnreadable: boolean;
  /**
   * The only planned mutation was a reply the gate would hold or suppress —
   * a refusal to speak, not a no-op, so an operator approving the pending
   * reply is what separates refuse from act.
   */
  commentHeldOnly?: boolean;
}

export function deriveObserveDisposition(input: DeriveObserveDispositionInput): ObserveDisposition {
  if (input.snapshotUnreadable) return "assessment_unavailable";
  if (input.inFlight) return "would_refuse";
  if (input.applyOutcome === "stale" || input.applyOutcome === "unverifiable") return "would_refuse";
  if (input.applyOutcome === "would_replay") return "would_noop";
  if (!input.wouldMutate && input.commentHeldOnly) return "would_refuse";
  return input.wouldMutate ? "would_act" : "would_noop";
}

export interface ObserveWindowSummary {
  total: number;
  would_act: number;
  would_noop: number;
  would_refuse: number;
  assessment_unavailable: number;
}

/** Count dispositions over pre-filtered observe rows; nulls count in total only. */
export function summarizeObserveWindow(
  rows: Array<{ observeDisposition: string | null }>,
): ObserveWindowSummary {
  const summary: ObserveWindowSummary = {
    total: rows.length,
    would_act: 0,
    would_noop: 0,
    would_refuse: 0,
    assessment_unavailable: 0,
  };
  for (const row of rows) {
    if (
      row.observeDisposition !== null &&
      (OBSERVE_DISPOSITIONS as readonly string[]).includes(row.observeDisposition)
    ) {
      summary[row.observeDisposition as ObserveDisposition] += 1;
    }
  }
  return summary;
}
