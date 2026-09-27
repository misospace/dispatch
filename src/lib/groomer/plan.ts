/**
 * GroomingPlan: the versioned, evidence-backed contract the hosted groomer's
 * model produces (dispatch#1062).
 *
 * The model emits a GroomingPlanDraft: an analysis (verdict, implementation
 * brief, decomposition, related work) kept separate from mutation intent.
 * validateGroomingPlan checks the draft against the run's evidence catalog,
 * canonicalizes it, derives the status and readiness, and stamps it with the
 * snapshot it was derived from. The result is the GroomingPlan persisted on
 * GroomingRun.validatedOutput.
 *
 * Readiness is derived here, never trusted from the model: a plan is ready
 * only when its verdict says so AND every readiness invariant holds (see
 * evaluateReadiness). A ready claim that fails an invariant is a validation
 * error, so an inconsistent plan applies no mutation at all.
 */

import type { GroomAction, StatusLabel } from "@/types";
import { PRIORITY_LABELS } from "@/types";
import {
  getBacklogLane,
  getClaimableLanes,
  getDefaultClaimableLane,
  isClaimableLane,
  type LaneConfig,
} from "@/lib/lane-config";
import type { ResolutionEvent } from "./enum-config";
import { resolveEnumConfig } from "./enum-config";
import { GROOMER_ENUM_CONFIGS } from "./enum-configs";
import type {
  EvidenceCatalog,
  EvidenceCatalogEntry,
  EvidenceSubject,
  GroomingPlanEvidenceBinding,
} from "./plan-evidence";
import { ISSUE_EVIDENCE_ID } from "./plan-evidence";
import { evaluateCloseGrounding } from "./close-grounding";
import type { GroomerOutput } from "./schema";

export const GROOMING_PLAN_SCHEMA_VERSION = 1 as const;

// ─── Enums ────────────────────────────────────────────────────────────────────

export const ACTIONABILITY_VALUES = ["ready", "needs_info", "blocked", "backlog", "already_done"] as const;
export const CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
export const WORK_TYPE_VALUES = ["implementation", "design"] as const;
export const UNCERTAINTY_KIND_VALUES = [
  "missing_information",
  "unverified_premise",
  "design_choice",
  "scope",
  "other",
] as const;
export const VERIFICATION_VALUES = ["automated_test", "command", "code_inspection", "subjective"] as const;
export const PATH_CHANGE_VALUES = ["modify", "reference"] as const;
export const DEPENDENCY_STATE_VALUES = ["open", "closed", "merged", "unknown"] as const;
export const CLOSE_REASON_VALUES = ["already_done", "duplicate", "superseded"] as const;
export const RELATION_VALUES = ["duplicate_of", "superseded_by", "related"] as const;

export type Actionability = (typeof ACTIONABILITY_VALUES)[number];
export type Confidence = (typeof CONFIDENCE_VALUES)[number];
export type WorkType = (typeof WORK_TYPE_VALUES)[number];
export type UncertaintyKind = (typeof UNCERTAINTY_KIND_VALUES)[number];
export type Verification = (typeof VERIFICATION_VALUES)[number];
export type PathChange = (typeof PATH_CHANGE_VALUES)[number];
export type DependencyState = (typeof DEPENDENCY_STATE_VALUES)[number];
export type CloseReason = (typeof CLOSE_REASON_VALUES)[number];
export type RelatedWorkRelation = (typeof RELATION_VALUES)[number];

/**
 * Labels the plan may add or remove directly. Status is not here: it is
 * derived from verdict.actionability, so a plan cannot say "blocked" while
 * adding status/ready.
 */
export const PLAN_TYPE_LABELS = ["type/bug", "type/feature", "type/chore", "type/research", "type/security"] as const;
export const PLAN_LABELS: readonly string[] = [...PRIORITY_LABELS, ...PLAN_TYPE_LABELS];

/** Bounds shared by the response schema and the validator. */
export const PLAN_LIMITS = {
  shortText: 300,
  summary: 500,
  text: 1000,
  evidenceRefs: 12,
  uncertainties: 8,
  listItems: 12,
  relevantPaths: 20,
  filesToCreate: 10,
  dependencies: 10,
  childBriefs: 8,
  childCriteria: 8,
  relatedWork: 10,
  labels: 8,
  titleMin: 10,
  titleMax: 200,
  body: 9999,
  comment: 4000,
  /** already_done criterion evidence (dispatch#1099). */
  closeCriteria: 12,
  excerptMin: 8,
  excerpt: 300,
} as const;

// ─── Contract types ───────────────────────────────────────────────────────────

export interface Uncertainty {
  kind: UncertaintyKind;
  question: string;
  /** Material = it changes what a worker would do. Material blocks readiness. */
  material: boolean;
}

