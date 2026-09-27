/**
 * Read-side view of a GroomingRun's validatedOutput for history/UI.
 *
 * Runs recorded before the GroomingPlan contract (dispatch#1062) stored the
 * loose legacy GroomerOutput. Both shapes stay renderable: a legacy row keeps
 * its actionability, lane and summary, and reports `ready: null` because its
 * readiness was never checked against evidence. Dependency-free so client
 * components can import it.
 */

export interface GroomingOutputSummary {
  format: "grooming-plan" | "legacy" | "unknown";
  schemaVersion: number | null;
  actionability: string | null;
  workType: string | null;
  lane: string | null;
  summary: string | null;
  /** null for legacy rows: readiness was not evidence-checked then. */
  ready: boolean | null;
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

const EMPTY: GroomingOutputSummary = {
  format: "unknown",
  schemaVersion: null,
  actionability: null,
  workType: null,
  lane: null,
  summary: null,
  ready: null,
  admission: null,
  evidenceDigest: null,
  citationCount: 0,
  materialUncertaintyCount: 0,
};

export function summarizeGroomingOutput(validatedOutput: unknown): GroomingOutputSummary {
  if (!isObj(validatedOutput)) return { ...EMPTY };

  if (typeof validatedOutput.schemaVersion === "number" && isObj(validatedOutput.verdict)) {
    const verdict = validatedOutput.verdict;
    const readiness = isObj(validatedOutput.readiness) ? validatedOutput.readiness : {};
    const evidence = isObj(validatedOutput.evidence) ? validatedOutput.evidence : {};
    const lane = isObj(verdict.lane) ? verdict.lane : {};
    const uncertainties = Array.isArray(verdict.uncertainties) ? verdict.uncertainties : [];
    return {
      format: "grooming-plan",
      schemaVersion: validatedOutput.schemaVersion,
      actionability: str(verdict.actionability),
      workType: str(verdict.workType),
      lane: str(lane.id),
      summary: str(verdict.summary),
      ready: typeof readiness.ready === "boolean" ? readiness.ready : null,
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
