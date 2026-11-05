/**
 * Read-side view of a GroomingRun's validatedOutput for history/UI.
 *
 * Runs recorded before the GroomingPlan contract (dispatch#1062) stored the
 * loose legacy GroomerOutput. Both shapes stay renderable: a legacy row keeps
 * its actionability, lane and summary, and reports `ready: null` because its
 * readiness was never checked against evidence. Dependency-free so client
 * components can import it.
 */

import {
  INFO_GAP_RESOLUTION_VALUES,
  INCOMPLETE_INVESTIGATION_ACTIONABILITY,
  type InfoGapResolution,
} from "./investigation-gap";

export interface GroomingOutputSummary {
  format: "grooming-plan" | "legacy" | "unknown";
  schemaVersion: number | null;
  actionability: string | null;
  workType: string | null;
  lane: string | null;
  summary: string | null;
  /** null for legacy rows: readiness was not evidence-checked then. */
  ready: boolean | null;
  /**
   * What a not-ready verdict waits on (dispatch#1452): `human_question` or
   * `investigation_incomplete`. null for ready/other verdicts, legacy rows and
   * values outside the contract.
   */
  gapClass: InfoGapResolution | null;
  admission: string | null;
  evidenceDigest: string | null;
  citationCount: number;
  materialUncertaintyCount: number;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

const GAP_CLASS_VALUES: ReadonlySet<string> = new Set<string>(INFO_GAP_RESOLUTION_VALUES);

const EMPTY: GroomingOutputSummary = {
  format: "unknown",
  schemaVersion: null,
  actionability: null,
  workType: null,
  lane: null,
  summary: null,
  ready: null,
  gapClass: null,
  admission: null,
  evidenceDigest: null,
  citationCount: 0,
  materialUncertaintyCount: 0,
};

/**
 * The actionability a row is presented as (#1557). An incomplete
 * investigation is presented as the not-ready backlog disposition, never as
 * `needs_info`: the run waits on more machine work, not on a human answer.
 *
 * The resolved gap class on the plan is the machine truth. A legacy row
 * (recorded before the plan contract) carries no gap class and predates the
 * class itself, so it keeps the actionability it was stored with.
 */
function presentedActionability(actionability: string | null, gapClass: InfoGapResolution | null): string | null {
  if (gapClass === "investigation_incomplete") return INCOMPLETE_INVESTIGATION_ACTIONABILITY;
  return actionability;
}

export function summarizeGroomingOutput(validatedOutput: unknown): GroomingOutputSummary {
  if (!isObj(validatedOutput)) return { ...EMPTY };

  if (typeof validatedOutput.schemaVersion === "number" && isObj(validatedOutput.verdict)) {
    const verdict = validatedOutput.verdict;
    const readiness = isObj(validatedOutput.readiness) ? validatedOutput.readiness : {};
    const evidence = isObj(validatedOutput.evidence) ? validatedOutput.evidence : {};
    const lane = isObj(verdict.lane) ? verdict.lane : {};
    const uncertainties = Array.isArray(verdict.uncertainties) ? verdict.uncertainties : [];
    const rawGapClass = str(readiness.gapClass);
    const gapClass =
      rawGapClass !== null && GAP_CLASS_VALUES.has(rawGapClass) ? (rawGapClass as InfoGapResolution) : null;
    return {
      format: "grooming-plan",
      schemaVersion: validatedOutput.schemaVersion,
      actionability: presentedActionability(str(verdict.actionability), gapClass),
      workType: str(verdict.workType),
      lane: str(lane.id),
      summary: str(verdict.summary),
      ready: typeof readiness.ready === "boolean" ? readiness.ready : null,
      gapClass,
      admission: str(readiness.admission),
      evidenceDigest: str(evidence.evidenceDigest),
      citationCount: Array.isArray(validatedOutput.citations) ? validatedOutput.citations.length : 0,
      materialUncertaintyCount: uncertainties.filter((u) => isObj(u) && u.material === true).length,
    };
  }

  if (isObj(validatedOutput.lane) || Array.isArray(validatedOutput.labelsToAdd)) {
    const lane = isObj(validatedOutput.lane) ? validatedOutput.lane : {};
    return {
      ...EMPTY,
      format: "legacy",
      actionability: str(validatedOutput.actionability),
      lane: str(lane.id),
      summary: str(validatedOutput.summary),
    };
  }

  return { ...EMPTY };
}
