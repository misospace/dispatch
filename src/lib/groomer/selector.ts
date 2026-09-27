import { prisma } from "@/lib/prisma";
import { isBacklogLane, getBacklogLane } from "@/lib/lane-config";
import {
  applyRenovateIssueExclusion,
  applyUmbrellaIssueExclusion,
  buildGroomingStateExclusionWhere,
  isRenovateIssue,
} from "@/lib/issue-filters";
import {
  ADMISSION_ISSUE_SELECT,
  evaluateQueueAdmission,
  getQueueAdmissionMode,
  loadAdmissionRuns,
  type AdmissionIssueState,
} from "@/lib/queue-admission";
import { isFreshnessTrackedStatus } from "./freshness";

/**
 * Why a candidate was chosen. "stale" and "freshness_unknown" are the
 * freshness paths (#1064); "admission_withheld" is a fresh result the worker
 * queue's admission gate (#1065) withholds; the rest is the pre-existing
 * classification logic.
 */
export type GroomingSelectionReason =
  | "targeted"
  | "classification"
  | "stale"
  | "admission_withheld"
  | "freshness_unknown";

export interface GroomingCandidate {
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  repoFullName: string;
  labels: string[];
  currentLane: string | null;
  groomingSummary: string | null;
  /** Cached GitHub comment count at selection; the freshness comment baseline. */
  commentsCount?: number;
  selectionReason?: GroomingSelectionReason;
  /** Why the previous result went stale, when selectionReason is "stale". */
  staleReasons?: string[];
}

/** A stale result is re-groomed only after this long, so no trigger can spin the groomer on one issue. */
export const STALE_REGROOM_MIN_AGE_MINUTES = 30;

/** Score bonus for a stale result: above routine backlog re-grooming, below any missing classification. */
const STALE_SCORE = 200;
/** Score for a baseline-less fully classified issue: only when nothing else wants grooming. */
const FRESHNESS_UNKNOWN_SCORE = 1;
/**
 * Score for ready work the admission gate withholds (#1065): below a stale
 * result, above routine backlog re-grooming, because re-grooming is the only
 * way withheld work is admitted again.
 */
const ADMISSION_WITHHELD_SCORE = 150;

export interface SelectGroomingCandidateOptions {
  repoFullName?: string;
  issueNumber?: number;
  /**
   * Also offer fully classified issues with no freshness baseline, at the
   * lowest priority, so they acquire one. Only the hosted groomer records a
   * baseline; an external groomer (next-task?mode=groom) applies decisions
   * through /api/issues/groom, which leaves freshness unknown, so offering it
   * these would re-groom every ready issue once per cooldown forever.
   */
  freshnessBackfill?: boolean;
  /**
   * When DISPATCH_QUEUE_ADMISSION_MODE is audit/enforce, keep ready work the
   * admission gate withholds groomable (#1065): a fresh result it withholds
   * (partial, unpinned, not ready, ...) becomes eligible after the normal
   * cooldown, and a baseline-less ready issue is backfilled ahead of routine
   * work instead of last. Hosted groomer only, for the freshnessBackfill
   * reason: only it records the baseline that would admit the issue.
   */
  admissionRegroom?: boolean;
}

