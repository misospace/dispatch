import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseListLimit } from "@/lib/query-limit";
import { normalizeQueueRepo } from "@/lib/pr-fix-queue";
import type { LifecycleEventRecord } from "@/lib/issue-lifecycle-read";
import type {
  WorkAttemptPrFixItemRecord,
  WorkAttemptRunRecord,
} from "@/lib/work-attempt-chain";
import {
  aggregateDeliveryCohorts,
  COHORT_DEFINITIONS,
  deriveDeliverySample,
  type CohortGroupDimension,
  type DeliverySample,
} from "@/lib/delivery-cohorts";

/**
 * GET /api/delivery-cohorts — cohort comparison over complete claim-to-merge
 * delivery cycles (#1184).
 *
 * Builds per-work-item delivery samples from the SAME read projections the
 * per-item lifecycle contract uses (#1202/#1203/#1183): the durable
 * `IssueLifecycleEvent` stream plus the #1183 attempt chain (AgentRun
 * execution evidence and PR-fix rounds). The math is the pure
 * `@/lib/delivery-cohorts` module; this route only performs bounded reads.
 *
 * Inclusion window: a sample is included when its first claim falls inside
 * `since..until`, or when the claim is unknown and its done/merge evidence
 * falls inside the window. Unknowns stay unknown — open and unmerged items
 * are counted in totals and ages and are never folded into the duration
 * percentiles (see COHORT_DEFINITIONS).
 */

const GROUP_DIMENSIONS: readonly CohortGroupDimension[] = [
  "cohort",
  "model",
  "worker",
  "runtimeRevision",
  "reasoningEffort",
  "repository",
  "taskType",
];

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const MAX_CANDIDATE_ISSUES = 400;
const MAX_EVENTS_TOTAL = 20_000;
const MAX_RUNS_TOTAL = 20_000;
const MAX_PRFIX_ITEMS_TOTAL = 2_000;
const MAX_PRFIX_HISTORY_PER_ITEM = 100;
const DEFAULT_SAMPLE_LIMIT = 200;
const MAX_SAMPLE_LIMIT = 500;

function parseWindow(
  params: URLSearchParams,
  nowMs: number,
): { sinceMs: number; untilMs: number } | string {
  const sinceRaw = params.get("since");
  const untilRaw = params.get("until");
  const daysRaw = params.get("days");

  const untilIso = untilRaw ?? new Date(nowMs).toISOString();
  const untilMs = Date.parse(untilIso);
  if (Number.isNaN(untilMs)) return "until must be an ISO datetime";

  if (sinceRaw !== null || untilRaw !== null) {
    if (sinceRaw === null) return "since is required when until is provided";
    const sinceMs = Date.parse(sinceRaw);
    if (Number.isNaN(sinceMs)) return "since must be an ISO datetime";
    if (sinceMs >= untilMs) return "since must be before until";
    return { sinceMs, untilMs };
  }

  let days = DEFAULT_WINDOW_DAYS;
  if (daysRaw !== null) {
    const parsed = Number(daysRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_WINDOW_DAYS) {
      return `days must be an integer between 1 and ${MAX_WINDOW_DAYS}`;
    }
    days = parsed;
  }
  return { sinceMs: untilMs - days * 86400000, untilMs };
}

function toEventRecord(row: {
  kind: string;
  source: string;
  actor: string;
  agentName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  sourceEventId: string | null;
  occurredAt: Date;
  observedAt: Date;
  metadata: unknown;
}): LifecycleEventRecord {
  return {
    kind: row.kind,
    source: row.source,
    actor: row.actor,
    agentName: row.agentName,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    sourceEventId: row.sourceEventId,
    occurredAt: row.occurredAt,
    observedAt: row.observedAt,
    metadata:
      typeof row.metadata === "object" && row.metadata !== null
        ? (row.metadata as Record<string, unknown>)
        : null,
  };
}