export interface GroomingVerdict {
  actionability: Actionability;
  workType: WorkType;
  confidence: Confidence;
  lane: { id: string; confidence: Confidence; reason: string };
  summary: string;
  rationale: string;
  evidenceRefs: string[];
  uncertainties: Uncertainty[];
}

export interface ImplementationBrief {
  problem: string;
  verifiedCurrentBehavior: { statement: string; evidenceRefs: string[] };
  /** Existing paths, cited as repository evidence ids (`repo:<path>`). */
  relevantPaths: Array<{ ref: string; change: PathChange }>;
  /** New files a worker will create; not evidence, so plain paths. */
  filesToCreate: string[];
  invariants: string[];
  inScope: string[];
  outOfScope: string[];
  /** Descriptive only: Dispatch's `depends on #N` gate owns claimability. */
  dependencies: Array<{ ref: string; state: DependencyState; evidenceRef: string | null }>;
  acceptanceCriteria: Array<{ criterion: string; verification: Verification }>;
  tests: string[];
}

/**
 * One acceptance criterion of the issue, grounded for an already_done close
 * (dispatch#1099): a repository file read at the pinned head and a short
 * excerpt that occurs verbatim in it.
 */
export interface CloseCriterionEvidence {
  criterion: string;
  /** A `repo:` evidence id read at the pinned head SHA. */
  evidenceRef: string;
  excerpt: string;
}

export interface CloseRecommendation {
  reason: CloseReason;
  rationale: string;
  evidenceRefs: string[];
  /**
   * already_done: every acceptance criterion, grounded (dispatch#1099).
   * Validation always sets it (empty when absent); plans stored before
   * #1099 lack it.
   */
  criteria?: CloseCriterionEvidence[];
}

export interface GroomingMutationIntent {
  labelsToAdd: string[];
  labelsToRemove: string[];
  proposedTitle: string | null;
  proposedBody: string | null;
  githubComment: string | null;
  close: CloseRecommendation | null;
}

export interface ChildBrief {
  title: string;
  problem: string;
  acceptanceCriteria: string[];
}

export interface GroomingDecomposition {
  required: boolean;
  reason: string | null;
  childBriefs: ChildBrief[];
}

export interface RelatedWorkCandidate {
  ref: string;
  relation: RelatedWorkRelation;
  note: string;
}

/** What the model emits. */
export interface GroomingPlanDraft {
  verdict: GroomingVerdict;
  implementationBrief: ImplementationBrief | null;
  mutations: GroomingMutationIntent;
  decomposition: GroomingDecomposition;
  relatedWork: RelatedWorkCandidate[];
}

export interface GroomingPlanCitation {
  id: string;
  subject: EvidenceSubject;
  provenance: EvidenceCatalogEntry["provenance"];
  authoritative: boolean;
  pinned: boolean;
  state: EvidenceCatalogEntry["state"];
}

/**
 * The readiness invariant, as persisted. `ready` is the only field an
 * admission gate should trust, together with `evidenceDigest` for freshness.
 *
 * - admission "implementation": a normal worker may implement it.
 * - admission "escalation": design/decision work routed to the escalation
 *   lane; never admissible to the default implementation lane.
 */
export interface GroomingReadiness {
  ready: boolean;
  admission: "implementation" | "escalation" | null;
  lane: string | null;
  evidenceDigest: string;
  /** Why the plan is not ready; empty when ready. */
  reasons: string[];
}

/** The validated, canonical plan. */
export interface GroomingPlan extends GroomingPlanDraft {
  schemaVersion: typeof GROOMING_PLAN_SCHEMA_VERSION;
  evidence: GroomingPlanEvidenceBinding;
  mutations: GroomingMutationIntent & { status: StatusLabel };
  readiness: GroomingReadiness;
  /** Every evidence id the plan cites, resolved against the catalog. */
  citations: GroomingPlanCitation[];
}

export interface GroomingPlanValidationContext {
  catalog: EvidenceCatalog;
}

export interface GroomingPlanValidationResult {
  valid: boolean;
  plan?: GroomingPlan;
  errors?: string[];
  resolutions?: ResolutionEvent[];
}

// ─── Structural parsing ───────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collects errors with a field path. Every reader returns a usable default
 * after recording an error, so one pass reports every structural problem in
 * a stable order.
 */
class Reader {
  readonly errors: string[] = [];

