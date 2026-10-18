/**
 * Read-side operator view of a GroomingRun row (#1067).
 *
 * Composes the persisted evidence snapshot summary, the validated plan,
 * the mutation plan and apply-time records into one JSON-safe structure
 * that answers, without reading Postgres JSON by hand: which repo revision
 * was analyzed, what evidence the run is bound to, what the preconditions
 * and staleness said, whether the application was fresh or a replay, and
 * which high-impact decisions (close / ready promotion / decomposition)
 * the plan authorized and on what evidence.
 *
 * Redaction guarantee: this view never carries comment bodies, proposed
 * bodies, raw model output or file contents — those stay on the detail API
 * for debugging. Dependency-free so client components can import it.
 */

import { summarizeGroomingOutput } from "./plan-summary";

type Obj = Record<string, unknown>;

export interface GroomingRunEvidenceView {
  available: boolean;
  capturedAt: string | null;
  headSha: string | null;
  pinnedRef: string | null;
  defaultBranch: string | null;
  evidenceDigest: string | null;
  issueFingerprint: string | null;
  /** False when the run had no resolvable default-branch head SHA to pin reads to. */
  pinned: boolean;
  repositoryReadCount: number;
  repositorySurfacedCount: number;
  relatedWorkCount: number;
  humanCommentCount: number;
  automationCommentCount: number;
  warnings: string[];
}

export interface GroomingRunPlanView {
  schemaVersion: number | null;
  format: "grooming-plan" | "legacy" | "unknown";
  actionability: string | null;
  ready: boolean | null;
  admission: string | null;
  summary: string | null;
}

export interface GroomingRunPreconditionView {
  recorded: boolean;
  ok: boolean | null;
  failures: string[];
  checks: Array<{ name: string; status: string; detail: string | null }>;
  stale: boolean;
  unverifiable: boolean;
}

export interface GroomingRunApplicationView {
  applicationKey: string | null;
  applyOutcome: string | null;
  replayed: boolean;
  freshApplication: boolean;
  applicationCount: number | null;
  lastApplicationAt: string | null;
}

export interface GroomingRunDecisionView {
  close: { reason: string; rationale: string; evidenceRefs: string[] } | null;
  readyPromotion: {
    ready: boolean;
    admission: string | null;
    evidenceRefs: string[];
    reasons: string[];
  } | null;
  decomposition: {
    required: boolean;
    reason: string | null;
    childrenCreated: Array<{ number: number; url: string | null }>;
    childrenReused: Array<{ number: number; url: string | null }>;
  } | null;
}

export interface GroomingRunView {
  stage: string | null;
  status: string | null;
  evidence: GroomingRunEvidenceView;
  plan: GroomingRunPlanView;
  precondition: GroomingRunPreconditionView;
  application: GroomingRunApplicationView;
  decision: GroomingRunDecisionView;
}

const MAX_CHECKS = 20;
const MAX_EVIDENCE_REFS = 20;
const MAX_WARNINGS = 20;
const MAX_TEXT = 400;
const MAX_REF = 120;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function clip(value: unknown, max: number): string | null {
  const s = typeof value === "string" ? value : null;
  if (s === null) return null;
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function strArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, max);
}

function refArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .slice(0, MAX_EVIDENCE_REFS)
    .map((entry) => clip(entry, MAX_REF) ?? entry);
}

function childLinks(value: unknown): Array<{ number: number; url: string | null }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObj)
    .map((entry) => ({
      number: typeof entry.number === "number" ? entry.number : NaN,
      url: str(entry.url),
    }))
    .filter((entry) => Number.isFinite(entry.number))
    .slice(0, MAX_EVIDENCE_REFS);
}

const EMPTY_EVIDENCE: GroomingRunEvidenceView = {
  available: false,
  capturedAt: null,
  headSha: null,
  pinnedRef: null,
  defaultBranch: null,
  evidenceDigest: null,
  issueFingerprint: null,
  pinned: false,
  repositoryReadCount: 0,
  repositorySurfacedCount: 0,
  relatedWorkCount: 0,
  humanCommentCount: 0,
  automationCommentCount: 0,
  warnings: [],
};

