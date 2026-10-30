/**
 * Release Pulse presentation components (dispatch#1484): thin, read-only
 * renderings of the release-pulse view model for the fleet card, the
 * single-repo board strip, and the repository detail highlights section.
 *
 * Boundaries from the issue:
 *
 * - Purely advisory: no release button, no mutation, no data fetching — every
 *   component takes its data as props, so no render path can issue forge or
 *   model calls.
 * - Readiness is text + badge, never color-only: the state word is always
 *   rendered.
 * - Unknown/stale sync state is visually distinct from a zero-commit quiet
 *   state: non-ready kinds and stale snapshots get their own copy, and a
 *   stale snapshot is presented with its sync age instead of as live.
 * - Long headlines wrap (`break-words`), they never overflow.
 */

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { ReleasePulseView } from "@/lib/release-pulse-view";
import {
  RELEASE_PULSE_MAX_HIGHLIGHTS,
  type ReleasePulseHighlight,
  type ReleasePulseSnapshot,
} from "@/lib/release-pulse";

const READINESS_WORDS: Record<ReleasePulseView["readinessState"], string> = {
  quiet: "quiet",
  building: "building",
  candidate: "candidate",
  unknown: "unknown",
};

const READINESS_VARIANTS: Record<ReleasePulseView["readinessState"], "default" | "secondary" | "outline" | "destructive"> = {
  quiet: "outline",
  building: "secondary",
  candidate: "default",
  unknown: "destructive",
};

export function ReleaseReadinessBadge({
  state,
  reasons,
}: {
  state: ReleasePulseView["readinessState"];
  reasons?: string[];
}) {
  return (
    <Badge
      variant={READINESS_VARIANTS[state]}
      title={reasons && reasons.length > 0 ? reasons.join("; ") : undefined}
      data-release-readiness={state}
    >
      {READINESS_WORDS[state]}
    </Badge>
  );
}

function SyncAgeNote({ view }: { view: ReleasePulseView }) {
  if (!view.stale || !view.syncAgeLabel) return null;
  return <span className="text-xs text-muted-foreground">{view.syncAgeLabel}</span>;
}

/** Compact per-repository pulse line for the fleet card. */
export function ReleasePulseLine({
  view,
  repoFullName,
}: {
  view: ReleasePulseView;
  repoFullName: string;
}) {
  if (view.kind !== "ready") {
    return (
      <div className="text-sm min-w-0 flex items-center gap-2 flex-wrap" data-testid={`release-pulse-${repoFullName}`}>
        <span className="text-muted-foreground shrink-0">Release:</span>
        <span className="text-muted-foreground">
          {view.kind === "no-release" ? "No release baseline" : "Release state unknown"}
        </span>
        <SyncAgeNote view={view} />
      </div>
    );
  }

  const pulseText = `${view.tagLabel} · ${view.commitsLabel}${view.ageLabel ? ` · ${view.ageLabel}` : ""} · ${view.highlightsLabel}`;
  return (
    <div className="text-sm min-w-0 flex items-center gap-2 flex-wrap" data-testid={`release-pulse-${repoFullName}`}>
      <span className="text-muted-foreground shrink-0">Release:</span>
      <span className="min-w-0 truncate" title={pulseText}>
        {pulseText}
      </span>
      <ReleaseReadinessBadge state={view.readinessState} reasons={view.readinessReasons} />
      <SyncAgeNote view={view} />
    </div>
  );
}

/** Thin advisory strip shown above the board when filtered to exactly one repo. */
export function ReleasePulseStrip({
  view,
  repoFullName,
}: {
  view: ReleasePulseView;
  repoFullName: string;
}) {
  const detailHref = `/automation/repos/${repoFullName}`;
  return (
    <Link
      href={detailHref}
      className="block border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground hover:bg-muted/50 min-w-0"
      data-testid="release-pulse-strip"
    >
      <span className="flex items-center gap-2 flex-wrap min-w-0">
        <span className="font-medium min-w-0 truncate">{repoFullName}</span>
        {view.kind === "ready" ? (
          <span className="min-w-0 truncate">
            · {view.commitsLabel} since {view.tagLabel}
            {view.ageLabel ? ` · ${view.ageLabel}` : ""} · {READINESS_WORDS[view.readinessState]}
          </span>
        ) : (
          <span className="min-w-0 truncate">
            · {view.kind === "no-release" ? "no release baseline" : "release state unknown"}
          </span>
        )}
        <SyncAgeNote view={view} />
      </span>
    </Link>
  );
}