  error(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  object(value: unknown, path: string): Obj {
    if (isObj(value)) return value;
    this.error(path, value === undefined ? "is required" : "must be an object");
    return {};
  }

  /** Required non-empty string, trimmed, bounded. */
  text(value: unknown, path: string, max: number, min = 1): string {
    if (typeof value !== "string") {
      this.error(path, value === undefined ? "is required" : "must be a string");
      return "";
    }
    const trimmed = value.trim();
    if (trimmed.length < min) {
      this.error(path, min <= 1 ? "must not be empty" : `must be at least ${min} characters`);
    } else if (trimmed.length > max) {
      this.error(path, `must be at most ${max} characters, got ${trimmed.length}`);
    }
    return trimmed;
  }

  /** Optional string: absent or null is null. Empty is null. */
  optionalText(value: unknown, path: string, max: number, min = 1): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      this.error(path, "must be a string or null");
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length < min) this.error(path, `must be at least ${min} characters, got ${trimmed.length}`);
    else if (trimmed.length > max) this.error(path, `must be at most ${max} characters, got ${trimmed.length}`);
    return trimmed;
  }

  enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[], fallback: T): T {
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
    this.error(
      path,
      value === undefined ? "is required" : `must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`,
    );
    return fallback;
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value === "boolean") return value;
    this.error(path, value === undefined ? "is required" : "must be a boolean");
    return false;
  }

  /** Optional array (absent/null is []), bounded. */
  array(value: unknown, path: string, max: number): unknown[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      this.error(path, "must be an array");
      return [];
    }
    if (value.length > max) this.error(path, `must have at most ${max} items, got ${value.length}`);
    return value.slice(0, max);
  }

  textList(value: unknown, path: string, maxItems: number, maxChars: number): string[] {
    return this.array(value, path, maxItems).map((item, i) => this.text(item, `${path}[${i}]`, maxChars));
  }
}

