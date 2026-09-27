/**
 * Grooming freshness admission for the autonomous worker queue (#1065).
 *
 * Decides, from persisted state alone, whether a `status/ready` issue may be
 * handed to an implementation worker: it needs a current, applied,
 * evidence-backed grooming decision (#1062 readiness, #1063 application,
 * #1064 freshness) or a current explicit operator override. No model call
 * and no GitHub call happens here; the only database reads are the columns
 * the queue already loads plus one primary-key lookup of the grooming runs
 * the ready issues' freshness baselines point at.
 *
 * Rollout modes (DISPATCH_QUEUE_ADMISSION_MODE):
 * - off (default): the queue is exactly what it was before this module.
 * - audit: nothing is filtered; every queue item carries the decision.
 * - enforce: withheld items are removed from implementation pickup; the
 *   decision is still exposed for diagnostics.
 *
 * Only status/ready issues are gated. Worker-owned statuses (in-progress) are
 * already picked up, and the freshness pass deliberately stops tracking them,
 * so gating them would only strand a worker's own claimed work.
 */
import { prisma } from "@/lib/prisma";
import { getStatusFromLabels } from "@/types";
import { getEscalationLane, resolveLaneId } from "@/lib/lane-config";
import { computeGroomingIssueFingerprint } from "@/lib/groomer/freshness";

export type QueueAdmissionMode = "off" | "audit" | "enforce";

const READY_STATUS = "status/ready";

let warnedMode: string | null = null;

/**
 * The configured rollout mode. Unset or unrecognised values mean "off", so a
 * typo can never starve the fleet; an unrecognised value is logged once.
 */
export function getQueueAdmissionMode(): QueueAdmissionMode {
  const raw = process.env.DISPATCH_QUEUE_ADMISSION_MODE?.trim().toLowerCase();
  if (!raw || raw === "off") return "off";
  if (raw === "audit" || raw === "enforce") return raw;
  if (warnedMode !== raw) {
    warnedMode = raw;
    console.warn(
      `[queue-admission] unrecognised DISPATCH_QUEUE_ADMISSION_MODE="${raw}"; expected off, audit or enforce. Admission is off.`,
    );
  }
  return "off";
}

export const ADMISSION_REASON_CODES = [
  "dependency_blocked",
  "grooming_unknown",
  "grooming_stale",
  "grooming_issue_changed",
  "grooming_unverified",
  "grooming_run_missing",
  "grooming_not_applied",
  "grooming_partial",
  "grooming_readiness_missing",
  "grooming_not_ready",
  "grooming_evidence_mismatch",
  "escalation_lane_mismatch",
] as const;
export type AdmissionReasonCode = (typeof ADMISSION_REASON_CODES)[number];

export interface AdmissionReason {
  code: AdmissionReasonCode;
  message: string;
}

/**
 * The decision carried on a queue item in audit/enforce mode.
 * - basis "grooming": admitted (or withheld) on the grooming decision.
 * - basis "override": admitted on a current explicit operator override.
 * - basis "not_gated": the item is not a status/ready issue.
 */
export interface QueueAdmission {
  mode: "audit" | "enforce";
  admitted: boolean;
  basis: "grooming" | "override" | "not_gated";
  reasons: AdmissionReason[];
  /** One human-readable line; empty when admitted. */
  summary: string;
  /** The grooming run (or override id) the decision was evaluated against. */
  groomedRunId: string | null;
}

/** The persisted Issue state admission reads. */
export interface AdmissionIssueState {
  labels: string[];
  title: string;
  body: string | null;
  state?: string | null;
  currentLane?: string | null;
  groomedRunId?: string | null;
  groomedIssueFingerprint?: string | null;
  groomedEvidenceDigest?: string | null;
  groomedEvidenceScope?: string | null;
  groomingStaleAt?: Date | string | null;
  groomingStaleReasons?: string[] | null;
  groomingVerifiedSha?: string | null;
  admissionOverrideId?: string | null;
}

/** The grooming run a baseline points at. */
export interface AdmissionRunState {
  id: string;
  status: string;
  stage: string;
  dryRun: boolean;
  validatedOutput: unknown;
}

/** Prisma select for the Issue columns admission needs beyond the queue's own. */
export const ADMISSION_ISSUE_SELECT = {
  state: true,
  groomedRunId: true,
  groomedIssueFingerprint: true,
  groomedEvidenceDigest: true,
  groomedEvidenceScope: true,
  groomingStaleAt: true,
  groomingStaleReasons: true,
  groomingVerifiedSha: true,
  admissionOverrideId: true,
} as const;

