/**
 * Repeated blocked settlements park issue work (#1562).
 *
 * A worker that cannot proceed because of an external prerequisite settles
 * `blocked` / `waiting-external` on an `implement` task. Before this module
 * that settlement carried no wire effect on issue work: the queue re-offered
 * the same issue on the next poll, and every run repeated the same
 * verification, handoff comment, and relabel before settling the same way
 * again. One settlement is recoverable and MUST stay re-offerable — the loop
 * is only the *repetition*.
 *
 * This module counts CONSECUTIVE settlements that carry the SAME
 * missing-prerequisite descriptor for one issue. A settlement whose
 * descriptor differs resets the count: a changed prerequisite is fresh
 * information, and the first settlement after any reset behaves exactly like
 * the first ever settlement. When the count reaches the bounded threshold
 * (DISPATCH_BLOCKED_EXTERNAL_PARK_THRESHOLD, default 3, clamped 2..10) the
 * row goes LIVE and withholds the issue from `buildAgentQueue`/`next-task`
 * pickup — the same durable stop the #1506 no-PR-conclusion park uses for
 * terminal conclusions.
 *
 * The park is a Dispatch-side ledger row, not a label: GitHub stays the
 * source of truth and nothing on the forge changes. It is live only while
 * the issue's content fingerprint (title + body, same normalizer as #1506)
 * still matches the fingerprint recorded at settlement time — status churn
 * never ends a park, a human editing the issue does.
 *
 * An operator ends a park explicitly: DELETE
 * `/api/issues/[issueId]/blocked-external`, a status set, a board move, or a
 * maintainer force-claim. Fresh work on the issue (a later implement report
 * showing real progress or a terminal conclusion) also ends it.
 *
 * Rollout mode (DISPATCH_BLOCKED_EXTERNAL_PARK_MODE):
 * - enforce (default): live parks withhold the issue from pickup.
 * - audit: nothing is withheld; queue items carry the mark.
 * - off: the queue reads no park table and withholds nothing. The report hook
 *   still records settlements, like the #1506 conclusion park records in
 *   every mode, so a later switch to enforce reflects the history the
 *   operator already saw instead of parking on unseen accumulation.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { recordLifecycleEventQuietly, type LifecycleSource } from "@/lib/issue-lifecycle";
import { computeConclusionContentFingerprint, type FingerprintableIssueContent } from "@/lib/no-pr-conclusion";
import { parseExternalWaitInput } from "@/lib/pr-fix-external-wait";

/** The implement-report outcomes that carry a missing-prerequisite semantic. */
export const BLOCKED_EXTERNAL_OUTCOMES = ["blocked", "waiting-external"] as const;
export type BlockedExternalOutcome = (typeof BLOCKED_EXTERNAL_OUTCOMES)[number];

/**
 * Implement-report outcomes that represent real progress or a terminal
 * conclusion, and therefore end a stored count/park when they settle (#1562).
 * Deliberately narrow: `failed`, `handed-off`, and `capacity-exhausted` are
 * NOT fresh evidence — a failed attempt or a released capacity says nothing
 * about the prerequisite, so they change nothing.
 */
export const FRESH_WORK_OUTCOMES = [
  "pr_opened",
  "pr_updated",
  "issue_updated",
  "issue_closed",
  "no_changes_needed",
  "already_addressed",
  "already_done",
] as const;

export function isFreshWorkOutcome(outcome: string): boolean {
  return (FRESH_WORK_OUTCOMES as readonly string[]).includes(outcome);
}

export function isBlockedExternalOutcome(outcome: string): outcome is BlockedExternalOutcome {
  return (BLOCKED_EXTERNAL_OUTCOMES as readonly string[]).includes(outcome);
}

export type BlockedExternalParkMode = "off" | "audit" | "enforce";

let warnedMode: string | null = null;

/**
 * The configured rollout mode. Unset means "enforce" — the withhold is the
 * durable stop for a live re-offer loop, so silence opts IN. A recognized
 * value selects its mode; an unrecognized value warns and degrades to
 * "audit", so a typo annotates the queue instead of silently withholding
 * (or silently leaving the loop running without saying so).
 */
export function getBlockedExternalParkMode(): BlockedExternalParkMode {
  const raw = process.env.DISPATCH_BLOCKED_EXTERNAL_PARK_MODE?.trim().toLowerCase();
  if (!raw) return "enforce";
  if (raw === "off" || raw === "audit" || raw === "enforce") return raw;
  if (warnedMode !== raw) {
    warnedMode = raw;
    console.warn(
      `[blocked-external] unrecognised DISPATCH_BLOCKED_EXTERNAL_PARK_MODE="${raw}"; expected off, audit or enforce. Running audit.`,
    );
  }
  return "audit";
}

