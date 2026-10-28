/**
 * The investigation gap: what a needs_info verdict is actually waiting for
 * (dispatch#1452).
 *
 * A needs_info decision used to carry one undifferentiated rationale, so a
 * groomer whose code search timed out looked identical to an issue genuinely
 * awaiting a maintainer choice. This module separates the two:
 *
 * - The model declares `verdict.infoGap` with a kind: a concrete question a
 *   human owes the issue (product decision, external fact, runtime
 *   reproduction), or an honest `investigation_incomplete` (the evidence the
 *   verdict needs could not be read).
 * - The run derives `InvestigationGapFacts` from its own exploration: failed
 *   tool calls, truncated reads, exhausted budgets, aborted or unavailable
 *   rounds. Those facts are authoritative over the declaration — a human
 *   question asserted on top of a broken investigation resolves to
 *   `investigation_incomplete`, so the issue keeps retrying on the bounded
 *   grooming schedule instead of parking on a question nobody was really
 *   asked.
 *
 * Nothing here weakens readiness or closure evidence rules: the resolution
 * only classifies what a NOT-ready verdict is waiting on.
 */

export const INFO_GAP_KIND_VALUES = [
  "product_decision",
  "external_fact",
  "runtime_reproduction",
  "investigation_incomplete",
] as const;
export type InfoGapKind = (typeof INFO_GAP_KIND_VALUES)[number];

export const INFO_GAP_RESOLUTION_VALUES = ["human_question", "investigation_incomplete"] as const;
export type InfoGapResolution = (typeof INFO_GAP_RESOLUTION_VALUES)[number];

/** What the model declares in `verdict.infoGap` for a needs_info plan. */
export interface InfoGap {
  kind: InfoGapKind;
  /** The concrete unanswered question, in the reporter's or maintainer's terms. */
  question: string;
  /** Why the repository and related-work evidence this run had cannot answer it. */
  whyToolsCannotAnswer: string;
}

/** The gap as persisted: the declaration plus the resolution the run derived. */
export interface ResolvedInfoGap extends InfoGap {
  resolution: InfoGapResolution;
  /**
   * Machine codes for the exploration facts behind the resolution, e.g.
   * "tool_failure:search_code", "truncated_read:src/app/page.tsx",
   * "budget_exhausted", "rounds_exhausted", "exploration_aborted",
   * "exploration_unavailable". Empty when the resolution rests on the
   * declaration alone.
   */
  factCodes: string[];
}

/** The run's own exploration diagnostics, derived, never model-authored. */
export interface InvestigationGapFacts {
  /** True when this run drove the exploration loop at all. */
  explorationRan: boolean;
  /** Tool names whose call returned ok: false. */
  toolFailures: string[];
  /** Paths whose read_file / list_directory result was cut off. */
  truncatedReads: string[];
  /** The byte budget ended the exploration. */
  budgetExhausted: boolean;
  /** All rounds were used without submitting findings. */
  roundsExhausted: boolean;
  /** The exploration loop aborted on its wall-clock timeout or an error. */
  aborted: boolean;
  /** An exploration round came back non-200 (the model was groomed without it). */
  unavailable: boolean;
}

/** True when the facts show this run's investigation was cut short. */
export function factsShowIncompleteInvestigation(facts: InvestigationGapFacts): boolean {
  return (
    facts.toolFailures.length > 0 ||
    facts.truncatedReads.length > 0 ||
    facts.budgetExhausted ||
    facts.roundsExhausted ||
    facts.aborted ||
    facts.unavailable
  );
}

/** Machine codes naming each incomplete-investigation fact. */
export function investigationFactCodes(facts: InvestigationGapFacts): string[] {
  const codes: string[] = [];
  for (const name of new Set(facts.toolFailures)) codes.push(`tool_failure:${name}`);
  for (const path of new Set(facts.truncatedReads)) codes.push(`truncated_read:${path}`);
  if (facts.budgetExhausted) codes.push("budget_exhausted");
  if (facts.roundsExhausted) codes.push("rounds_exhausted");
  if (facts.aborted) codes.push("exploration_aborted");
  if (facts.unavailable) codes.push("exploration_unavailable");
  return codes;
}

/**
 * Resolve the declared gap against the run's exploration facts. Failed tools,
 * truncated reads and exhausted budgets outrank a confident human question:
 * an investigation that never finished has not earned the right to ask.
 * With no adverse facts the declaration stands, including the model's own
 * `investigation_incomplete` — honest uncertainty is never upgraded to
 * confident, and never downgraded either.
 */
export function resolveInfoGap(
  gap: InfoGap | null,
  facts: InvestigationGapFacts | null,
): ResolvedInfoGap | null {
  if (!gap) return null;
  const factCodes = facts ? investigationFactCodes(facts) : [];
  const factsIncomplete = facts !== null && factsShowIncompleteInvestigation(facts);
  const resolution: InfoGapResolution =
    factsIncomplete || gap.kind === "investigation_incomplete" ? "investigation_incomplete" : "human_question";
  return { ...gap, resolution, factCodes };
}

/**
 * The readiness reason line for a resolved gap, so the persisted plan says
 * what it waits for without parsing prose: incomplete investigations name
 * their fact codes; human questions name the kind and the question.
 */
export function infoGapReadinessReason(gap: ResolvedInfoGap): string {
  if (gap.resolution === "investigation_incomplete") {
    const detail = gap.factCodes.length > 0 ? gap.factCodes.join(", ") : "evidence not read";
    return `investigation incomplete (${detail}): ${gap.question}`;
  }
  return `awaiting human (${gap.kind}): ${gap.question}`;
}
