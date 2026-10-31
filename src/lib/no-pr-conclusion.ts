/**
 * Terminal no-PR conclusions park issue work (#1506).
 *
 * A worker that finishes an `implement` task without opening a PR can assert
 * the issue needs no PR at all (`no_changes_needed`, `already_addressed`,
 * `already_done`). Before this module that assertion carried no wire effect:
 * the reconciler kept restoring the issue to `status/ready` because it found
 * neither an open nor a merged fixing PR, and the queue re-offered the same
 * concluded work forever (misospace/courier#665).
 *
 * The park is a Dispatch-side ledger row, not a label: GitHub stays the
 * source of truth and nothing on the forge changes. It withholds the issue
 * from `buildAgentQueue`/`next-task` pickup while it is LIVE, and it is live
 * only while the issue's content fingerprint (title + body) still matches the
 * fingerprint recorded at park time. Deliberately excluded from the
 * fingerprint: status/agent labels and issue state — the reconciler's
 * in-review restore and claim churn must never end a park (that IS the loop
 * being stopped), while a human editing the title or body is exactly the
 * "issue update" that must end it.
 *
 * An operator ends a park explicitly: DELETE
 * `/api/issues/[issueId]/no-pr-conclusion`, a status set, a board move, or a
 * maintainer force-claim. A later terminal conclusion on the same issue
 * replaces the earlier park (one live park per issue).
 *
 * Rollout mode (DISPATCH_NO_PR_CONCLUSION_MODE):
 * - enforce (default): live parks withhold the issue from pickup.
 * - audit: nothing is withheld; queue items carry the decision.
 * - off: the queue behaves exactly as before this module.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { recordLifecycleEventQuietly, type LifecycleSource } from "@/lib/issue-lifecycle";

export const NO_PR_CONCLUSION_OUTCOMES = [
  "no_changes_needed",
  "already_addressed",
  "already_done",
] as const;
export type NoPrConclusionOutcome = (typeof NO_PR_CONCLUSION_OUTCOMES)[number];

export function isNoPrConclusionOutcome(outcome: string): outcome is NoPrConclusionOutcome {
  return (NO_PR_CONCLUSION_OUTCOMES as readonly string[]).includes(outcome);
}

export type NoPrConclusionMode = "off" | "audit" | "enforce";

let warnedMode: string | null = null;

/**
 * The configured rollout mode. Unset means "enforce" — the withhold is the
 * durable stop for a live re-offer loop, so silence opts IN. A recognized
 * value selects its mode; an unrecognized value warns and degrades to
 * "audit", so a typo annotates the queue instead of silently withholding
 * (or silently leaving the loop running without saying so).
 */
export function getNoPrConclusionMode(): NoPrConclusionMode {
  const raw = process.env.DISPATCH_NO_PR_CONCLUSION_MODE?.trim().toLowerCase();
  if (!raw) return "enforce";
  if (raw === "off" || raw === "audit" || raw === "enforce") return raw;
  if (warnedMode !== raw) {
    warnedMode = raw;
    console.warn(
      `[no-pr-conclusion] unrecognised DISPATCH_NO_PR_CONCLUSION_MODE="${raw}"; expected off, audit or enforce. Running audit.`,
    );
  }
  return "audit";
}

/** The Issue fields the fingerprint is computed over. */
export interface FingerprintableIssueContent {
  title: string;
  body?: string | null;
}

/**
 * sha256 over the canonical issue CONTENT (title + body). Labels and state
 * are deliberately absent — see the module header. Normalization matches the
 * grooming fingerprint (trimmed title, CRLF→LF, trailing-whitespace-stripped
 * body) so equivalent representations hash equal.
 */