function parseDraft(data: Obj, r: Reader): GroomingPlanDraft {
  const L = PLAN_LIMITS;

  const v = r.object(data.verdict, "verdict");
  const laneObj = r.object(v.lane, "verdict.lane");
  const verdict: GroomingVerdict = {
    actionability: r.enumValue(v.actionability, "verdict.actionability", ACTIONABILITY_VALUES, "backlog"),
    workType: r.enumValue(v.workType, "verdict.workType", WORK_TYPE_VALUES, "implementation"),
    confidence: r.enumValue(v.confidence, "verdict.confidence", CONFIDENCE_VALUES, "low"),
    lane: {
      id: r.text(laneObj.id, "verdict.lane.id", L.shortText),
      confidence: r.enumValue(laneObj.confidence, "verdict.lane.confidence", CONFIDENCE_VALUES, "low"),
      reason: r.text(laneObj.reason, "verdict.lane.reason", L.shortText),
    },
    summary: r.text(v.summary, "verdict.summary", L.summary),
    rationale: r.text(v.rationale, "verdict.rationale", L.text),
    evidenceRefs: r.textList(v.evidenceRefs, "verdict.evidenceRefs", L.evidenceRefs, L.shortText),
    uncertainties: r.array(v.uncertainties, "verdict.uncertainties", L.uncertainties).map((item, i) => {
      const path = `verdict.uncertainties[${i}]`;
      const u = r.object(item, path);
      return {
        kind: r.enumValue(u.kind, `${path}.kind`, UNCERTAINTY_KIND_VALUES, "other"),
        question: r.text(u.question, `${path}.question`, L.shortText),
        material: r.boolean(u.material, `${path}.material`),
      };
    }),
  };

  let implementationBrief: ImplementationBrief | null = null;
  if (data.implementationBrief !== undefined && data.implementationBrief !== null) {
    const b = r.object(data.implementationBrief, "implementationBrief");
    const vcb = r.object(b.verifiedCurrentBehavior, "implementationBrief.verifiedCurrentBehavior");
    implementationBrief = {
      problem: r.text(b.problem, "implementationBrief.problem", L.text),
      verifiedCurrentBehavior: {
        statement: r.text(vcb.statement, "implementationBrief.verifiedCurrentBehavior.statement", L.text),
        evidenceRefs: r.textList(
          vcb.evidenceRefs,
          "implementationBrief.verifiedCurrentBehavior.evidenceRefs",
          L.evidenceRefs,
          L.shortText,
        ),
      },
      relevantPaths: r.array(b.relevantPaths, "implementationBrief.relevantPaths", L.relevantPaths).map((item, i) => {
        const path = `implementationBrief.relevantPaths[${i}]`;
        const p = r.object(item, path);
        return {
          ref: r.text(p.ref, `${path}.ref`, L.shortText),
          change: r.enumValue(p.change, `${path}.change`, PATH_CHANGE_VALUES, "reference"),
        };
      }),
      filesToCreate: r.textList(b.filesToCreate, "implementationBrief.filesToCreate", L.filesToCreate, L.shortText),
      invariants: r.textList(b.invariants, "implementationBrief.invariants", L.listItems, L.shortText),
      inScope: r.textList(b.inScope, "implementationBrief.inScope", L.listItems, L.shortText),
      outOfScope: r.textList(b.outOfScope, "implementationBrief.outOfScope", L.listItems, L.shortText),
      dependencies: r.array(b.dependencies, "implementationBrief.dependencies", L.dependencies).map((item, i) => {
        const path = `implementationBrief.dependencies[${i}]`;
        const d = r.object(item, path);
        return {
          ref: r.text(d.ref, `${path}.ref`, L.shortText),
          state: r.enumValue(d.state, `${path}.state`, DEPENDENCY_STATE_VALUES, "unknown"),
          evidenceRef: r.optionalText(d.evidenceRef, `${path}.evidenceRef`, L.shortText),
        };
      }),
      acceptanceCriteria: r
        .array(b.acceptanceCriteria, "implementationBrief.acceptanceCriteria", L.listItems)
        .map((item, i) => {
          const path = `implementationBrief.acceptanceCriteria[${i}]`;
          const a = r.object(item, path);
          return {
            criterion: r.text(a.criterion, `${path}.criterion`, L.shortText),
            verification: r.enumValue(a.verification, `${path}.verification`, VERIFICATION_VALUES, "subjective"),
          };
        }),
      tests: r.textList(b.tests, "implementationBrief.tests", L.listItems, L.shortText),
    };
  }

  const m = r.object(data.mutations, "mutations");
  let close: CloseRecommendation | null = null;
  if (m.close !== undefined && m.close !== null) {
    const c = r.object(m.close, "mutations.close");
    close = {
      reason: r.enumValue(c.reason, "mutations.close.reason", CLOSE_REASON_VALUES, "already_done"),
      rationale: r.text(c.rationale, "mutations.close.rationale", L.text),
      evidenceRefs: r.textList(c.evidenceRefs, "mutations.close.evidenceRefs", L.evidenceRefs, L.shortText),
      criteria: r.array(c.criteria, "mutations.close.criteria", L.closeCriteria).map((item, i) => {
        const path = `mutations.close.criteria[${i}]`;
        const e = r.object(item, path);
        return {
          criterion: r.text(e.criterion, `${path}.criterion`, L.shortText),
          evidenceRef: r.text(e.evidenceRef, `${path}.evidenceRef`, L.shortText),
          excerpt: r.text(e.excerpt, `${path}.excerpt`, L.excerpt, L.excerptMin),
        };
      }),
    };
  }
  const mutations: GroomingMutationIntent = {
    labelsToAdd: r.textList(m.labelsToAdd, "mutations.labelsToAdd", L.labels, L.shortText),
    labelsToRemove: r.textList(m.labelsToRemove, "mutations.labelsToRemove", L.labels, L.shortText),
    proposedTitle: r.optionalText(m.proposedTitle, "mutations.proposedTitle", L.titleMax, L.titleMin),
    proposedBody: r.optionalText(m.proposedBody, "mutations.proposedBody", L.body),
    githubComment: r.optionalText(m.githubComment, "mutations.githubComment", L.comment),
    close,
  };

  let decomposition: GroomingDecomposition = { required: false, reason: null, childBriefs: [] };
  if (data.decomposition !== undefined && data.decomposition !== null) {
    const d = r.object(data.decomposition, "decomposition");
    decomposition = {
      required: r.boolean(d.required, "decomposition.required"),
      reason: r.optionalText(d.reason, "decomposition.reason", L.text),
      childBriefs: r.array(d.childBriefs, "decomposition.childBriefs", L.childBriefs).map((item, i) => {
        const path = `decomposition.childBriefs[${i}]`;
        const c = r.object(item, path);
        return {
          title: r.text(c.title, `${path}.title`, L.titleMax, L.titleMin),
          problem: r.text(c.problem, `${path}.problem`, L.text),
          acceptanceCriteria: r.textList(c.acceptanceCriteria, `${path}.acceptanceCriteria`, L.childCriteria, L.shortText),
        };
      }),
    };
  }

  const relatedWork = r.array(data.relatedWork, "relatedWork", L.relatedWork).map((item, i) => {
    const path = `relatedWork[${i}]`;
    const w = r.object(item, path);
    return {
      ref: r.text(w.ref, `${path}.ref`, L.shortText),
      relation: r.enumValue(w.relation, `${path}.relation`, RELATION_VALUES, "related"),
      note: r.text(w.note, `${path}.note`, L.shortText),
    };
  });

  return { verdict, implementationBrief, mutations, decomposition, relatedWork };
}

// ─── Evidence checks ──────────────────────────────────────────────────────────

interface CitedRef {
  path: string;
  id: string;
  /** Required subject for this position, if any. */
  subject?: EvidenceSubject;
}