const KIND_LABELS: Record<ReleasePulseHighlight["kind"], string> = {
  feature: "feature",
  fix: "fix",
  architecture: "architecture",
  umbrella_completed: "umbrella completed",
};

function highlightDate(iso: string | null): string {
  if (!iso) return "delivery time unknown";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "delivery time unknown" : date.toLocaleString();
}

/** Bounded "Release highlights" section for the repository detail page. */
export function ReleaseHighlightsSection({ pulse }: { pulse?: ReleasePulseSnapshot | null }) {
  // Defensive: a repo synced before the pulse feature shipped may carry no
  // snapshot — degrade to the unknown state instead of taking the page down.
  if (!pulse || pulse.pulseState !== "ready") {
    return (
      <div className="py-4">
        <p className="text-muted-foreground text-sm">
          {!pulse || pulse.pulseState === "unknown"
            ? "Release state unknown — baseline comparison unavailable."
            : "No release baseline yet — nothing to compare unreleased work against."}
        </p>
      </div>
    );
  }

  const count = pulse.unreleasedCommits.count;
  // Counts come from the producer's pre-cap totals, never `highlights.length`:
  // the exposed array is presentation-capped, so the capped window would
  // misreport the summary count. The remainder is the producer's delivered-set
  // truth: subtracting `highlightCount` from `deliveredIssueCount` would net
  // umbrella-only milestones (highlights that never were delivered issues)
  // against it. The legacy fallback clamps at zero for the same reason.
  const highlightCount = pulse.highlightCount ?? pulse.highlights.length;
  const remainder =
    pulse.deliveredWithoutHighlightCount ?? Math.max(0, pulse.deliveredIssueCount - highlightCount);

  return (
    <div className="space-y-2" data-testid="release-highlights">
      <p className="text-sm text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
        <span>
          {count === null ? "Unknown commits" : `${count} commits`} since{" "}
          {pulse.baseline?.tag ?? "the release baseline"}
        </span>
        <span>{`${highlightCount} highlight${highlightCount === 1 ? "" : "s"}`}</span>
        {pulse.completedUmbrellaCount > 0 && <span>{`${pulse.completedUmbrellaCount} completed umbrella(s)`}</span>}
        {pulse.unknownDeliveryCount > 0 && <span>{`${pulse.unknownDeliveryCount} with unknown delivery`}</span>}
      </p>
      {pulse.highlights.length === 0 ? (
        <p className="text-muted-foreground text-sm">No release highlights yet.</p>
      ) : (
        <ul className="space-y-3">
          {pulse.highlights.map((highlight) => (
            <li key={highlight.issueNumber} className="text-sm min-w-0">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <Badge variant="secondary">{KIND_LABELS[highlight.kind]}</Badge>
                {highlight.significance && (
                  <span className="text-xs text-muted-foreground">{highlight.significance}</span>
                )}
                {highlight.issueUrl ? (
                  <a
                    href={highlight.issueUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    #{highlight.issueNumber}
                  </a>
                ) : (
                  <span className="text-muted-foreground">#{highlight.issueNumber}</span>
                )}
              </div>
              <p className="break-words">{highlight.headline}</p>
              <p className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                <span>delivered {highlightDate(highlight.deliveredAt)}</span>
                <span>
                  {highlight.provenance === "groomer-release-signal"
                    ? "groomer signal"
                    : highlight.provenance === "legacy-issue-metadata"
                      ? "issue labels"
                      : "decomposition"}
                </span>
                {highlight.prs.map((pr) =>
                  pr.prUrl ? (
                    <a
                      key={pr.prNumber}
                      href={pr.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      PR #{pr.prNumber}
                    </a>
                  ) : (
                    <span key={pr.prNumber}>PR #{pr.prNumber}</span>
                  ),
                )}
              </p>
              {highlight.children && highlight.children.length > 0 && (
                <p className="text-xs text-muted-foreground flex flex-wrap gap-x-2 gap-y-1">
                  <span>children:</span>
                  {highlight.children.map((child) => (
                    <a
                      key={child.number}
                      href={child.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      #{child.number}
                    </a>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {pulse.highlightsTruncated && (
        <p className="text-xs text-muted-foreground">
          showing latest {RELEASE_PULSE_MAX_HIGHLIGHTS} of {highlightCount} highlights
        </p>
      )}
      {remainder > 0 && (
        <p className="text-xs text-muted-foreground">
          {remainder} more delivered {remainder === 1 ? "issue" : "issues"} without a semantic highlight
        </p>
      )}
    </div>
  );
}