interface Readiness {
  ready: boolean;
  admission: string | null;
  lane: string | null;
  evidenceDigest: string;
  reasons: string[];
}

/** Tolerant reader for #1062's persisted `validatedOutput.readiness`. */
export function readPlanReadiness(validatedOutput: unknown): Readiness | null {
  if (!validatedOutput || typeof validatedOutput !== "object") return null;
  const readiness = (validatedOutput as { readiness?: unknown }).readiness;
  if (!readiness || typeof readiness !== "object") return null;
  const r = readiness as Record<string, unknown>;
  if (typeof r.ready !== "boolean") return null;
  return {
    ready: r.ready,
    admission: typeof r.admission === "string" ? r.admission : null,
    lane: typeof r.lane === "string" ? r.lane : null,
    evidenceDigest: typeof r.evidenceDigest === "string" ? r.evidenceDigest : "",
    reasons: Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === "string") : [],
  };
}

/** Whether a baseline was written by a current operator override rather than a grooming run. */
export function isOverrideBaseline(issue: AdmissionIssueState): boolean {
  return !!issue.admissionOverrideId && issue.groomedRunId === issue.admissionOverrideId;
}

/** Grooming run ids the ready issues' baselines point at (overrides excluded). */
export function admissionRunIds(issues: AdmissionIssueState[]): string[] {
  const ids = new Set<string>();
  for (const issue of issues) {
    if (getStatusFromLabels(issue.labels) !== READY_STATUS) continue;
    if (!issue.groomedRunId || isOverrideBaseline(issue)) continue;
    ids.add(issue.groomedRunId);
  }
  return [...ids];
}

/**
 * The grooming runs the given issues' baselines point at, keyed by id. One
 * primary-key query, skipped when no ready issue has a groomer baseline.
 */
export async function loadAdmissionRuns(
  issues: AdmissionIssueState[],
  client: typeof prisma = prisma,
): Promise<Map<string, AdmissionRunState>> {
  const ids = admissionRunIds(issues);
  const runs = new Map<string, AdmissionRunState>();
  if (ids.length === 0) return runs;
  const rows = await client.groomingRun.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, stage: true, dryRun: true, validatedOutput: true },
  });
  for (const row of rows) runs.set(row.id, row);
  return runs;
}

function reason(code: AdmissionReasonCode, message: string): AdmissionReason {
  return { code, message };
}

function decision(
  mode: "audit" | "enforce",
  basis: QueueAdmission["basis"],
  reasons: AdmissionReason[],
  groomedRunId: string | null,
): QueueAdmission {
  return {
    mode,
    admitted: reasons.length === 0,
    basis,
    reasons,
    summary: reasons.map((r) => r.message).join("; "),
    groomedRunId,
  };
}

export interface EvaluateAdmissionOptions {
  mode: "audit" | "enforce";
  /** The run `issue.groomedRunId` points at; undefined/null when there is none. */
  run?: AdmissionRunState | null;
  /** #1038's formatted open-blocker reason, when the issue has open blockers. */
  dependencyBlockReason?: string | null;
}

/**
 * The admission rule. A status/ready issue is admitted only when:
 * 1. no deterministic `depends on #N` blocker is open (#1038);
 * 2. it has a freshness baseline (not unknown) that is not marked stale;
 * 3. the cached issue still matches that baseline's fingerprint (an edit the
 *    freshness pass has not recorded yet still counts);
 * 4. a baseline that relies on repository state was pinned to a verified SHA;
 * 5. the baseline is a current operator override, or its grooming run was
 *    fully applied (not dry-run, skipped, partial or failed) with a #1062
 *    readiness of ready, bound to the same evidence digest, and an escalation
 *    admission sits on the escalation lane.
 * Every failing condition is reported; nothing short-circuits past step 2.
 */