const DEFAULT_PARK_THRESHOLD = 3;
const MIN_PARK_THRESHOLD = 2;
const MAX_PARK_THRESHOLD = 10;

/**
 * Consecutive same-descriptor settlements that turn the ledger row into a
 * live park. Clamped 2..10 on purpose: a threshold of 1 would park on the
 * FIRST settlement, and the issue contract keeps one `blocked` settlement
 * recoverable and re-offerable (#1562).
 */
export function blockedExternalParkThreshold(): number {
  const n = Number(process.env.DISPATCH_BLOCKED_EXTERNAL_PARK_THRESHOLD);
  if (!Number.isInteger(n)) return DEFAULT_PARK_THRESHOLD;
  return Math.min(Math.max(n, MIN_PARK_THRESHOLD), MAX_PARK_THRESHOLD);
}

// ---------------------------------------------------------------------------
// Missing-prerequisite descriptor
// ---------------------------------------------------------------------------

/** The report fields the descriptor is derived from. */
export interface DescriptorReport {
  outcome: BlockedExternalOutcome;
  error?: string | null;
  summary?: string | null;
  externalWait?: unknown;
}

const MAX_DESCRIPTOR_LENGTH = 240;

/** Collapse whitespace runs and trim; the digest input must be run-stable. */
function normalizeFreeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function freeTextDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * The bounded missing-prerequisite descriptor for one blocked settlement.
 * Exact string equality of this value decides "same prerequisite" for the
 * consecutive count. Structured identities win over free text:
 *
 * - a `waiting-external` report whose `externalWait` parses through the
 *   #1250 bounded schema describes its dependency as `wait:<kind>:<ref>`
 *   (e.g. `wait:upstream_issue:org/repo#1482`) — deterministic across runs;
 * - everything else falls back to a short digest of the report's `error`
 *   (preferred) or `summary` text. The structured `blockReason` is
 *   deliberately NOT part of the descriptor: it is a coarse outcome class
 *   (`human_decision`, `infra_failure`, ...), not a prerequisite identity, so
 *   matching on it alone could accumulate two DIFFERENT prerequisites of the
 *   same class into one park. Free text is fragile across runs: a reworded
 *   summary simply fails to match and resets the count — the park then never
 *   forms, which degrades to today's behavior, never to a wrong park. A bare
 *   blocked report with no text at all settles to the constant `blocked:none`,
 *   so three descriptor-less blocked settlements still bound the loop.
 */
