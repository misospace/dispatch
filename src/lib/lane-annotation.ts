import { getUnconfiguredLaneInfo } from "@/lib/lane-config";

interface LaneAnnotatableIssue {
  currentLane?: string | null;
  state?: string;
}

export interface UnroutableLaneDisplayInfo {
  rawId: string;
}

/**
 * Attach `unroutableLane` (#1590) — a display-only annotation naming the raw
 * lane id of any issue whose `currentLane` is neither a configured lane nor
 * resolvable through a configured alias. Aliased lanes resolve to a configured
 * lane at read time and stay routable, so they are not flagged.
 *
 * The annotation is recomputed on every board/API read (never persisted), so a
 * lane-config migration surfaces on the board on day one. Detection goes
 * through `getUnconfiguredLaneInfo` so alias and unknown-lane semantics stay
 * defined in one place. Only open issues are flagged: a closed issue is Done
 * on the board regardless of its lane, and un-routability is about routable
 * work, not display of finished items.
 */
export function withUnroutableLaneAnnotations<T extends LaneAnnotatableIssue>(
  issues: T[],
): Array<T & { unroutableLane: UnroutableLaneDisplayInfo | null }> {
  return issues.map((issue) => {
    const info = issue.state === "open" ? getUnconfiguredLaneInfo(issue.currentLane) : null;
    return { ...issue, unroutableLane: info && !info.isAliased ? { rawId: info.rawId } : null };
  });
}
