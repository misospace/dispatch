/**
 * Explicit operator admission override (#1065).
 *
 * A bare `status/ready` label is never an override. An operator records one
 * through an authenticated action, and it is written as a grooming freshness
 * baseline (#1064) whose groomedRunId is the override id. That makes it
 * freshness-bound under exactly the checks a grooming result gets: an issue
 * edit, a new human comment, a dependency change or any default-branch commit
 * after the SHA it was recorded against (the override vouches for the whole
 * repository, so its evidence scope is "global") marks it stale, and the
 * stale issue goes back to the groomer. A later applied groom replaces the
 * baseline and so supersedes the override.
 */
import { randomUUID } from "crypto";

import { computeGroomingIssueFingerprint, dependencyKeysForIssue, parseDependencyKey, UNKNOWN_FRESHNESS } from "@/lib/groomer/freshness";

export const ADMISSION_OVERRIDE_PREFIX = "override_";
export const MAX_OVERRIDE_REASON_LENGTH = 2000;
const FULL_SHA = /^[0-9a-f]{40}$/i;

export interface OverrideIssue {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  commentsCount: number;
  repoFullName: string;
}

export interface OverrideInput {
  actor: string;
  reason?: string | null;
  headSha: string;
  defaultBranch: string;
  /** Subset of the issue's dependency keys that are open now. */
  openDependencyKeys: Set<string>;
  now: Date;
  overrideId?: string;
}

export function isValidOverrideHeadSha(value: unknown): value is string {
  return typeof value === "string" && FULL_SHA.test(value);
}

/** Dependency numbers to resolve before building the override baseline. */
export function overrideDependencyNumbers(issue: OverrideIssue): number[] {
  return dependencyKeysForIssue(issue.body, issue.repoFullName, issue.number)
    .map((key) => parseDependencyKey(key)?.number)
    .filter((n): n is number => n !== undefined);
}

/** The Issue columns an override writes: its own record plus the freshness baseline it stands in for. */
export function buildAdmissionOverrideData(issue: OverrideIssue, input: OverrideInput): Record<string, unknown> {
  const overrideId = input.overrideId ?? `${ADMISSION_OVERRIDE_PREFIX}${randomUUID()}`;
  const dependencyKeys = dependencyKeysForIssue(issue.body, issue.repoFullName, issue.number);
  const reason = input.reason?.trim() ? input.reason.trim().slice(0, MAX_OVERRIDE_REASON_LENGTH) : null;
  return {
    admissionOverrideId: overrideId,
    admissionOverrideBy: input.actor,
    admissionOverrideAt: input.now,
    admissionOverrideReason: reason,
    admissionOverrideHeadSha: input.headSha,
    groomedRunId: overrideId,
    groomedHeadSha: input.headSha,
    groomedDefaultBranch: input.defaultBranch,
    groomedIssueFingerprint: computeGroomingIssueFingerprint(issue),
    groomedCommentCount: issue.commentsCount,
    groomedEvidenceDigest: null,
    groomedEvidenceCapturedAt: input.now,
    groomedEvidenceScope: "global",
    groomedEvidencePaths: [],
    groomedDependencyKeys: dependencyKeys,
    groomedOpenBlockerKeys: dependencyKeys.filter((key) => input.openDependencyKeys.has(key)).sort(),
    groomedRelatedWork: [],
    groomingVerifiedSha: input.headSha,
    groomingStaleAt: null,
    groomingStaleReasons: [],
    groomingStaleDetail: null,
    // Same cooldown as an applied groom, so the periodic groomer does not
    // replace the override on its very next tick.
    groomedAt: input.now,
  };
}

/**
 * Columns that clear an override. When the override is still the baseline,
 * freshness returns to unknown (the groomer's freshness backfill then picks
 * the issue up); a baseline a later groom wrote is left alone.
 */
export function clearAdmissionOverrideData(issue: {
  groomedRunId: string | null;
  admissionOverrideId: string | null;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    admissionOverrideId: null,
    admissionOverrideBy: null,
    admissionOverrideAt: null,
    admissionOverrideReason: null,
    admissionOverrideHeadSha: null,
  };
  if (issue.admissionOverrideId && issue.groomedRunId === issue.admissionOverrideId) {
    const { groomingRetryAfter: _keep, ...unknown } = UNKNOWN_FRESHNESS;
    void _keep;
    Object.assign(data, unknown);
  }
  return data;
}