export function deriveBlockedExternalDescriptor(report: DescriptorReport): string {
  if (report.outcome === "waiting-external") {
    const parsed = parseExternalWaitInput(report.externalWait);
    if (parsed.ok) return `wait:${parsed.wait.kind}:${parsed.wait.ref}`;
  }
  // Free-text fallback: the error text wins over the summary; either may be
  // absent or whitespace-only. The digest is over the NORMALIZED text so
  // whitespace-only differences between runs still match.
  const text = normalizeFreeText(report.error ?? "") || normalizeFreeText(report.summary ?? "");
  const descriptor = text === "" ? "blocked:none" : `blocked:${freeTextDigest(text)}`;
  return descriptor.length > MAX_DESCRIPTOR_LENGTH ? descriptor.slice(0, MAX_DESCRIPTOR_LENGTH) : descriptor;
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/** The stored row shape this module reads and writes. */
export interface BlockedExternalParkRow {
  id: string;
  issueId: string;
  agentName: string;
  outcome: string;
  descriptor: string;
  consecutiveCount: number;
  summary: string | null;
  contentFingerprint: string;
  lastSettledAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A row is a live park when the issue content still matches what the
 * reporting worker saw (a mismatch means the issue was edited since the
 * settlement — fresh evidence — and the park ended) AND the consecutive
 * count has reached the threshold. A row below the threshold is a
 * mid-accumulation counter, not a park.
 */
export function blockedExternalParkIsLive(
  row: { consecutiveCount: number; contentFingerprint: string },
  issue: FingerprintableIssueContent,
  threshold: number,
): boolean {
  return (
    row.consecutiveCount >= threshold &&
    row.contentFingerprint === computeConclusionContentFingerprint(issue)
  );
}

/** A live park, projected onto a queue item for diagnostics. */
export interface BlockedExternalParkMark {
  agentName: string;
  outcome: string;
  descriptor: string;
  count: number;
  threshold: number;
  at: string;
}

export function toBlockedExternalParkMark(
  park: Pick<BlockedExternalParkRow, "agentName" | "outcome" | "descriptor" | "consecutiveCount" | "lastSettledAt">,
  threshold: number,
): BlockedExternalParkMark {
  return {
    agentName: park.agentName,
    outcome: park.outcome,
    descriptor: park.descriptor,
    count: park.consecutiveCount,
    threshold,
    at: park.lastSettledAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Clients (loose signatures, same convention as the lifecycle writer)
// ---------------------------------------------------------------------------

interface BlockedExternalParkReadClient {
  blockedExternalPark: {
    findMany: (args: { where: { issueId: { in: string[] } } }) => Promise<BlockedExternalParkRow[]>;
    findUnique: (args: { where: { issueId: string } }) => Promise<BlockedExternalParkRow | null>;
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<unknown>;
  };
}

export interface BlockedExternalParkWriteClient {
  blockedExternalPark: {
    findUnique: (args: { where: { issueId: string } }) => Promise<BlockedExternalParkRow | null>;
    upsert: (args: {
      where: { issueId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown> | Record<string, { increment: number }>;
    }) => Promise<BlockedExternalParkRow>;
    delete: (args: { where: { issueId: string } }) => Promise<unknown>;
  };
  issueLifecycleEvent: {
    create(args: unknown): Promise<unknown>;
    upsert(args: unknown): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Queue loader
// ---------------------------------------------------------------------------

/** An issue row the queue loader evaluates parks against. */
export interface ParkEvaluableIssue extends FingerprintableIssueContent {
  id: string;
}

/**
 * The live parks for the given issues, keyed by issueId. Rows whose
 * fingerprint no longer match are ended (the issue content moved past the
 * park — fresh evidence) and deleted best-effort; rows below the threshold
 * are mid-accumulation counters and are KEPT — a failed cleanup only leaves
 * a dead row behind, but deleting a counter would restart the very loop
 * this module bounds.
 */
export async function loadLiveBlockedExternalParks(
  issues: ParkEvaluableIssue[],
  threshold = blockedExternalParkThreshold(),
  client: BlockedExternalParkReadClient = prisma as unknown as BlockedExternalParkReadClient,
): Promise<Map<string, BlockedExternalParkRow>> {
  const live = new Map<string, BlockedExternalParkRow>();
  if (issues.length === 0) return live;
  const rows = await client.blockedExternalPark.findMany({
    where: { issueId: { in: issues.map((issue) => issue.id) } },
  });
  if (rows.length === 0) return live;
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const staleIds: string[] = [];
  for (const row of rows) {
    const issue = byId.get(row.issueId);
    if (!issue) continue;
    if (blockedExternalParkIsLive(row, issue, threshold)) live.set(row.issueId, row);
    else if (row.contentFingerprint !== computeConclusionContentFingerprint(issue)) staleIds.push(row.id);
  }
  if (staleIds.length > 0) {
    try {
      await client.blockedExternalPark.deleteMany({ where: { id: { in: staleIds } } });
    } catch {
      // Expired rows only cost a wasted read on the next poll; never fail the queue over cleanup.
    }
  }
  return live;
}

/**
 * The live park for one issue, or null when there is none, the count is
 * still below the threshold, or the content has moved past it. Read-only:
 * unlike the queue loader this never cleans up stale rows — a hot-path
 * refusal check must not write.
 */
export async function getLiveBlockedExternalPark(
  issue: ParkEvaluableIssue,
  threshold = blockedExternalParkThreshold(),
  client: BlockedExternalParkReadClient = prisma as unknown as BlockedExternalParkReadClient,
): Promise<BlockedExternalParkRow | null> {
  const row = await client.blockedExternalPark.findUnique({ where: { issueId: issue.id } });
  if (!row) return null;
  return blockedExternalParkIsLive(row, issue, threshold) ? row : null;
}

// ---------------------------------------------------------------------------
// Record + clear
// ---------------------------------------------------------------------------

export interface RecordBlockedExternalSettlementInput {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  agentName: string;
  outcome: BlockedExternalOutcome;
  descriptor: string;
  summary?: string | null;
  issue: FingerprintableIssueContent;
}

export interface RecordBlockedExternalSettlementResult {
  previousCount: number;
  nextCount: number;
  threshold: number;
  /** True when THIS write crossed the threshold and the park went live. */
  crossed: boolean;
}

/**
 * Record one blocked settlement for an issue. Upsert on issueId: the same
 * descriptor against UNCHANGED issue content increments the consecutive
 * count; a different descriptor OR a content edit (the recorded fingerprint
 * no longer matches what this settlement saw) resets it to 1 and replaces the
 * row's identity fields — a changed prerequisite, like an edited issue, is
 * fresh information, and the next settlement behaves like a first one. The
 * quiet `blocked_external_parked` lifecycle event records exactly once, on
 * the write that lands the row on the threshold — `crossed` is derived from
 * the POST-write count, so two concurrent settlements cannot lose the event
 * (the write that reaches the threshold fires it) or double it (the next
 * count no longer equals the threshold).
 */
export async function recordBlockedExternalSettlement(
  input: RecordBlockedExternalSettlementInput,
  client: BlockedExternalParkWriteClient = prisma as unknown as BlockedExternalParkWriteClient,
): Promise<RecordBlockedExternalSettlementResult> {
  const threshold = blockedExternalParkThreshold();
  const contentFingerprint = computeConclusionContentFingerprint(input.issue);
  const existing = await client.blockedExternalPark.findUnique({ where: { issueId: input.issueId } });
  const previousCount = existing?.consecutiveCount ?? 0;
  // The count continues only when BOTH the descriptor and the issue content
  // are unchanged since the stored row: a content edit between settlements is
  // fresh evidence and restarts the accumulation (#1562).
  const continues =
    existing !== null &&
    existing.descriptor === input.descriptor &&
    existing.contentFingerprint === contentFingerprint;
  const nextCount = continues ? previousCount + 1 : 1;
  const row = await client.blockedExternalPark.upsert({
    where: { issueId: input.issueId },
    create: {
      issueId: input.issueId,
      agentName: input.agentName,
      outcome: input.outcome,
      descriptor: input.descriptor,
      consecutiveCount: nextCount,
      summary: input.summary ?? null,
      contentFingerprint,
      lastSettledAt: new Date(),
    },
    update: continues
      ? {
          agentName: input.agentName,
          outcome: input.outcome,
          consecutiveCount: { increment: 1 },
          summary: input.summary ?? null,
          lastSettledAt: new Date(),
        }
      : {
          agentName: input.agentName,
          outcome: input.outcome,
          descriptor: input.descriptor,
          consecutiveCount: nextCount,
          summary: input.summary ?? null,
          contentFingerprint,
          lastSettledAt: new Date(),
        },
  });
  const crossed = row.consecutiveCount === threshold;
  if (crossed) {
    await recordLifecycleEventQuietly(
      client,
      {
        issueId: input.issueId,
        repoFullName: input.repoFullName,
        issueNumber: input.issueNumber,
        kind: "blocked_external_parked",
        source: "agent-report",
        actor: input.agentName,
        agentName: input.agentName,
        fromStatus: null,
        toStatus: null,
        occurredAt: new Date(),
        metadata: {
          outcome: input.outcome,
          descriptor: input.descriptor,
          count: nextCount,
          threshold,
        },
      },
      "blocked-external settlement park",
    );
  }
  return { previousCount, nextCount: row.consecutiveCount, threshold, crossed };
}

export interface ClearBlockedExternalParkInput {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  actor: string;
  source: LifecycleSource;
  reason?: string | null;
}

/**
 * Delete the stored count/park row for one issue, if any, and record the
 * clearance. Returns whether a row was actually removed (a no-op clearance
 * records nothing). Failures propagate — callers that must not fail over
 * evidence catch at their level.
 */
export async function clearBlockedExternalPark(
  input: ClearBlockedExternalParkInput,
  client: BlockedExternalParkWriteClient = prisma as unknown as BlockedExternalParkWriteClient,
): Promise<boolean> {
  const existing = await client.blockedExternalPark.findUnique({
    where: { issueId: input.issueId },
  });
  if (!existing) return false;
  await client.blockedExternalPark.delete({ where: { issueId: input.issueId } });
  await recordLifecycleEventQuietly(
    client,
    {
      issueId: input.issueId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      kind: "blocked_external_cleared",
      source: input.source,
      actor: input.actor,
      agentName: null,
      fromStatus: null,
      toStatus: null,
      occurredAt: new Date(),
      metadata: {
        parkedBy: existing.agentName,
        parkedOutcome: existing.outcome,
        parkedDescriptor: existing.descriptor,
        count: existing.consecutiveCount,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    },
    "blocked-external park clear",
  );
  return true;
}