export function evaluateQueueAdmission(issue: AdmissionIssueState, options: EvaluateAdmissionOptions): QueueAdmission {
  const { mode } = options;
  const groomedRunId = issue.groomedRunId ?? null;
  if (getStatusFromLabels(issue.labels) !== READY_STATUS) return decision(mode, "not_gated", [], groomedRunId);

  const reasons: AdmissionReason[] = [];
  if (options.dependencyBlockReason) {
    reasons.push(reason("dependency_blocked", options.dependencyBlockReason));
  }

  if (!issue.groomedIssueFingerprint) {
    reasons.push(reason("grooming_unknown", "No current grooming decision: freshness is unknown (not groomed since freshness tracking, or the baseline could not be recorded)"));
    return decision(mode, "grooming", reasons, groomedRunId);
  }
  if (issue.groomingStaleAt) {
    const why = issue.groomingStaleReasons?.length ? ` (${issue.groomingStaleReasons.join(", ")})` : "";
    reasons.push(reason("grooming_stale", `Grooming decision is stale${why}; awaiting re-grooming`));
    return decision(mode, "grooming", reasons, groomedRunId);
  }

  const override = isOverrideBaseline(issue);
  const basis: QueueAdmission["basis"] = override ? "override" : "grooming";
  const subject = override ? "Operator override" : "Grooming decision";

  const fingerprint = computeGroomingIssueFingerprint({
    title: issue.title,
    body: issue.body,
    state: issue.state ?? "open",
    labels: issue.labels,
  });
  if (fingerprint !== issue.groomedIssueFingerprint) {
    reasons.push(reason("grooming_issue_changed", `Issue title/body/labels changed since the ${subject.toLowerCase()} was recorded`));
  }

  const scope = issue.groomedEvidenceScope ?? null;
  if (scope !== "none" && !issue.groomingVerifiedSha) {
    reasons.push(reason("grooming_unverified", `${subject} is not pinned to a verified repository revision`));
  }

  if (override) return decision(mode, basis, reasons, groomedRunId);

  const run = options.run ?? null;
  if (!run) {
    reasons.push(reason("grooming_run_missing", "The grooming run behind the freshness baseline was not found"));
    return decision(mode, basis, reasons, groomedRunId);
  }
  if (run.dryRun || run.stage !== "applied") {
    reasons.push(reason("grooming_not_applied", `Grooming run ${run.id} was not applied (stage ${run.stage}${run.dryRun ? ", dry run" : ""})`));
  } else if (run.status === "partial") {
    reasons.push(reason("grooming_partial", `Grooming run ${run.id} was only partially applied; awaiting a retry`));
  } else if (run.status !== "completed") {
    reasons.push(reason("grooming_not_applied", `Grooming run ${run.id} did not complete (status ${run.status})`));
  }

  const readiness = readPlanReadiness(run.validatedOutput);
  if (!readiness) {
    reasons.push(reason("grooming_readiness_missing", `Grooming run ${run.id} has no structured readiness decision`));
    return decision(mode, basis, reasons, groomedRunId);
  }
  if (!readiness.ready) {
    const why = readiness.reasons.length ? `: ${readiness.reasons.join("; ")}` : "";
    reasons.push(reason("grooming_not_ready", `Grooming plan is not ready${why}`));
  }
  if (!readiness.evidenceDigest || readiness.evidenceDigest !== issue.groomedEvidenceDigest) {
    reasons.push(reason("grooming_evidence_mismatch", "Grooming plan is not bound to the evidence the freshness baseline records"));
  }
  if (readiness.ready && readiness.admission === "escalation") {
    const escalation = getEscalationLane()?.id ?? null;
    const current = resolveLaneId(issue.currentLane?.toLowerCase() ?? null);
    if (!escalation || current !== escalation) {
      reasons.push(
        reason(
          "escalation_lane_mismatch",
          `Grooming admitted this for escalation only, but it is on lane "${issue.currentLane ?? "none"}"`,
        ),
      );
    }
  }
  return decision(mode, basis, reasons, groomedRunId);
}

/** Short prefix for the board annotation, by mode. */
export function withheldAnnotation(admission: QueueAdmission): string | null {
  if (admission.admitted) return null;
  const prefix = admission.mode === "enforce" ? "Withheld from workers" : "Would be withheld from workers (audit)";
  return `${prefix}: ${admission.summary}`;
}

interface BoardIssue extends AdmissionIssueState {
  state: string;
}

/**
 * Board/list annotation: adds `admissionWithheldReason` to open status/ready
 * issues in audit/enforce mode. In off mode the array is returned untouched,
 * so the response shape does not change. Dependency blockers are left out:
 * the card already shows `dependencyBlockReason`.
 */
export async function withAdmissionAnnotations<T extends BoardIssue>(
  issues: T[],
  client: typeof prisma = prisma,
): Promise<Array<T & { admissionWithheldReason?: string | null }>> {
  const mode = getQueueAdmissionMode();
  if (mode === "off") return issues;
  const open = issues.filter((issue) => issue.state === "open");
  const runs = await loadAdmissionRuns(open, client);
  return issues.map((issue) => {
    if (issue.state !== "open") return { ...issue, admissionWithheldReason: null };
    const admission = evaluateQueueAdmission(issue, {
      mode,
      run: issue.groomedRunId ? runs.get(issue.groomedRunId) : null,
    });
    return { ...issue, admissionWithheldReason: withheldAnnotation(admission) };
  });
}