function citedRefs(draft: GroomingPlanDraft): CitedRef[] {
  const refs: CitedRef[] = [];
  draft.verdict.evidenceRefs.forEach((id, i) => refs.push({ path: `verdict.evidenceRefs[${i}]`, id }));
  const brief = draft.implementationBrief;
  if (brief) {
    brief.verifiedCurrentBehavior.evidenceRefs.forEach((id, i) =>
      refs.push({ path: `implementationBrief.verifiedCurrentBehavior.evidenceRefs[${i}]`, id }),
    );
    brief.relevantPaths.forEach((p, i) =>
      refs.push({ path: `implementationBrief.relevantPaths[${i}].ref`, id: p.ref, subject: "repository" }),
    );
    brief.dependencies.forEach((d, i) => {
      if (d.evidenceRef !== null) {
        refs.push({ path: `implementationBrief.dependencies[${i}].evidenceRef`, id: d.evidenceRef, subject: "related_work" });
      }
    });
  }
  draft.mutations.close?.evidenceRefs.forEach((id, i) => refs.push({ path: `mutations.close.evidenceRefs[${i}]`, id }));
  draft.mutations.close?.criteria?.forEach((c, i) =>
    refs.push({ path: `mutations.close.criteria[${i}].evidenceRef`, id: c.evidenceRef, subject: "repository" }),
  );
  draft.relatedWork.forEach((w, i) => refs.push({ path: `relatedWork[${i}].ref`, id: w.ref, subject: "related_work" }));
  return refs;
}

/** Pinned repository evidence: a path read at the snapshot's head SHA. */
function isPinnedRepository(entry: EvidenceCatalogEntry | undefined): boolean {
  return entry !== undefined && entry.subject === "repository" && entry.pinned;
}

/**
 * The lane explicitly configured for escalation. Unlike getEscalationLane()
 * this never falls back to the default lane: design work must not land there.
 */
function explicitEscalationLane(): LaneConfig | undefined {
  return getClaimableLanes().find((lane) => lane.role === "escalation");
}

// ─── Readiness invariant ──────────────────────────────────────────────────────

/**
 * The readiness invariant (dispatch#1062). Returns every reason the draft
 * cannot be ready against this catalog; empty means it may be ready. It does
 * not look at verdict.actionability, so a later gate (#1063/#1065) can
 * re-evaluate a stored plan against a fresh catalog.
 *
 * A plan may be ready only when:
 * - it is bound to a captured, pinned snapshot;
 * - it cites repository evidence read at that pin;
 * - no material uncertainty remains (for design work, only the design
 *   choices themselves may remain);
 * - implementation work has a bounded brief with deterministic acceptance
 *   criteria, every path it marks "modify" was read at the pin, and it needs
 *   no decomposition;
 * - design work routes to the escalation lane, never the default lane;
 * - the lane is claimable and no close is recommended.
 */
export function evaluateReadiness(draft: GroomingPlanDraft, catalog: EvidenceCatalog): string[] {
  const reasons: string[] = [];
  const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const { verdict, implementationBrief: brief } = draft;
  const design = verdict.workType === "design";

  if (!catalog.binding.evidenceDigest) {
    reasons.push("the evidence snapshot was not captured, so nothing is current to cite");
  } else if (!catalog.binding.headSha) {
    reasons.push("the evidence snapshot is not pinned to a default-branch head SHA");
  }
  if (!verdict.evidenceRefs.some((id) => isPinnedRepository(byId.get(id)))) {
    reasons.push("verdict.evidenceRefs must cite at least one repository source read at the pinned head SHA");
  }
  if (verdict.confidence === "low") {
    reasons.push("verdict.confidence is low");
  }
  verdict.uncertainties.forEach((u, i) => {
    if (!u.material) return;
    if (design && u.kind === "design_choice") return;
    reasons.push(`material uncertainty remains (verdict.uncertainties[${i}]): ${u.question}`);
  });
  if (draft.mutations.close) {
    reasons.push("a close is recommended (mutations.close), which contradicts ready");
  }

  const laneId = verdict.lane.id;
  const escalation = explicitEscalationLane();
  if (design && !escalation) {
    reasons.push("design work cannot be ready: no escalation lane is configured");
  } else if (!isClaimableLane(laneId)) {
    reasons.push(`lane "${laneId}" is not claimable`);
  } else if (design && laneId !== escalation?.id) {
    reasons.push(`design work must route to the escalation lane "${escalation?.id}", not "${laneId}"`);
  }

  if (!design) {
    if (draft.decomposition.required) {
      reasons.push("decomposition.required is true; an issue that must be split is not implementation-ready");
    }
    if (!brief) {
      reasons.push("implementationBrief is required for ready implementation work");
    } else {
      if (!brief.verifiedCurrentBehavior.evidenceRefs.some((id) => isPinnedRepository(byId.get(id)))) {
        reasons.push(
          "implementationBrief.verifiedCurrentBehavior.evidenceRefs must cite repository evidence read at the pinned head SHA",
        );
      }
      if (brief.relevantPaths.length === 0 && brief.filesToCreate.length === 0) {
        reasons.push("implementationBrief must name at least one relevant path or file to create");
      }
      // A path the worker is told to modify must exist as read at the pin:
      // a search hit or a path the model named may be stale or moved.
      // Reference-only paths are orientation and may stay surfaced.
      brief.relevantPaths.forEach((p, i) => {
        if (p.change === "modify" && !isPinnedRepository(byId.get(p.ref))) {
          reasons.push(
            `implementationBrief.relevantPaths[${i}] ("${p.ref}") is marked modify but was not read at the pinned head SHA`,
          );
        }
      });
      if (brief.inScope.length === 0) {
        reasons.push("implementationBrief.inScope must not be empty");
      }
      if (brief.acceptanceCriteria.length === 0) {
        reasons.push("implementationBrief.acceptanceCriteria must not be empty");
      }
      brief.acceptanceCriteria.forEach((a, i) => {
        if (a.verification === "subjective") {
          reasons.push(`implementationBrief.acceptanceCriteria[${i}] is not deterministic (verification: subjective)`);
        }
      });
    }
  }

  return reasons;
}