export async function GET(request: NextRequest) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  try {
    const url = new URL(request.url);
    const params = url.searchParams;
    const nowMs = Date.now();

    const window = parseWindow(params, nowMs);
    if (typeof window === "string") {
      return errorResponse(window, 400);
    }

    const dimensionParam = params.get("groupBy") ?? "cohort";
    if (!(GROUP_DIMENSIONS as readonly string[]).includes(dimensionParam)) {
      return errorResponse(
        `groupBy must be one of: ${GROUP_DIMENSIONS.join(", ")}`,
        400,
      );
    }
    const dimension = dimensionParam as CohortGroupDimension;

    const repoParam = params.get("repo");
    const repoFilter = repoParam !== null && repoParam.trim() !== ""
      ? repoParam.trim().toLowerCase()
      : null;

    const includeSamples = params.get("includeSamples") !== "0";
    const sampleLimit = parseListLimit(params.get("limit"), DEFAULT_SAMPLE_LIMIT, MAX_SAMPLE_LIMIT);

    // Candidate issues: work items with lifecycle evidence inside the window,
    // plus items whose close evidence lands in the window without any events
    // (bounded, `distinct` on issueId, capped).
    const [eventCandidates, closedCandidates] = await Promise.all([
      prisma.issueLifecycleEvent.findMany({
        where: { occurredAt: { gte: new Date(window.sinceMs), lte: new Date(window.untilMs) } },
        distinct: ["issueId"],
        select: { issueId: true },
        // Deterministic survivor set under the cap: without an explicit order
        // the DB may keep an arbitrary subset across identical requests
        // (#1184 review), and DISTINCT forbids ordering by the non-selected
        // occurredAt, so the id order is the reproducible key.
        orderBy: [{ issueId: "asc" }],
        take: MAX_CANDIDATE_ISSUES + 1,
      }),
      prisma.issue.findMany({
        where: {
          state: "closed",
          closedAt: { gte: new Date(window.sinceMs), lte: new Date(window.untilMs) },
        },
        select: { id: true },
        orderBy: [{ closedAt: "asc" }, { id: "asc" }],
        take: MAX_CANDIDATE_ISSUES + 1,
      }),
    ]);

    const issuesTruncated =
      eventCandidates.length > MAX_CANDIDATE_ISSUES ||
      closedCandidates.length > MAX_CANDIDATE_ISSUES;

    const candidateIds = new Set<string>();
    for (const row of eventCandidates.slice(0, MAX_CANDIDATE_ISSUES)) candidateIds.add(row.issueId);
    for (const row of closedCandidates.slice(0, MAX_CANDIDATE_ISSUES)) candidateIds.add(row.id);

    const notes: string[] = [];
    notes.push(
      "Window basis: first claim inside since..until; items with an unknown claim are included when done/merge evidence falls inside the window.",
      "Duration percentiles (p50/p90, nearest-rank) cover completed items only; open and unknown-delivery items stay in sampleCount, completion-rate denominators and openAges.",
    );

    if (candidateIds.size === 0) {
      const report = aggregateDeliveryCohorts([], {
        dimension,
        windowSinceMs: window.sinceMs,
        windowUntilMs: window.untilMs,
      });
      return NextResponse.json({
        schema: "dispatch.delivery-cohorts/v1",
        definitions: COHORT_DEFINITIONS,
        window: { since: new Date(window.sinceMs).toISOString(), until: new Date(window.untilMs).toISOString() },
        groupBy: dimension,
        repo: repoFilter,
        totals: report.totals,
        cohorts: report.cohorts,
        samples: [],
        sampleCount: 0,
        truncated: issuesTruncated,
        notes,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const issueRows = await prisma.issue.findMany({
      where: { id: { in: [...candidateIds] } },
      include: { repository: true },
      // Deterministic sample order basis for no-claim ties downstream.
      orderBy: [{ id: "asc" }],
    });

    const scopedIssues = repoFilter === null
      ? issueRows
      : issueRows.filter((row) => row.repository.fullName.toLowerCase() === repoFilter);

    const scopedIds = scopedIssues.map((row) => row.id);
    const byNumber = new Map<string, Set<number>>();
    for (const row of scopedIssues) {
      const numbers = byNumber.get(row.repository.fullName) ?? new Set<number>();
      numbers.add(row.number);
      byNumber.set(row.repository.fullName, numbers);
    }

    // Bounded bulk evidence reads (same row shapes the per-item lifecycle
    // route feeds the pure projections).
    const eventsQuery = scopedIds.length > 0
      ? prisma.issueLifecycleEvent.findMany({
          where: { issueId: { in: scopedIds } },
          // Final `id` key: rows tied on both times at the cap boundary need
          // a unique tie-break or WHICH rows survive is DB-nondeterministic,
          // contradicting the reproducible-read claim (#1184 review).
          orderBy: [{ occurredAt: "asc" }, { observedAt: "asc" }, { id: "asc" }],
          take: MAX_EVENTS_TOTAL + 1,
        })
      : Promise.resolve([]);

    // PR-fix items match on the exact (normalized repo, issue number) pair,
    // folded per repository like the per-item lifecycle route does.
    const prFixQuery = byNumber.size > 0
      ? prisma.prFixQueueItem.findMany({
          where: {
            OR: [...byNumber.entries()].map(([fullName, numbers]) => ({
              repo: normalizeQueueRepo(fullName),
              issue: { in: [...numbers] },
            })),
          },
          include: {
            history: { orderBy: [{ at: "asc" }, { id: "asc" }], take: MAX_PRFIX_HISTORY_PER_ITEM + 1 },
          },
          // Deterministic survivor set under the cap (secondary id key).
          orderBy: [{ repo: "asc" }, { pr: "asc" }, { id: "asc" }],
          take: MAX_PRFIX_ITEMS_TOTAL + 1,
        })
      : Promise.resolve([]);

    const [eventRowsRaw, prFixRowsRaw] = await Promise.all([eventsQuery, prFixQuery]);

    let eventsTruncated = eventRowsRaw.length > MAX_EVENTS_TOTAL;
    const eventRows = eventsTruncated ? eventRowsRaw.slice(0, MAX_EVENTS_TOTAL) : eventRowsRaw;

    let prFixTruncated = prFixRowsRaw.length > MAX_PRFIX_ITEMS_TOTAL;
    const prFixRows = prFixTruncated ? prFixRowsRaw.slice(0, MAX_PRFIX_ITEMS_TOTAL) : prFixRowsRaw;
    // A per-item history cut at MAX_PRFIX_HISTORY_PER_ITEM is a partial read
    // too: it must reach the response-level truncated flag and notes, not
    // only the internal chain record (#1184 review).
    let prFixHistoryTruncated = false;

    // Only keep PR-fix rows whose (normalized repo, issue) really belongs to a
    // scoped issue; the OR filter across repos can over-match shared numbers.
    const scopedPairKeys = new Set<string>();
    for (const [fullName, numbers] of byNumber.entries()) {
      const normalized = normalizeQueueRepo(fullName);
      for (const n of numbers) scopedPairKeys.add(`${normalized}#${n}`);
    }
    const matchedPrFixRows = prFixRows.filter(
      (row) => row.issue !== null && scopedPairKeys.has(`${row.repo}#${row.issue}`),
    );

    const runRowsRaw = await prisma.agentRun.findMany({
      where: {
        OR: [
          { issueId: { in: scopedIds } },
          { prFixQueueItemId: { in: matchedPrFixRows.map((row) => row.id) } },
        ],
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      take: MAX_RUNS_TOTAL + 1,
      select: {
        id: true,
        issueId: true,
        agentName: true,
        runType: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        executionMetadata: true,
        prFixQueueItemId: true,
        prFixGeneration: true,
      },
    });
    let runsTruncated = runRowsRaw.length > MAX_RUNS_TOTAL;
    const runRows = runsTruncated ? runRowsRaw.slice(0, MAX_RUNS_TOTAL) : runRowsRaw;

    const eventsByIssue = new Map<string, LifecycleEventRecord[]>();
    for (const row of eventRows) {
      const list = eventsByIssue.get(row.issueId) ?? [];
      list.push(toEventRecord(row));
      eventsByIssue.set(row.issueId, list);
    }

    const runsByIssue = new Map<string, WorkAttemptRunRecord[]>();
    const runsByPrFixItem = new Map<string, WorkAttemptRunRecord[]>();
    for (const row of runRows) {
      const record: WorkAttemptRunRecord = {
        id: row.id,
        agentName: row.agentName,
        runType: row.runType,
        status: row.status,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        executionMetadata:
          typeof row.executionMetadata === "object" && row.executionMetadata !== null
            ? (row.executionMetadata as Record<string, unknown>)
            : null,
        prFixQueueItemId: row.prFixQueueItemId,
        prFixGeneration: row.prFixGeneration,
      };
      if (row.issueId) {
        const list = runsByIssue.get(row.issueId) ?? [];
        list.push(record);
        runsByIssue.set(row.issueId, list);
      }
      if (row.prFixQueueItemId) {
        const list = runsByPrFixItem.get(row.prFixQueueItemId) ?? [];
        list.push(record);
        runsByPrFixItem.set(row.prFixQueueItemId, list);
      }
    }

    const prFixByPair = new Map<string, WorkAttemptPrFixItemRecord[]>();
    for (const row of matchedPrFixRows) {
      const historyTruncated = row.history.length > MAX_PRFIX_HISTORY_PER_ITEM;
      if (historyTruncated) prFixHistoryTruncated = true;
      const list = prFixByPair.get(`${row.repo}#${row.issue}`) ?? [];
      list.push({
        id: row.id,
        repo: row.repo,
        pr: row.pr,
        issue: row.issue,
        generation: row.generation,
        fixAttempts: row.fixAttempts,
        status: row.status,
        outcome: row.outcome,
        type: row.type,
        queuedAt: row.queuedAt,
        historyTruncated,
        history: row.history.slice(0, MAX_PRFIX_HISTORY_PER_ITEM).map((entry) => ({
          id: entry.id,
          at: entry.at,
          action: entry.action,
          status: entry.status,
          outcome: entry.outcome,
          evidenceKey: entry.evidenceKey,
        })),
      });
      prFixByPair.set(`${row.repo}#${row.issue}`, list);
    }

    const samples: DeliverySample[] = [];
    for (const issueRow of scopedIssues) {
      const pairKey = `${normalizeQueueRepo(issueRow.repository.fullName)}#${issueRow.number}`;
      const itemRuns = [
        ...(runsByIssue.get(issueRow.id) ?? []),
        ...(prFixByPair.get(pairKey) ?? []).flatMap(
          (item) => runsByPrFixItem.get(item.id) ?? [],
        ),
      ];
      const sample = deriveDeliverySample(
        {
          issue: {
            repoFullName: issueRow.repository.fullName,
            issueNumber: issueRow.number,
            state: issueRow.state,
            closedAt: issueRow.closedAt,
          },
          events: eventsByIssue.get(issueRow.id) ?? [],
          runs: itemRuns,
          prFixItems: prFixByPair.get(pairKey) ?? [],
          labels: issueRow.labels,
          dbIssueId: issueRow.id,
        },
        nowMs,
      );

      // Window inclusion (#1184): first claim inside the window, or an
      // unknown claim rescued by done/merge evidence inside the window.
      const claimMs = sample.firstClaimAt !== null ? Date.parse(sample.firstClaimAt) : null;
      const doneMs = sample.doneAt !== null ? Date.parse(sample.doneAt) : null;
      const mergedMs = sample.firstMergedAt !== null ? Date.parse(sample.firstMergedAt) : null;
      const inWindow =
        (claimMs !== null && claimMs >= window.sinceMs && claimMs <= window.untilMs) ||
        (claimMs === null &&
          ((doneMs !== null && doneMs >= window.sinceMs && doneMs <= window.untilMs) ||
            (mergedMs !== null && mergedMs >= window.sinceMs && mergedMs <= window.untilMs)));
      if (inWindow) samples.push(sample);
    }

    const report = aggregateDeliveryCohorts(samples, {
      dimension,
      windowSinceMs: window.sinceMs,
      windowUntilMs: window.untilMs,
    });

    // Evidence-row truncation is surfaced by its own flags + notes below
    // (events/runs/PR-fix); it must NOT be attributed to the candidate-issue
    // read, whose cap has its own flag and note.
    notes.push(
      "Setting changes are detected per distinct value per attempt, including changes inside one attempt: a run set that restarted under a different model marks the dimension mixed and the per-attempt scalar stays the first observed value (never the setting at merge).",
      "Wait buckets (pickup, in-review, blocked, fix-queued) count only intervals with both boundaries observed from status labels, run starts, or queue rows; waiting time without such evidence (CI waiting included) stays unclassified, never attributed to a named bucket.",
    );
    if (eventsTruncated) notes.push("Event read hit its row cap; some items have partial event history.");
    if (runsTruncated) notes.push("Run read hit its row cap; some attempt chains have partial execution evidence.");
    if (prFixTruncated) notes.push("PR-fix queue read hit its row cap; some fix-round evidence is partial.");
    if (prFixHistoryTruncated) notes.push("At least one PR-fix item's status history exceeded its per-item cap; its fix-round evidence is partial.");
    if (issuesTruncated) notes.push("Candidate issue read hit its cap; the cohort covers only part of the window.");

    const orderedSamples = [...samples].sort((a, b) => {
      const aMs = a.firstClaimAt !== null ? Date.parse(a.firstClaimAt) : Number.POSITIVE_INFINITY;
      const bMs = b.firstClaimAt !== null ? Date.parse(b.firstClaimAt) : Number.POSITIVE_INFINITY;
      return aMs - bMs;
    });

    // The documented contract: truncated = ANY bounded result hit its cap.
    // The sample list cap must surface too — sampleCount stays the full
    // matched count, so a capped list must never read as complete.
    const samplesTruncated = includeSamples && orderedSamples.length > sampleLimit;
    if (samplesTruncated) {
      notes.push(
        `Sample listing hit its limit (${sampleLimit}); sampleCount is the full matched count and the cohorts aggregate every sample, only the per-item list is partial.`,
      );
    }

    return NextResponse.json({
      schema: "dispatch.delivery-cohorts/v1",
      definitions: COHORT_DEFINITIONS,
      window: {
        since: new Date(window.sinceMs).toISOString(),
        until: new Date(window.untilMs).toISOString(),
      },
      groupBy: dimension,
      repo: repoFilter,
      totals: report.totals,
      cohorts: report.cohorts,
      samples: includeSamples ? orderedSamples.slice(0, sampleLimit) : undefined,
      sampleCount: samples.length,
      truncated:
        issuesTruncated ||
        eventsTruncated ||
        runsTruncated ||
        prFixTruncated ||
        prFixHistoryTruncated ||
        samplesTruncated,
      notes,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to build delivery cohort report:", error);
    return errorResponse("Failed to build delivery cohort report", 500);
  }
}
