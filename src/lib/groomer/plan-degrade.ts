/**
 * Degrade a GroomingPlan draft instead of rejecting it, for the few
 * validation errors in fields no mutation depends on (dispatch#1126).
 *
 * Most rejected plans failed on one reference field's format: a relatedWork
 * ref or a dependency evidenceRef citing an `issue`, `comment:` or `repo:` id
 * where only a related-work (`github:`) id is valid, or a lane reason or
 * uncertainty question a little over its length limit. Throwing the whole
 * plan away for that wastes a full grooming pass. When those are the ONLY
 * errors left after the repair turn, the draft is corrected here and
 * validated again; any other error, or any error the corrected draft raises
 * on re-validation, still rejects the plan.
 *
 * Why each field is safe to degrade:
 * - relatedWork[i] with an invalid ref is dropped. relatedWork is analysis:
 *   the mutation diff, readiness and the already_done close grounding never
 *   read it. Its one consumer that gates anything is the duplicate/superseded
 *   close recommendation (plan.ts), which re-validation still enforces: if
 *   the dropped entry was the one a recommendation cited, the plan is
 *   rejected exactly as before. Such recommendations are never applied.
 *   One more consumer reads the ids themselves: the freshness baseline tracks
 *   the files a plan cites (deriveEvidenceReliance in freshness.ts). So the
 *   caller keeps a plan failing when a removed `repo:` id is cited nowhere
 *   else (see removedRefs); `issue` and `comment:` ids do not feed it.
 * - implementationBrief.dependencies[i].evidenceRef with an invalid ref is
 *   set to null, which the contract already allows. Dependencies are
 *   descriptive (Dispatch's `depends on #N` gate owns claimability), and the
 *   only check an evidenceRef feeds, the state-contradiction check, applies
 *   to related-work entries only, so an invalid ref never reached it. The
 *   same freshness check applies to a cleared `repo:` id.
 * - verdict.uncertainties[i].question and verdict.lane.reason over their
 *   limit are truncated. Both are free text: readiness and the close policy
 *   decide on an uncertainty's kind and material flag and on lane.id, never
 *   on this text.
 */

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A reference field that must be related work, rejected as unknown or as the wrong kind. */
const BAD_RELATED_REF =
  /^(?:relatedWork\[(\d+)\]\.ref|implementationBrief\.dependencies\[(\d+)\]\.evidenceRef): (?:unknown evidence reference ".*"|".*" must be a related-work evidence reference)$/;

/** Free text over its limit, in the two fields that may be truncated. */
const OVERLONG_TEXT =
  /^(?:verdict\.uncertainties\[(\d+)\]\.question|(verdict\.lane\.reason)): must be at most (\d+) characters, got \d+$/;

export interface DegradedPlanDraft {
  /** A corrected copy of the draft; the model's own output is not modified. */
  output: Obj;
  /** One context warning per change made. */
  warnings: string[];
  /** Every evidence id removed from the draft, for the caller's freshness check. */
  removedRefs: string[];
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Correct a draft whose validation errors are all degradable. Returns null
 * when any error is not, or when the draft does not have the shape the
 * errors describe; the caller then rejects the plan with its errors.
 */
export function degradePlanDraft(raw: unknown, errors: string[]): DegradedPlanDraft | null {
  if (!isObj(raw) || errors.length === 0) return null;
  const output = structuredClone(raw);
  const warnings: string[] = [];
  const removedRefs: string[] = [];
  const dropRelated = new Set<number>();

  for (const error of errors) {
    const ref = BAD_RELATED_REF.exec(error);
    if (ref) {
      if (ref[1] !== undefined) {
        const i = Number(ref[1]);
        const entry = Array.isArray(output.relatedWork) ? output.relatedWork[i] : undefined;
        if (!isObj(entry)) return null;
        dropRelated.add(i);
        if (typeof entry.ref === "string") removedRefs.push(entry.ref.trim());
        warnings.push(`plan: dropped relatedWork[${i}] (ref ${JSON.stringify(entry.ref)}): not a related-work evidence id`);
      } else {
        const i = Number(ref[2]);
        const brief = output.implementationBrief;
        const dependency = isObj(brief) && Array.isArray(brief.dependencies) ? brief.dependencies[i] : undefined;
        if (!isObj(dependency)) return null;
        warnings.push(
          `plan: cleared implementationBrief.dependencies[${i}].evidenceRef (${JSON.stringify(dependency.evidenceRef)}): not a related-work evidence id`,
        );
        if (typeof dependency.evidenceRef === "string") removedRefs.push(dependency.evidenceRef.trim());
        dependency.evidenceRef = null;
      }
      continue;
    }

    const text = OVERLONG_TEXT.exec(error);
    if (text) {
      const max = Number(text[3]);
      const verdict = output.verdict;
      if (!isObj(verdict)) return null;
      if (text[2] !== undefined) {
        const lane = verdict.lane;
        if (!isObj(lane) || typeof lane.reason !== "string") return null;
        lane.reason = truncate(lane.reason, max);
        warnings.push(`plan: truncated verdict.lane.reason to ${max} characters`);
      } else {
        const i = Number(text[1]);
        const uncertainty = Array.isArray(verdict.uncertainties) ? verdict.uncertainties[i] : undefined;
        if (!isObj(uncertainty) || typeof uncertainty.question !== "string") return null;
        uncertainty.question = truncate(uncertainty.question, max);
        warnings.push(`plan: truncated verdict.uncertainties[${i}].question to ${max} characters`);
      }
      continue;
    }

    // Anything else may affect a mutation: never degrade it.
    return null;
  }

  if (dropRelated.size > 0) {
    output.relatedWork = (output.relatedWork as unknown[]).filter((_, i) => !dropRelated.has(i));
  }
  return { output, warnings, removedRefs };
}