// ─── Status derivation ────────────────────────────────────────────────────────

/** Statuses the groomer manages. status/done only via the already_done close. */
export const GROOMING_OWNED_STATUSES: readonly StatusLabel[] = [
  "status/ready",
  "status/backlog",
  "status/blocked",
  "status/done",
];

/** Claimed or under-review work: never the groomer's to move. */
export const IN_FLIGHT_STATUSES: readonly StatusLabel[] = ["status/in-progress", "status/in-review"];

/** The in-flight status an issue carries, if any. */
export function inFlightStatus(labels: readonly string[]): StatusLabel | null {
  return IN_FLIGHT_STATUSES.find((status) => labels.includes(status)) ?? null;
}

/** Status is a function of the verdict, not a free-form label choice. */
export function statusForActionability(actionability: Actionability): StatusLabel {
  switch (actionability) {
    case "ready":
      return "status/ready";
    case "blocked":
      return "status/blocked";
    case "already_done":
      return "status/done";
    default:
      return "status/backlog";
  }
}

// ─── Validator ────────────────────────────────────────────────────────────────

function looksLikeLegacyOutput(data: Obj): boolean {
  return data.verdict === undefined && ("lane" in data || "labelsToAdd" in data || "labelsToRemove" in data);
}

/**
 * Validate a model-emitted draft against the run's evidence catalog and
 * return the canonical plan. Errors are deterministic: field-path prefixed,
 * in a fixed check order. Lane coercions are recorded as resolutions.
 */
