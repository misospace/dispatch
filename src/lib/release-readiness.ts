/**
 * Release Readiness (dispatch#1483): a pure, deterministic ADVISORY state
 * derived from a Release Pulse snapshot, answering "worth thinking about a
 * release yet?" — without pretending to make the release decision.
 *
 * Boundaries (normative, from the issue):
 *
 * - No model call, no release mutation, no queue/admission effect. The
 *   existing release tooling (release-please) stays authoritative for
 *   versioning; nothing here infers a version bump or triggers a release.
 * - The state set is closed: `quiet`, `building`, `candidate`, `unknown`.
 * - Unknown/diverged baseline evidence yields `unknown`, never `candidate`.
 * - CI status is CONTEXT only: it may annotate the reasons, but it never
 *   erases the accumulated-release signal (this answers whether enough has
 *   accumulated, not whether the head is presently releasable).
 * - Reasons are the EXACT strings used to decide, so the UI can explain the
 *   badge verbatim. Internal/dependency/refactor work contributes only to
 *   commit volume: the pulse already emits no highlight for `internal`
 *   signals, and significance-less legacy highlights never count as a
 *   semantic "feature shipped" reason here.
 * - The policy thresholds are named constants / echoed in the output, so
 *   they can be tuned later without rewriting aggregation.
 *
 * Determinism: the derivation reads no clock and no I/O of its own — the
 * caller passes the pulse snapshot, an explicit `now`, and the CI status,
 * and the same input snapshot always produces the same state/reasons.
 */

import type { ReleasePulseSnapshot } from "./release-pulse";

export type ReleaseReadinessState = "quiet" | "building" | "candidate" | "unknown";

/** Coarse CI context; it never changes the state, only annotates reasons. */
export type ReleaseCiStatus = "green" | "running" | "failing" | "unknown";

/** Volume alone (unreleased commits >= this) makes a release reviewable. */
export const RELEASE_READINESS_VOLUME_COMMITS = 10;
/** With at least this many commits, elapsed release age can also qualify. */
export const RELEASE_READINESS_AGE_COMMITS = 5;
/** ...once the stable release is at least this many days old. */
export const RELEASE_READINESS_AGE_DAYS = 7;

const DAY_MS = 86_400_000;

export interface ReleaseReadinessInput {
  pulse: ReleasePulseSnapshot;
  /** Explicit clock (no internal `Date.now()`), for reproducibility. */
  now: Date | string | number;
  ci: ReleaseCiStatus;
}

export interface ReleaseReadiness {
  schema: "dispatch.release-readiness/v1";
  state: ReleaseReadinessState;
  /** The exact evidence strings that produced the state, decision order. */
  reasons: string[];
  /** The CI context passed in (echoed structurally, separate from reasons). */
  ci: ReleaseCiStatus;
  /** The thresholds applied, so the UI can explain the badge. */
  policy: {
    volumeCommits: number;
    ageCommits: number;
    ageDays: number;
  };
}