function evidenceView(contextSummary: unknown): GroomingRunEvidenceView {
  const evidence = isObj(contextSummary) ? contextSummary.evidence : null;
  if (!isObj(evidence)) return { ...EMPTY_EVIDENCE };
  const sources = Array.isArray(evidence.sources) ? evidence.sources.filter(isObj) : [];
  let repositoryReadCount = 0;
  let repositorySurfacedCount = 0;
  let relatedWorkCount = 0;
  for (const source of sources) {
    if (source.provenance === "repository") {
      if (source.via === "read") repositoryReadCount += 1;
      else repositorySurfacedCount += 1;
    } else {
      relatedWorkCount += 1;
    }
  }
  return {
    available: true,
    capturedAt: str(evidence.capturedAt),
    headSha: str(evidence.headSha),
    pinnedRef: str(evidence.pinnedRef),
    defaultBranch: str(evidence.defaultBranch),
    evidenceDigest: str(evidence.evidenceDigest),
    issueFingerprint: str(evidence.issueFingerprint),
    pinned: str(evidence.headSha) !== null,
    repositoryReadCount,
    repositorySurfacedCount,
    relatedWorkCount,
    humanCommentCount: typeof evidence.humanCommentCount === "number" ? evidence.humanCommentCount : 0,
    automationCommentCount: typeof evidence.automationCommentCount === "number" ? evidence.automationCommentCount : 0,
    warnings: strArray(evidence.warnings, MAX_WARNINGS),
  };
}

function preconditionView(
  preconditions: unknown,
  preconditionFailures: unknown,
  applyOutcome: unknown,
): GroomingRunPreconditionView {
  const record = isObj(preconditions) ? preconditions : null;
  const checksRaw = record !== null && Array.isArray(record.checks) ? record.checks : [];
  const checks = checksRaw
    .filter(isObj)
    .map((check) => ({
      name: str(check.name) ?? "unknown",
      status: str(check.status) ?? "unknown",
      detail: clip(check.detail, MAX_TEXT),
    }))
    .slice(0, MAX_CHECKS);
  const failures = strArray(preconditionFailures, MAX_CHECKS);
  const ok = record !== null && typeof record.ok === "boolean" ? record.ok : null;
  return {
    recorded: record !== null || failures.length > 0,
    ok,
    failures,
    checks,
    stale: applyOutcome === "stale",
    unverifiable: applyOutcome === "unverifiable",
  };
}

function applicationView(
  run: Obj,
  applicationKey: unknown,
  applyOutcome: unknown,
): GroomingRunApplicationView {
  const countFromCount =
    isObj(run._count) && typeof run._count.applications === "number" ? run._count.applications : null;
  const applications = Array.isArray(run.applications) ? run.applications.filter(isObj) : [];
  const countFromRows = applications.length > 0 ? applications.length : null;
  let lastApplicationAt: string | null = null;
  for (const application of applications) {
    const createdAt = str(application.createdAt);
    if (createdAt && (!lastApplicationAt || createdAt > lastApplicationAt)) lastApplicationAt = createdAt;
  }
  return {
    applicationKey: str(applicationKey),
    applyOutcome: str(applyOutcome),
    replayed: applyOutcome === "replayed",
    freshApplication: applyOutcome === "applied",
    applicationCount: countFromCount ?? countFromRows,
    lastApplicationAt,
  };
}

function closeDecision(mutationPlan: Obj | null, validatedOutput: unknown): GroomingRunDecisionView["close"] {
  const planClose =
    mutationPlan !== null && isObj(mutationPlan.closeRecommendation) ? mutationPlan.closeRecommendation : null;
  const outputClose =
    isObj(validatedOutput) && isObj(validatedOutput.mutations) && isObj(validatedOutput.mutations.close)
      ? validatedOutput.mutations.close
      : null;
  const source = planClose ?? outputClose;
  if (!isObj(source)) return null;
  const reason = str(source.reason);
  if (reason === null) return null;
  return {
    reason,
    rationale: clip(source.rationale, MAX_TEXT) ?? "",
    evidenceRefs: refArray(source.evidenceRefs),
  };
}