export function validateGroomingPlan(data: unknown, context: GroomingPlanValidationContext): GroomingPlanValidationResult {
  const { catalog } = context;
  const resolutions: ResolutionEvent[] = [];

  if (!isObj(data)) return { valid: false, errors: ["plan must be a JSON object"] };
  if (looksLikeLegacyOutput(data)) {
    return {
      valid: false,
      errors: [
        `plan uses the legacy GroomerOutput shape (top-level lane/labels); expected GroomingPlan v${GROOMING_PLAN_SCHEMA_VERSION} with verdict, implementationBrief, mutations, decomposition and relatedWork`,
      ],
    };
  }

  const r = new Reader();
  const draft = parseDraft(data, r);
  const errors = r.errors;
  const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));

  // Lane: configured id or alias.
  const laneConfig = resolveEnumConfig(GROOMER_ENUM_CONFIGS["lane.id"]);
  const rawLane = draft.verdict.lane.id;
  if (rawLane) {
    if (laneConfig.validValues.includes(rawLane)) {
      // ok
    } else if (laneConfig.aliases[rawLane] && laneConfig.validValues.includes(laneConfig.aliases[rawLane])) {
      draft.verdict.lane.id = laneConfig.aliases[rawLane];
      resolutions.push({ field: "verdict.lane.id", rawValue: rawLane, resolvedValue: draft.verdict.lane.id, source: "alias" });
    } else {
      errors.push(`verdict.lane.id: must be a configured lane (${laneConfig.validValues.join("|")}), got "${rawLane}"`);
    }
  }

  // Evidence references: every cited id must exist in this run's catalog.
  for (const ref of citedRefs(draft)) {
    const entry = byId.get(ref.id);
    if (!entry) {
      errors.push(`${ref.path}: unknown evidence reference "${ref.id}"`);
    } else if (ref.subject && entry.subject !== ref.subject) {
      errors.push(`${ref.path}: "${ref.id}" must be ${ref.subject === "repository" ? "a repository" : "a related-work"} evidence reference`);
    }
  }

  // Labels: priority/type allowlist only.
  for (const [key, list] of [
    ["labelsToAdd", draft.mutations.labelsToAdd],
    ["labelsToRemove", draft.mutations.labelsToRemove],
  ] as const) {
    list.forEach((label, i) => {
      const path = `mutations.${key}[${i}]`;
      if (label.startsWith("agent/")) errors.push(`${path}: must not contain agent/* labels: ${label}`);
      else if (label.startsWith("status/")) errors.push(`${path}: status is derived from verdict.actionability; do not set ${label}`);
      else if (!PLAN_LABELS.includes(label)) errors.push(`${path}: disallowed label: ${label}`);
    });
  }

  // Dependencies: a state that contradicts the cited GitHub state is wrong.
  draft.implementationBrief?.dependencies.forEach((d, i) => {
    const entry = d.evidenceRef ? byId.get(d.evidenceRef) : undefined;
    const contradicts =
      entry !== undefined &&
      entry.subject === "related_work" &&
      entry.state !== null &&
      d.state !== "unknown" &&
      (d.state === "open") !== (entry.state === "open");
    if (entry && contradicts) {
      errors.push(
        `implementationBrief.dependencies[${i}].state: "${d.state}" contradicts the cited evidence (${entry.id} is ${entry.state})`,
      );
    }
  });

  // Close recommendation: already_done is the only applied close, and it is
  // exactly the already_done verdict. Duplicate/superseded are recorded
  // recommendations that must point at the related work they rely on.
  const { actionability } = draft.verdict;
  const close = draft.mutations.close;
  if (actionability === "already_done") {
    if (!close || close.reason !== "already_done") {
      errors.push('mutations.close: an already_done verdict requires a close with reason "already_done"');
    } else {
      // The close policy (dispatch#1063): closing an issue is the
      // highest-impact write, so it needs high confidence and direct
      // current-revision evidence. A merged PR, a commit or a human comment
      // may corroborate, but only repository content read at the pinned
      // head shows the work is done on the code as it is now.
      if (draft.verdict.confidence !== "high") {
        errors.push(`verdict.confidence: already_done closes the issue, which requires high confidence, got "${draft.verdict.confidence}"`);
      }
      if (!close.evidenceRefs.some((id) => isPinnedRepository(byId.get(id)))) {
        errors.push(
          "mutations.close.evidenceRefs: already_done must cite pinned repository evidence, read at the head SHA (not the issue itself or automation comments); related work or a human comment may corroborate but cannot close an issue alone",
        );
      }
      draft.verdict.uncertainties.forEach((u, i) => {
        if (u.material) errors.push(`verdict.uncertainties[${i}]: already_done cannot carry a material uncertainty: ${u.question}`);
      });
      // Grounding (dispatch#1099): the evidence must establish THIS issue's
      // acceptance, criterion by criterion with verbatim excerpts, or be a
      // merged PR whose closing reference is this issue. Evidence about
      // sibling, parent or dependent work only corroborates.
      errors.push(...evaluateCloseGrounding({ evidenceRefs: close.evidenceRefs, criteria: close.criteria ?? [] }, catalog).errors);
    }
  } else if (close) {
    if (close.reason === "already_done") {
      errors.push('mutations.close.reason: "already_done" requires verdict.actionability "already_done"');
    } else {
      const relation = close.reason === "duplicate" ? "duplicate_of" : "superseded_by";
      const candidates = new Set(draft.relatedWork.filter((w) => w.relation === relation).map((w) => w.ref));
      if (!close.evidenceRefs.some((id) => candidates.has(id))) {
        errors.push(`mutations.close.evidenceRefs: a ${close.reason} recommendation must cite a relatedWork entry with relation "${relation}"`);
      }
    }
  }

  // Decomposition: required means children are described.
  if (draft.decomposition.required && draft.decomposition.childBriefs.length === 0) {
    errors.push("decomposition.childBriefs: required decomposition must describe at least one child");
  }

  if (errors.length > 0) return { valid: false, errors, resolutions };

  // Lane/readiness coherence. A ready verdict parked in the non-claimable
  // lane is moved to the lane its work type routes to (dispatch#492). A
  // non-ready verdict never sits in a claimable lane: that was how claimable
  // lanes used to promote issues implicitly.
  const lane = draft.verdict.lane;
  const design = draft.verdict.workType === "design";
  if (actionability === "ready" && !isClaimableLane(lane.id)) {
    const target = design ? explicitEscalationLane() : getDefaultClaimableLane();
    if (target) {
      resolutions.push({ field: "verdict.lane.id", rawValue: lane.id, resolvedValue: target.id, source: "invariant" });
      lane.reason = `${lane.reason} [auto: ready ${draft.verdict.workType} moved from non-claimable "${lane.id}" to "${target.id}"]`;
      lane.id = target.id;
    }
  } else if (actionability !== "ready" && isClaimableLane(lane.id)) {
    const backlog = getBacklogLane();
    if (backlog) {
      resolutions.push({ field: "verdict.lane.id", rawValue: lane.id, resolvedValue: backlog.id, source: "invariant" });
      lane.reason = `${lane.reason} [auto: ${actionability} moved from claimable "${lane.id}" to "${backlog.id}"]`;
      lane.id = backlog.id;
    }
  }

  let readiness: GroomingReadiness;
  if (actionability === "ready") {
    const failures = evaluateReadiness(draft, catalog);
    if (failures.length > 0) {
      return { valid: false, errors: failures.map((reason) => `readiness: ${reason}`), resolutions };
    }
    readiness = {
      ready: true,
      admission: design ? "escalation" : "implementation",
      lane: lane.id,
      evidenceDigest: catalog.binding.evidenceDigest,
      reasons: [],
    };
  } else {
    readiness = {
      ready: false,
      admission: null,
      lane: null,
      evidenceDigest: catalog.binding.evidenceDigest,
      reasons: [`verdict is ${actionability}`],
    };
  }

  const citationIds = [...new Set(citedRefs(draft).map((ref) => ref.id))];
  const citations: GroomingPlanCitation[] = citationIds.map((id) => {
    const entry = byId.get(id)!;
    return {
      id,
      subject: entry.subject,
      provenance: entry.provenance,
      authoritative: entry.authoritative,
      pinned: entry.pinned,
      state: entry.state,
    };
  });

  const plan: GroomingPlan = {
    schemaVersion: GROOMING_PLAN_SCHEMA_VERSION,
    evidence: { ...catalog.binding },
    ...draft,
    mutations: { ...draft.mutations, status: statusForActionability(actionability) },
    readiness,
    citations,
  };
  return { valid: true, plan, resolutions };
}