function parseMillis(value: Date | string | number | null): number | null {
  if (value === null) return null;
  const ms =
    value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function plural(count: number, singular: string, suffix = "s"): string {
  return `${count} ${singular}${count === 1 ? "" : suffix}`;
}

/**
 * Coarse fleet CI context from the persisted run counts. Fails toward
 * `unknown` when no run evidence exists at all; a historical failure outranks
 * an in-flight run (same bias as the `failingRuns` count the fleet view
 * already shows).
 */
export function releaseCiStatus(counts: {
  failingRuns: number;
  runningRuns: number;
  totalRuns: number;
}): ReleaseCiStatus {
  if (counts.totalRuns <= 0) return "unknown";
  if (counts.failingRuns > 0) return "failing";
  if (counts.runningRuns > 0) return "running";
  return "green";
}

function ciContextReason(ci: ReleaseCiStatus): string | null {
  if (ci === "failing") return "CI currently failing (context only)";
  if (ci === "running") return "CI currently running (context only)";
  return null;
}

function baselineEvidenceUnknownReason(pulse: ReleasePulseSnapshot): string {
  switch (pulse.unreleasedCommits.state) {
    case "no-baseline":
      return "No release baseline has been published.";
    case "diverged":
      return "Release delta is diverged; baseline comparison is unreliable.";
    case "identical":
    case "ahead":
      return "Release baseline publication time is unavailable.";
    default:
      return "Release delta comparison is unavailable.";
  }
}

function baselineLabel(pulse: ReleasePulseSnapshot): string {
  return pulse.baseline?.tag ?? "the release baseline";
}

export function deriveReleaseReadiness(input: ReleaseReadinessInput): ReleaseReadiness {
  const { pulse, ci } = input;

  const build = (state: ReleaseReadinessState, reasons: string[]): ReleaseReadiness => {
    const ciReason = ciContextReason(ci);
    return {
      schema: "dispatch.release-readiness/v1",
      state,
      reasons: ciReason === null ? reasons : [...reasons, ciReason],
      ci,
      policy: {
        volumeCommits: RELEASE_READINESS_VOLUME_COMMITS,
        ageCommits: RELEASE_READINESS_AGE_COMMITS,
        ageDays: RELEASE_READINESS_AGE_DAYS,
      },
    };
  };

  // Boundary: unknown/diverged baseline evidence → unknown, never candidate.
  if (pulse.pulseState !== "ready") {
    return build("unknown", [baselineEvidenceUnknownReason(pulse)]);
  }

  const nowMs = parseMillis(input.now);
  if (nowMs === null) {
    return build("unknown", ["Current time evidence is unavailable."]);
  }
  const baselineMs = parseMillis(pulse.baseline ? pulse.baseline.publishedAt : null);
  if (baselineMs === null) {
    // Defensive: a ready pulse always carries a parseable publication time
    // (the pulse gate guarantees it); never trust a snapshot that doesn't.
    return build("unknown", ["Release baseline publication time is unavailable."]);
  }
  if (pulse.unreleasedCommits.count === null) {
    return build("unknown", ["Unreleased commit count is unavailable."]);
  }

  const commits = pulse.unreleasedCommits.count;
  // Rule order is literal: zero commits means nothing accumulated, quiet.
  if (commits === 0) {
    return build("quiet", [`No unreleased commits since ${baselineLabel(pulse)}.`]);
  }

  const days = Math.max(0, Math.floor((nowMs - baselineMs) / DAY_MS));
  const commitReason = plural(commits, "unreleased commit");
  const ageReason = `${plural(days, "day")} since ${baselineLabel(pulse)}`;

  // Semantic milestone triggers. Only notable/major FEATURE/ARCHITECTURE
  // deliveries count: `internal`-signal issues emit no pulse highlight at
  // all, routine significance and significance-less legacy fallbacks are
  // volume evidence, not a "feature shipped" claim.
  const notableDeliveries = pulse.highlights.filter(
    (highlight) =>
      (highlight.kind === "feature" || highlight.kind === "architecture") &&
      (highlight.significance === "notable" || highlight.significance === "major"),
  ).length;
  const umbrellas = pulse.completedUmbrellaCount;

  const milestoneReasons: string[] = [];
  if (notableDeliveries > 0) milestoneReasons.push(plural(notableDeliveries, "notable delivered feature"));
  if (umbrellas > 0) milestoneReasons.push(plural(umbrellas, "completed umbrella"));

  const volumeReached = commits >= RELEASE_READINESS_VOLUME_COMMITS;
  const agedBatchReached =
    commits >= RELEASE_READINESS_AGE_COMMITS && days >= RELEASE_READINESS_AGE_DAYS;

  if (milestoneReasons.length > 0 || volumeReached || agedBatchReached) {
    // The age line is always explanatory evidence for an accumulating repo
    // (the issue's example carries it even at 5 days); the AGE RULE merely
    // decides whether it alone can trigger the state.
    return build("candidate", [commitReason, ...milestoneReasons, ageReason]);
  }

  return build("building", [commitReason, ageReason]);
}