export async function selectGroomingCandidate(
  options: SelectGroomingCandidateOptions = {},
): Promise<GroomingCandidate | null> {
  const issueWhere: Record<string, unknown> = {
    state: "open",
    NOT: { labels: { has: "status/done" } },
    repository: { enabled: true },
  };

  if (options.issueNumber !== undefined) {
    issueWhere.number = options.issueNumber;
  }
  if (options.repoFullName) {
    issueWhere.repository = { enabled: true, fullName: options.repoFullName };
  }
  applyRenovateIssueExclusion(issueWhere);
  applyUmbrellaIssueExclusion(issueWhere);

  // A targeted re-groom (issueNumber supplied) bypasses the blocked/not-ready
  // exclusion and the later eligibility check so parked or fully classified
  // issues can be revisited manually. Without this lever, once the groomer
  // parks an issue the field that parked it is only cleared inside the groom
  // route, which never runs for a parked issue — a one-way door. See #793/#862.
  const skipGroomingStateExclusion = options.issueNumber !== undefined;
  if (!skipGroomingStateExclusion) {
    const groomingStateWhere = buildGroomingStateExclusionWhere(24);
    // A stale grooming result (#1064) bypasses the cooldown and the
    // blocked/not-ready parking: the evidence that parked it has changed, so
    // the parking decision is exactly what needs revisiting. A short floor
    // still applies so a trigger that keeps firing cannot re-groom one issue
    // every run.
    const staleFloor = new Date(Date.now() - STALE_REGROOM_MIN_AGE_MINUTES * 60 * 1000);
    const staleWhere = {
      groomingStaleAt: { not: null },
      OR: [{ groomedAt: null }, { groomedAt: { lt: staleFloor } }],
    };
    const clause = { OR: [{ AND: groomingStateWhere.AND }, staleWhere] };
    // An issue backed off after unreadable GitHub state waits out its
    // backoff on every path, including the stale one (dispatch#1063; the
    // backoff is set by run.ts, UNVERIFIABLE_RETRY_BACKOFF_MINUTES).
    const backoff = { OR: [{ groomingRetryAfter: null }, { groomingRetryAfter: { lte: new Date() } }] };
    const existing = issueWhere.AND;
    if (Array.isArray(existing)) {
      existing.push(clause, backoff);
    } else if (existing) {
      issueWhere.AND = [existing, clause, backoff];
    } else {
      issueWhere.AND = [clause, backoff];
    }
  }

  const admissionMode = options.admissionRegroom === true ? getQueueAdmissionMode() : "off";

  const issues = await prisma.issue.findMany({
    where: issueWhere,
    select: {
      id: true,
      number: true,
      title: true,
      body: true,
      url: true,
      labels: true,
      currentLane: true,
      blockedReason: true,
      // Carried so run.ts can fall back to it as notReadyReason when the model
      // omits the field on a mark_not_ready decision (dispatch#839).
      groomingSummary: true,
      commentsCount: true,
      groomedIssueFingerprint: true,
      groomingStaleAt: true,
      groomingStaleReasons: true,
      repository: { select: { fullName: true } },
      ...(admissionMode === "off" ? {} : ADMISSION_ISSUE_SELECT),
    },
    orderBy: { number: "asc" },
  });

  // Admission (#1065) is evaluated only for fresh baselines: stale and
  // unknown results already have their own paths below.
  const admissionRuns =
    admissionMode === "off"
      ? null
      : await loadAdmissionRuns(
          (issues as unknown as AdmissionIssueState[]).filter(
            (issue) => issue.groomedIssueFingerprint && issue.groomingStaleAt == null,
          ),
        );

  const candidates = issues
    .filter((issue) => !isRenovateIssue(issue))
    .map((issue) => {
      const hasStatus = issue.labels.some((l) => l.startsWith("status/"));
      const hasPriority = issue.labels.some((l) => l.startsWith("priority/"));
      const hasAgent = issue.labels.some((l) => l.startsWith("agent/"));
      const hasLane = !!issue.currentLane;
      const isBacklogLaneValue = issue.currentLane ? isBacklogLane(issue.currentLane) : false;
      const isBacklog = isBacklogLaneValue || issue.labels.includes("status/backlog");
      const isUnlabeled = issue.labels.length === 0;
      const isUnexplainedBlocked = issue.labels.includes("status/blocked") && issue.blockedReason == null;

      const needsClassification =
        isUnexplainedBlocked ||
        isUnlabeled ||
        !hasStatus ||
        !hasPriority ||
        !hasAgent ||
        !hasLane ||
        isBacklog;

      // Freshness (#1064). Worker-owned statuses are never re-groomed.
      const groomable = isFreshnessTrackedStatus(issue.labels);
      const isStale = groomable && issue.groomingStaleAt != null;
      // A baseline-less result is backfilled only when nothing else wants the
      // groomer; a deliberate block stays parked until something stales it.
      const freshnessUnknown =
        options.freshnessBackfill === true && groomable && !issue.groomedIssueFingerprint && issue.blockedReason == null;

      // Admission (#1065): ready work the worker queue withholds must stay
      // groomable, or it is stranded (a fresh result is otherwise never
      // re-selected once fully classified).
      const isReady = issue.labels.includes("status/ready");
      let admissionWithheld = false;
      if (admissionMode !== "off" && admissionRuns && groomable && isReady && issue.groomedIssueFingerprint && issue.groomingStaleAt == null) {
        const state = issue as unknown as AdmissionIssueState;
        const run = state.groomedRunId ? admissionRuns.get(state.groomedRunId) : null;
        admissionWithheld = !evaluateQueueAdmission(state, { mode: admissionMode, run }).admitted;
      }
      const admissionUnknown = admissionMode !== "off" && freshnessUnknown && isReady;

      // Targeted runs are an explicit operator request, so they must reach
      // fully classified issues as well as issues parked by grooming.
      const eligible =
        options.issueNumber !== undefined || needsClassification || isStale || admissionWithheld || freshnessUnknown;

      let score = 0;
      if (isUnlabeled) score += 1000;
      if (!hasStatus) score += 500;
      if (!hasPriority) score += 250;
      if (isStale) score += STALE_SCORE;
      if (admissionWithheld || admissionUnknown) score += ADMISSION_WITHHELD_SCORE;
      if (isBacklog) score += 100;
      if (!hasAgent) score += 50;
      if (!hasLane && !isBacklog) score += 25;
      if (freshnessUnknown && score === 0) score = FRESHNESS_UNKNOWN_SCORE;

      const selectionReason: GroomingSelectionReason =
        options.issueNumber !== undefined
          ? "targeted"
          : needsClassification
            ? "classification"
            : isStale
              ? "stale"
              : admissionWithheld
                ? "admission_withheld"
                : "freshness_unknown";

      return { issue, eligible, score, selectionReason, isStale };
    })
    .filter((c) => c.eligible)
    .sort((a, b) => b.score - a.score || a.issue.number - b.issue.number);

  if (candidates.length === 0) {
    return null;
  }

  const { issue: best, selectionReason, isStale } = candidates[0];
  return {
    id: best.id,
    number: best.number,
    title: best.title,
    body: best.body,
    url: best.url,
    repoFullName: best.repository.fullName,
    labels: best.labels,
    currentLane: best.currentLane ?? getBacklogLane()?.id ?? "backlog",
    groomingSummary: best.groomingSummary,
    commentsCount: best.commentsCount,
    selectionReason,
    staleReasons: isStale ? (best.groomingStaleReasons ?? []) : [],
  };
}