// ─── Compatibility mapping ────────────────────────────────────────────────────

function nextGroomingActionFor(plan: GroomingPlan): GroomAction | undefined {
  switch (plan.verdict.actionability) {
    case "ready":
      return plan.readiness.admission === "escalation" ? "escalate" : "promote_to_ready";
    case "needs_info":
      return "mark_needs_info";
    case "blocked":
      return "mark_blocked";
    case "backlog":
      return "mark_not_ready";
    default:
      return undefined;
  }
}

/**
 * Map a plan onto the legacy GroomerOutput the run path and existing
 * run/history consumers read, during the rollout of the plan contract.
 *
 * `currentLabels` are the labels the mutation will be applied to. Every other
 * status/* label is removed, so the derived status is the only one left and
 * the exactly-one-status post-condition cannot keep a stale status/ready or a
 * foreign status. An issue carrying an in-flight status (in-progress/in-review)
 * keeps its status labels untouched.
 */
export function toGroomerOutput(plan: GroomingPlan, currentLabels: string[]): GroomerOutput {
  const { verdict, mutations } = plan;
  const status = mutations.status;
  const inFlight = inFlightStatus(currentLabels) !== null;
  // The derived status is the only status an applied groom leaves: every
  // other status/* label goes, including ones the groomer does not own
  // (the external groom route already strips them all).
  const staleStatuses = inFlight ? [] : currentLabels.filter((label) => label.startsWith("status/") && label !== status);
  const output: GroomerOutput = {
    actionability: verdict.actionability,
    confidence: verdict.confidence,
    labelsToAdd: inFlight ? [...mutations.labelsToAdd] : [...mutations.labelsToAdd, status],
    labelsToRemove: [...new Set([...mutations.labelsToRemove, ...staleStatuses])],
    lane: { ...verdict.lane },
    summary: verdict.summary,
  };
  if (mutations.githubComment) output.githubComment = mutations.githubComment;
  if (mutations.proposedTitle) output.proposedTitle = mutations.proposedTitle;
  if (mutations.proposedBody) output.proposedBody = mutations.proposedBody;
  if (verdict.actionability === "needs_info") output.needsInfoReason = verdict.rationale;
  if (verdict.actionability === "blocked") output.blockedReason = verdict.rationale;
  if (verdict.actionability === "backlog") output.notReadyReason = verdict.rationale;
  const action = nextGroomingActionFor(plan);
  if (action) output.nextGroomingAction = action;
  return output;
}