function readyPromotionDecision(validatedOutput: unknown): GroomingRunDecisionView["readyPromotion"] {
  if (!isObj(validatedOutput) || !isObj(validatedOutput.readiness)) return null;
  const readiness = validatedOutput.readiness;
  if (readiness.ready !== true) return null;
  const verdict = isObj(validatedOutput.verdict) ? validatedOutput.verdict : {};
  return {
    ready: true,
    admission: str(readiness.admission),
    evidenceRefs: refArray(verdict.evidenceRefs),
    reasons: strArray(readiness.reasons, MAX_EVIDENCE_REFS),
  };
}

function decompositionDecision(
  mutationPlan: Obj | null,
  validatedOutput: unknown,
  appliedMutations: unknown,
): GroomingRunDecisionView["decomposition"] {
  const outputDecomposition =
    isObj(validatedOutput) && isObj(validatedOutput.decomposition) ? validatedOutput.decomposition : null;
  const required =
    (outputDecomposition !== null && outputDecomposition.required === true) ||
    (mutationPlan !== null && mutationPlan.willCreateChildren === true);
  const childrenCreated = isObj(appliedMutations) ? childLinks(appliedMutations.childrenCreated) : [];
  const childrenReused = isObj(appliedMutations) ? childLinks(appliedMutations.childrenReused) : [];
  if (!required && childrenCreated.length === 0 && childrenReused.length === 0) return null;
  return {
    required,
    reason: outputDecomposition !== null ? clip(outputDecomposition.reason, MAX_TEXT) : null,
    childrenCreated,
    childrenReused,
  };
}

/**
 * Build the operator view from a loose GroomingRun row (Prisma shape or a
 * serialized copy, optionally carrying `_count.applications` or an included
 * `applications` list). Never throws; malformed fields degrade.
 */
export function buildGroomingRunView(run: unknown): GroomingRunView {
  const row = isObj(run) ? run : {};
  const mutationPlan = isObj(row.mutationPlan) ? row.mutationPlan : null;
  const validatedOutput = row.validatedOutput;
  const appliedMutations = isObj(row.appliedMutations) ? row.appliedMutations : null;
  const summary = summarizeGroomingOutput(validatedOutput);
  const schemaVersion =
    summary.format === "grooming-plan" && summary.schemaVersion !== null
      ? summary.schemaVersion
      : mutationPlan !== null && typeof mutationPlan.planSchemaVersion === "number"
        ? mutationPlan.planSchemaVersion
        : null;
  return {
    stage: str(row.stage),
    status: str(row.status),
    evidence: evidenceView(row.contextSummary),
    plan: {
      schemaVersion,
      format: summary.format,
      actionability: summary.actionability,
      ready: summary.ready,
      admission: summary.admission,
      summary: summary.summary,
    },
    precondition: preconditionView(
      row.preconditions,
      row.preconditionFailures,
      row.applyOutcome ?? (mutationPlan !== null ? mutationPlan.applyOutcome : undefined),
    ),
    application: applicationView(row, row.applicationKey ?? (mutationPlan !== null ? mutationPlan.applicationKey : undefined), row.applyOutcome ?? (mutationPlan !== null ? mutationPlan.applyOutcome : undefined)),
    decision: {
      close: closeDecision(mutationPlan, validatedOutput),
      readyPromotion: readyPromotionDecision(validatedOutput),
      decomposition: decompositionDecision(mutationPlan, validatedOutput, appliedMutations),
    },
  };
}

/**
 * Strip the heavy/debug-only fields a list response should not carry and
 * attach the operator view. Raw model output, the raw context summary and
 * the comment preview stay available on the detail API only.
 */
export function serializeGroomingRunSummary(row: unknown): Obj {
  const base = isObj(row) ? row : {};
  const { rawOutput: _raw, contextSummary: _context, commentBodyPreview: _preview, ...rest } = base as Obj & {
    rawOutput?: unknown;
    contextSummary?: unknown;
    commentBodyPreview?: unknown;
  };
  return { ...rest, view: buildGroomingRunView(row) };
}