export function computeConclusionContentFingerprint(issue: FingerprintableIssueContent): string {
  const canonical = {
    title: issue.title.trim(),
    body: (issue.body ?? "").replace(/\r\n/g, "\n").trimEnd(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** A live park, projected onto a queue item for diagnostics. */
export interface NoPrConclusionMark {
  agentName: string;
  outcome: string;
  at: string;
  summary: string | null;
}

export function toNoPrConclusionMark(park: {
  agentName: string;
  outcome: string;
  createdAt: Date;
  summary?: string | null;
}): NoPrConclusionMark {
  return {
    agentName: park.agentName,
    outcome: park.outcome,
    at: park.createdAt.toISOString(),
    summary: park.summary ?? null,
  };
}

/** A stored park plus the issue row it was evaluated against. */
export interface ParkEvaluableIssue extends FingerprintableIssueContent {
  id: string;
}

/**
 * A park is live when the issue content still matches what the reporting
 * worker saw. A mismatch means the issue was edited since the conclusion —
 * the park ended the moment the edit landed, and no clear call is needed.
 */
export function noPrConclusionIsLive(
  park: { contentFingerprint: string },
  issue: FingerprintableIssueContent,
): boolean {
  return park.contentFingerprint === computeConclusionContentFingerprint(issue);
}

/** The stored park row shape this module reads. */
export interface NoPrConclusionRow {
  id: string;
  issueId: string;
  agentName: string;
  outcome: string;
  contentFingerprint: string;
  createdAt: Date;
  summary: string | null;
}

interface ConclusionParkClient {
  noPrConclusion: {
    findMany: (args: { where: { issueId: { in: string[] } } }) => Promise<NoPrConclusionRow[]>;
    findUnique: (args: { where: { issueId: string } }) => Promise<NoPrConclusionRow | null>;
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<unknown>;
  };
}

/**
 * The write surface: `prisma` and `Prisma.TransactionClient` both satisfy it,
 * so a clear can commit atomically with the state change that ends the park
 * (loose method signatures, same convention as the lifecycle writer).
 */
export interface ConclusionWriteClient {
  noPrConclusion: {
    findUnique: (args: { where: { issueId: string } }) => Promise<NoPrConclusionRow | null>;
    upsert: (args: { where: { issueId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown>;
    delete: (args: { where: { issueId: string } }) => Promise<unknown>;
  };
  issueLifecycleEvent: {
    create(args: unknown): Promise<unknown>;
    upsert(args: unknown): Promise<unknown>;
  };
}

/**
 * The live parks for the given issues, keyed by issueId. Rows whose
 * fingerprint no longer matches are ended: the content moved past the
 * conclusion, so they are deleted best-effort (a failed cleanup only leaves
 * dead rows behind; it never withholds or re-offers wrongly).
 */
export async function loadLiveNoPrConclusions(
  issues: ParkEvaluableIssue[],
  client: ConclusionParkClient = prisma as unknown as ConclusionParkClient,
): Promise<Map<string, NoPrConclusionRow>> {
  const live = new Map<string, NoPrConclusionRow>();
  if (issues.length === 0) return live;
  const rows = await client.noPrConclusion.findMany({
    where: { issueId: { in: issues.map((issue) => issue.id) } },
  });
  if (rows.length === 0) return live;
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const staleIds: string[] = [];
  for (const row of rows) {
    const issue = byId.get(row.issueId);
    if (!issue) continue;
    if (noPrConclusionIsLive(row, issue)) live.set(row.issueId, row);
    else staleIds.push(row.id);
  }
  if (staleIds.length > 0) {
    try {
      await client.noPrConclusion.deleteMany({ where: { id: { in: staleIds } } });
    } catch {
      // Expired rows only cost a wasted read on the next poll; never fail the queue over cleanup.
    }
  }
  return live;
}

/**
 * The live park for one issue, or null when there is none or the content has
 * moved past it. Read-only: unlike the queue loader this never cleans up the
 * stale row — a hot-path refusal check must not write.
 */
export async function getLiveNoPrConclusion(
  issue: ParkEvaluableIssue,
  client: ConclusionParkClient = prisma as unknown as ConclusionParkClient,
): Promise<NoPrConclusionRow | null> {
  const row = await client.noPrConclusion.findUnique({ where: { issueId: issue.id } });
  if (!row) return null;
  return noPrConclusionIsLive(row, issue) ? row : null;
}

export interface RecordConclusionParkInput {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  agentName: string;
  outcome: NoPrConclusionOutcome;
  summary?: string | null;
  evidence?: string | null;
  issue: FingerprintableIssueContent;
}

/**
 * Record (or replace) the live terminal conclusion for one issue. Upsert on
 * issueId: a second conclusion overwrites the first — the latest word wins,
 * and the lifecycle stream keeps the history. The lifecycle event is quiet:
 * a report must not fail over its evidence row.
 */
export async function recordNoPrConclusion(
  input: RecordConclusionParkInput,
  client: ConclusionWriteClient = prisma as unknown as ConclusionWriteClient,
): Promise<void> {
  const contentFingerprint = computeConclusionContentFingerprint(input.issue);
  await client.noPrConclusion.upsert({
    where: { issueId: input.issueId },
    create: {
      issueId: input.issueId,
      agentName: input.agentName,
      outcome: input.outcome,
      summary: input.summary ?? null,
      evidence: input.evidence ?? null,
      contentFingerprint,
    },
    update: {
      agentName: input.agentName,
      outcome: input.outcome,
      summary: input.summary ?? null,
      evidence: input.evidence ?? null,
      contentFingerprint,
    },
  });
  await recordLifecycleEventQuietly(
    client,
    {
      issueId: input.issueId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      kind: "conclusion_parked",
      source: "agent-report",
      actor: input.agentName,
      agentName: input.agentName,
      fromStatus: null,
      toStatus: null,
      occurredAt: new Date(),
      metadata: {
        outcome: input.outcome,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.evidence ? { evidence: input.evidence } : {}),
      },
    },
    "no-pr conclusion park",
  );
}

export interface ClearConclusionParkInput {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  actor: string;
  source: LifecycleSource;
  reason?: string | null;
}

/**
 * Delete the live park for one issue, if any, and record the clearance.
 * Returns whether a park was actually removed (a no-op clearance records
 * nothing). Failures propagate — callers that must not fail over evidence
 * catch at their level.
 */
export async function clearNoPrConclusionPark(
  input: ClearConclusionParkInput,
  client: ConclusionWriteClient = prisma as unknown as ConclusionWriteClient,
): Promise<boolean> {
  const existing = await client.noPrConclusion.findUnique({
    where: { issueId: input.issueId },
  });
  if (!existing) return false;
  await client.noPrConclusion.delete({ where: { issueId: input.issueId } });
  await recordLifecycleEventQuietly(
    client,
    {
      issueId: input.issueId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      kind: "conclusion_cleared",
      source: input.source,
      actor: input.actor,
      agentName: null,
      fromStatus: null,
      toStatus: null,
      occurredAt: new Date(),
      metadata: {
        parkedBy: existing.agentName,
        parkedOutcome: existing.outcome,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    },
    "no-pr conclusion clear",
  );
  return true;
}
