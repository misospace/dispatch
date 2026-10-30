/**
 * Release Pulse view model (dispatch#1484): the presentation-facing projection
 * of a `ReleasePulseSnapshot` plus its advisory `ReleaseReadiness` into the
 * short display strings the operator surfaces render verbatim.
 *
 * It stays pure and deterministic like the modules it projects: no clock, no
 * I/O, no forge or model calls — `now` is passed in by the caller. The
 * honesty rules carry over intact:
 *
 * - Zero is a value. "+0 commits" is distinct from "unknown commits", and
 *   `unknown`/`no-baseline` pulse states are distinct kinds, never folded
 *   into a quiet-looking ready view.
 * - Stale is not live. When the release delta has no recent sync evidence
 *   (`releaseDeltaSyncedAt` older than `RELEASE_PULSE_STALE_MS` or absent),
 *   the view flags `stale` so the UI shows the sync age instead of silently
 *   presenting the snapshot as current.
 */

import type { ReleasePulseSnapshot } from "./release-pulse";

export type ReleasePulseViewKind = "ready" | "unknown" | "no-release";

/** A release delta older than this is stale: shown as sync age, never as live. */
export const RELEASE_PULSE_STALE_MS = 3_600_000;

export interface ReleasePulseView {
  kind: ReleasePulseViewKind;
  tagLabel: string;
  /** Null when the pulse is not ready (there is no honest count to show). */
  commitsLabel: string | null;
  /** Null when the pulse is not ready or the baseline time is unusable. */
  ageLabel: string | null;
  /** Null when the pulse is not ready. */
  highlightsLabel: string | null;
  readinessState: "quiet" | "building" | "candidate" | "unknown";
  readinessReasons: string[];
  /** Release-delta sync evidence is missing or older than the stale window. */
  stale: boolean;
  /** Human text for the sync age, e.g. "release data from 2d ago"; null when fresh. */
  syncAgeLabel: string | null;
}

export interface ReleasePulseViewInput {
  pulse: ReleasePulseSnapshot;
  readiness: { state: string; reasons: string[] };
  releaseDeltaSyncedAt?: Date | string | null;
  now: Date | string | number;
}

const READINESS_STATES = new Set(["quiet", "building", "candidate", "unknown"]);

function parseMillis(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Whole floored days between a past publication time and `now`; null when unusable. */
export function formatReleaseAge(
  publishedAt: string | null | undefined,
  now: Date | string | number,
): string | null {
  const publishedMs = parseMillis(publishedAt);
  const nowMs = parseMillis(now);
  if (publishedMs === null || nowMs === null) return null;
  const days = Math.max(0, Math.floor((nowMs - publishedMs) / 86_400_000));
  return `${days}d`;
}

function plural(count: number, singular: string, suffix = "s"): string {
  return `${count} ${singular}${count === 1 ? "" : suffix}`;
}

/** Human sync-age label for a stale snapshot; null when fresh or age unresolvable. */
function syncAgeLabel(syncedMs: number, nowMs: number): string {
  const days = Math.max(0, Math.floor((nowMs - syncedMs) / 86_400_000));
  if (days < 1) {
    const hours = Math.max(1, Math.floor((nowMs - syncedMs) / 3_600_000));
    return `release data from ${plural(hours, "hour")} ago`;
  }
  return `release data from ${plural(days, "day")} ago`;
}

export function buildReleasePulseView(input: ReleasePulseViewInput): ReleasePulseView {
  // Defensive: a repo synced before the pulse feature shipped may carry no
  // snapshot at all — that is exactly "unknown", never a crash.
  const pulse = input.pulse ?? null;
  const readiness = input.readiness ?? { state: "unknown", reasons: [] };

  const kind: ReleasePulseViewKind =
    !pulse || pulse.pulseState === "unknown"
      ? "unknown"
      : pulse.pulseState === "no-baseline"
        ? "no-release"
        : "ready";

  const readinessState = READINESS_STATES.has(readiness.state)
    ? (readiness.state as ReleasePulseView["readinessState"])
    : "unknown";

  const nowMs = parseMillis(input.now);
  const syncedMs = parseMillis(input.releaseDeltaSyncedAt);
  // No sync evidence at all is stale: the snapshot cannot be presented as live.
  const stale = syncedMs === null || nowMs === null || nowMs - syncedMs > RELEASE_PULSE_STALE_MS;
  const syncAge =
    stale && syncedMs !== null && nowMs !== null ? syncAgeLabel(syncedMs, nowMs) : null;
  // Stale with no sync evidence at all gets its own honest copy: the age is
  // unknown, not zero.
  const syncAgeLabelValue = stale && syncedMs === null ? "release data age unknown" : syncAge;

  if (kind !== "ready") {
    return {
      kind,
      tagLabel: "none",
      commitsLabel: null,
      ageLabel: null,
      highlightsLabel: null,
      readinessState: "unknown",
      readinessReasons: readiness.reasons ?? [],
      stale,
      syncAgeLabel: syncAgeLabelValue,
    };
  }

  const count = pulse.unreleasedCommits.count;
  const commitsLabel =
    count === null ? "unknown commits" : `+${count} ${count === 1 ? "commit" : "commits"}`;

  const highlightCount = pulse.highlights.length;
  let highlightsLabel = plural(highlightCount, "highlight");
  if (pulse.completedUmbrellaCount > 0) {
    highlightsLabel += ` · ${plural(pulse.completedUmbrellaCount, "umbrella")}`;
  }

  // Tags are stored exactly as published (e.g. "v0.1.12"); render them as-is
  // — prefixing here could fabricate a tag that does not exist, and it would
  // disagree with the Releases table and the readiness reasons, which both
  // print the raw tag.
  const rawTag = pulse.baseline?.tag ?? null;
  const tagLabel = rawTag ?? "no baseline tag";

  return {
    kind,
    tagLabel,
    commitsLabel,
    ageLabel: formatReleaseAge(pulse.baseline?.publishedAt ?? null, input.now),
    highlightsLabel,
    readinessState,
    readinessReasons: readiness.reasons ?? [],
    stale,
    syncAgeLabel: syncAgeLabelValue,
  };
}

/**
 * The board strip appears only when the board is filtered to exactly one
 * repository — never on the all-repo board (#1484).
 */
export function releasePulseStripVisible(repoFilter: string | null | undefined): boolean {
  return typeof repoFilter === "string" && repoFilter.length > 0;
}
