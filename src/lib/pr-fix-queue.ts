import { normalizePrFixLane, normalizePrFixStatus, normalizePrFixType, PrFixLane, PrFixStatus, PrFixType, PR_FIX_TYPE_PRIORITY } from "@/types";
import { surfacePrFixBlocked, surfacePrFixRequeued, extractUrlsFromText } from "./pr-fix-surfacing";
import { extractLessonFromFixOutcome } from "./lesson-feed";
import { prisma } from "@/lib/prisma";
import { fetchPullRequestMergeState, fetchPullRequestHeadSha } from "./github-prs";

export type PrFixQueueClient = {
  prFixQueueItem: {
    findUnique: (args: any) => Promise<any>;
    findMany: (args?: any) => Promise<any[]>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
  prFixHistory: {
    create: (args: any) => Promise<any>;
    findMany?: (args: any) => Promise<any[]>;
  };
  $transaction: <T>(fn: (tx: PrFixQueueClient) => Promise<T>) => Promise<T>;
};

export interface EnqueuePrFixInput {
  repo: string;
  pr: number;
  lane?: string | null;
  type?: string | null;
  reason: string;
  feedback: string;
  evidenceKey: string;
  issue?: number | null;
  branch?: string | null;
  url?: string | null;
  title?: string | null;
  headSha?: string | null;
  author?: string | null;
}

export interface MarkPrFixInput {
  repo: string;
  pr: number;
  status: string;
  note?: string | null;
}

export interface RequeuePrFixInput {
  repo: string;
  pr: number;
  note?: string | null;
  isPrMergedOrClosed?: boolean;
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseEnqueuePrFixInput(body: unknown): EnqueuePrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) return { error: "Missing required field: pr" };
  if (!nonEmpty(input.reason)) return { error: "Missing required field: reason" };
  if (!nonEmpty(input.feedback)) return { error: "Missing required field: feedback" };
  if (!nonEmpty(input.evidenceKey)) return { error: "Missing required field: evidenceKey" };

  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    lane: typeof input.lane === "string" ? input.lane : undefined,
    type: typeof input.type === "string" ? input.type : undefined,
    reason: input.reason.trim(),
    feedback: input.feedback.trim(),
    evidenceKey: input.evidenceKey.trim(),
    issue: input.issue === undefined || input.issue === null ? null : Number(input.issue),
    branch: typeof input.branch === "string" ? input.branch : null,
    url: typeof input.url === "string" ? input.url : null,
    title: typeof input.title === "string" ? input.title : null,
    headSha: typeof input.headSha === "string" ? input.headSha : null,
    author: typeof input.author === "string" ? input.author : null,
  };
}

export function parseMarkPrFixInput(body: unknown): MarkPrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) return { error: "Missing required field: pr" };
  if (!nonEmpty(input.status)) return { error: "Missing required field: status" };
  if (!normalizePrFixStatus(input.status)) return { error: "Invalid status" };
  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    status: normalizePrFixStatus(input.status) as PrFixStatus,
    note: typeof input.note === "string" ? input.note : null,
  };
}

function uniqueAppend(values: string[], value: string, maxItems: number): string[] {
  const next = values.includes(value) ? values : [...values, value];
  return next.slice(-maxItems);
}

/**
 * Build a Prisma update patch from enqueue input.
 * `issue` maps to Prisma PrFixQueueItem.issue (Int?) which stores the linked GitHub issue number.
 */
function laneLabel(lane: string | null | undefined): string {
  if (!lane) return "unknown";
  const normalized = lane.trim().toUpperCase();
  return normalized || "unknown";
}

/**
 * Build the surfacing context for a BLOCKED item from data Dispatch actually has:
 * the item's feedback (one entry per enqueue/attempt proxy — the latest is the
 * best available last-attempt context) and its history rows. All fields are
 * optional/fallback-safe so historical rows and old callers still surface
 * something useful. Never throws.
 */
export async function buildPrFixBlockedContext(
  client: PrFixQueueClient,
  item: { repo: string; pr: number; feedback?: string[] | null },
): Promise<import("./pr-fix-surfacing").PrFixSurfaceContext> {
  const context: import("./pr-fix-surfacing").PrFixSurfaceContext = {};

  const feedback = Array.isArray(item.feedback) ? item.feedback : [];
  const totalAttempts = feedback.length > 0 ? feedback.length : undefined;
  if (typeof totalAttempts === "number") context.totalAttempts = totalAttempts;

  const links: string[] = [];
  let lastAttemptSummary: string | null = null;
  let historyLoaded = false;
  for (const entry of feedback) {
    if (!entry) continue;
    lastAttemptSummary = entry;
    const urls = extractUrlsFromTextSafe(entry);
    for (const u of urls) if (!links.includes(u)) links.push(u);
  }
  if (links.length > 0) context.failingRunLinks = links;
  if (lastAttemptSummary) context.lastAttemptSummary = lastAttemptSummary;

  // Attempts grouped by lane, plus the final failure signature from the BLOCKED
  // tombstone note. Historical rows without a lane are counted under "unknown".
  try {
    if (client.prFixHistory?.findMany) {
      const history = await client.prFixHistory.findMany({
        where: { item: { repo: item.repo, pr: item.pr } },
        orderBy: { at: "desc" },
      });
      historyLoaded = true;

      const attemptsByLane: Record<string, number> = {};
      let enqueueCount = 0;
      for (const h of history) {
        if (h.action !== "enqueue") continue;
        enqueueCount += 1;
        const lane = laneLabel(h.lane);
        attemptsByLane[lane] = (attemptsByLane[lane] ?? 0) + 1;
      }
      if (enqueueCount > 0) context.totalAttempts = enqueueCount;
      if (Object.keys(attemptsByLane).length > 0) context.attemptsByLane = attemptsByLane;

      const blocked = history.find((h) => h.action === "mark" && h.status === "BLOCKED" && h.note);
      if (blocked?.note) context.finalFailureSignature = blocked.note;
    }
  } catch {
    // Failure to load history is non-fatal; we still surface with the rest.
  }

  if (!historyLoaded && typeof totalAttempts === "number") {
    context.totalAttempts = totalAttempts;
  }

  return context;
}

function extractUrlsFromTextSafe(text: string): string[] {
  try {
    return extractUrlsFromText(text);
  } catch {
    return [];
  }
}

function metadataPatch(input: EnqueuePrFixInput): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const [key, value] of Object.entries({
    issue: input.issue ?? undefined,
    branch: input.branch ?? undefined,
    url: input.url ?? undefined,
    title: input.title ?? undefined,
    headSha: input.headSha ?? undefined,
    author: input.author ?? undefined,
  })) {
    if (value !== undefined && value !== null && value !== "") patch[key] = value as string | number;
  }
  return patch;
}

export async function enqueuePrFixItem(client: PrFixQueueClient, input: EnqueuePrFixInput) {
  const lane = normalizePrFixLane(input.lane);
  const type = normalizePrFixType(input.type);
  const nextStatus: PrFixStatus = lane === "NEEDS_HUMAN" ? "BLOCKED" : "QUEUED";

  let previousStatus: PrFixStatus | undefined;
  const item = await client.$transaction(async (tx) => {
    const existing = await tx.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
    previousStatus = existing?.status;
    if (existing) {
      // Evidence this item has already recorded must not move it back to QUEUED.
      // The sync re-reads every open PR each sweep, so an event that never goes
      // away — an undismissed CHANGES_REQUESTED review, a comment — otherwise
      // resurrects the item after every resolution and dispatches a coder again
      // 15 minutes later. Observed on misospace/pinchflat#25.
      //
      // The enqueue is still recorded in history: knowing the sync re-observed
      // the evidence is useful, and it is the status flip that causes the churn.
      // New evidence flows through normally.
      //
      // One exception (#940): a `FIXED` item whose PR head hasn't moved since
      // enqueue must be reopened, because the FIXED tombstone is untrusted —
      // a workload reported success without pushing a fix. This is the safety
      // net for the case where markPrFixItem's head-SHA guard ran with
      // missing data or before this re-detection loop kicked in.
      const isKnownEvidence =
        !!input.evidenceKey && (existing.evidenceKeys ?? []).includes(input.evidenceKey);
      const headShaUnchanged =
        existing.status === "FIXED" &&
        !!existing.headSha &&
        typeof input.headSha === "string" &&
        existing.headSha === input.headSha;
      const reopenFixStale = isKnownEvidence && headShaUnchanged;

      const updated = await tx.prFixQueueItem.update({
        where: { id: existing.id },
        data: {
          lane,
          type,
          // New evidence on a stale FIXED → reopen to QUEUED so the loop
          // dispatches another fix attempt. Without the reopen we'd write
          // another `enqueue` history row against a `FIXED` tombstone and
          // strand the PR (the worked example in #940).
          status: reopenFixStale ? nextStatus : isKnownEvidence ? existing.status : nextStatus,
          reason: input.reason,
          feedback: uniqueAppend(existing.feedback ?? [], input.feedback, 12),
          evidenceKeys: uniqueAppend(existing.evidenceKeys ?? [], input.evidenceKey, 40),
          ...metadataPatch(input),
        },
      });
      const historyData: Record<string, unknown> = {
        itemId: updated.id,
        action: "enqueue",
        lane: updated.lane,
        reason: input.reason,
        evidenceKey: input.evidenceKey,
      };
      if (reopenFixStale) {
        historyData.note = `Reopened: PR head SHA unchanged since FIXED (${existing.headSha}); re-detected evidence on a no-progress tombstone (#940).`;
      }
      await tx.prFixHistory.create({ data: historyData });
      return updated;
    }

    const created = await tx.prFixQueueItem.create({
      data: {
        repo: input.repo,
        pr: input.pr,
        lane,
        type,
        status: nextStatus,
        reason: input.reason,
        feedback: [input.feedback],
        evidenceKeys: [input.evidenceKey],
        ...metadataPatch(input),
      },
    });
    await tx.prFixHistory.create({
      data: { itemId: created.id, action: "enqueue", lane: created.lane, reason: input.reason, evidenceKey: input.evidenceKey },
    });
    return created;
  });

  if (previousStatus !== "BLOCKED" && item.status === "BLOCKED") {
    const context = await buildPrFixBlockedContext(client, item);
    await surfacePrFixBlocked({ repo: input.repo, pr: input.pr, reason: item.reason, latestNote: null, context });
  }
  return item;
}

export async function listQueuedPrFixItems(client: PrFixQueueClient, options: { lane?: string | null; includeBlocked?: boolean; prioritizeByType?: boolean } = {}) {
  const lane = options.lane ? normalizePrFixLane(options.lane) : undefined;
  const status = options.includeBlocked ? { in: ["QUEUED", "BLOCKED"] } : "QUEUED";
  
  const items = await client.prFixQueueItem.findMany({
    where: { status, ...(lane ? { lane } : {}) },
  });
  
  // Sort by type priority first, then by queuedAt
  if (options.prioritizeByType !== false) {
    items.sort((a, b) => {
      const aPriority = PR_FIX_TYPE_PRIORITY[normalizePrFixType(a.type)] ?? 3;
      const bPriority = PR_FIX_TYPE_PRIORITY[normalizePrFixType(b.type)] ?? 3;
      if (aPriority !== bPriority) return aPriority - bPriority;
      // Within same type, oldest first
      return new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime();
    });
  } else {
    items.sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());
  }
  
  return items;
}

/**
 * Verify that the PR head SHA at fix-time differs from the head SHA recorded
 * at enqueue-time. Returns one of:
 *
 * - `"passed"` — current head differs from the recorded head (or both are
 *   null on a freshly re-pushed fix). The fix is real.
 * - `"no-record"` — the item has no recorded headSha (legacy rows enqueued
 *   before #940, or a non-sync enqueue). Guard cannot run; we accept.
 * - `"head-unchanged"` — recorded head equals current head. Workload
 *   reported success but pushed nothing. Caller must refuse the FIXED.
 * - `"head-unavailable"` — GitHub fetch failed or returned no headSha. Guard
 *   could not run; we accept (better than stranding).
 *
 * The `enqueuePrFixItem` path keeps `headSha` up to date; the bridge's
 * `tasks/report` path also runs through this function via `markPrFixItem`
 * so the same guard fires regardless of who called the transition.
 *
 * Best-effort by design: it does not throw. The caller decides what to do
 * with `"head-unchanged"` (roll back to QUEUED).
 */
export async function assertPrHeadMovedForFix(
  client: PrFixQueueClient,
  repo: string,
  pr: number,
  recordedHeadSha: string | null | undefined,
  note: string | null,
): Promise<"passed" | "no-record" | "head-unchanged" | "head-unavailable"> {
  // Empty record → guard cannot run. This is the legacy path: rows enqueued
  // before #940, plus any enqueue that did not pass headSha (e.g. a future
  // fixture). Don't refuse on this — the FIXED tombstone stays meaningful.
  if (!recordedHeadSha || typeof recordedHeadSha !== "string") {
    return "no-record";
  }

  let currentHeadSha: string | null;
  try {
    currentHeadSha = await fetchPullRequestHeadSha(repo, pr);
  } catch (error) {
    // GitHub unreachable or returned an error. Accept the transition rather
    // than refuse — the bridge reconcile pass will catch a stale FIXED on
    // its next sweep. Log for ops.
    console.warn(`[pr-fix-queue] head SHA check failed for ${repo}#${pr}:`, error instanceof Error ? error.message : error);
    return "head-unavailable";
  }

  if (currentHeadSha === null) {
    // GitHub returned 200 but no head.sha (unknown shape). Same as above.
    return "head-unavailable";
  }

  if (currentHeadSha === recordedHeadSha) {
    // PR head didn't move. Workload reported success without pushing anything.
    return "head-unchanged";
  }

  return "passed";
}

export async function markPrFixItem(client: PrFixQueueClient, input: MarkPrFixInput) {
  const nextStatus = normalizePrFixStatus(input.status) as PrFixStatus | null;
  if (!nextStatus) throw new Error("Invalid status");

  let previousStatus: PrFixStatus | undefined;
  let previousLane: PrFixLane | undefined;
  const item = await client.$transaction(async (tx) => {
    const existing = await tx.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
    if (!existing) return null;
    previousStatus = existing.status;
    previousLane = existing.lane;
    // Give-up: BLOCKED items always land in NEEDS_HUMAN so the existing red badge
    // actually means something and so the bridge's ACTIONABLE_LANES filter
    // continues to skip them. See bridge/prfix.py ACTIONABLE_LANES.
    const data: Record<string, unknown> = { status: nextStatus };
    if (nextStatus === "BLOCKED") {
      data.lane = "NEEDS_HUMAN";
    } else if (nextStatus === "QUEUED") {
      data.lane = "NORMAL";
    }
    const updated = await tx.prFixQueueItem.update({ where: { id: existing.id }, data });
    await tx.prFixHistory.create({
      data: { itemId: updated.id, action: "mark", status: nextStatus, lane: updated.lane, note: input.note ?? undefined },
    });
    return updated;
  });

  if (item && previousStatus !== "BLOCKED" && item.status === "BLOCKED") {
    const context = await buildPrFixBlockedContext(client, item);
    await surfacePrFixBlocked({ repo: input.repo, pr: input.pr, reason: item.reason, latestNote: input.note ?? null, context });
  }
  // Verify head SHA on the FIXED transition (#940): if a workload reports
  // success but the PR head hasn't moved, the item must NOT be marked FIXED.
  // We compare against the head SHA recorded at enqueue time. When the record
  // is missing (legacy rows enqueued before headSha was populated) or the
  // current head can't be fetched (GitHub unreachable), we accept the
  // transition — losing the guard is better than stranding the PR forever.
  if (item && previousStatus !== "FIXED" && item.status === "FIXED") {
    const headShaGuard = await assertPrHeadMovedForFix(client, input.repo, input.pr, item.headSha, input.note ?? null);
    if (headShaGuard === "head-unchanged") {
      // Refuse the tombstone: roll the item back to QUEUED so the loop
      // dispatches another fix attempt, and audit why we rejected.
      const reverted = await client.prFixQueueItem.update({
        where: { id: item.id },
        data: { status: "QUEUED", lane: "NORMAL" },
      });
      await client.prFixHistory.create({
        data: {
          itemId: reverted.id,
          action: "mark",
          status: "QUEUED",
          lane: "NORMAL",
          note: `Refused FIXED: PR head SHA unchanged since enqueue (recorded=${item.headSha ?? "null"}). Workload reported success but pushed nothing (#940).`,
        },
      });
      return reverted;
    }
  }
  // Trigger the lesson feed (#754) only on a clean transition into FIXED
  // AND only when feedback burned ≥2 attempts — the same bar the issue calls
  // out for "something non-obvious about the repo". Errors are advisory; the
  // queue item must never block on the feed.
  if (item && previousStatus !== "FIXED" && item.status === "FIXED" && (item.feedback?.length ?? 0) >= 2) {
    void extractLessonFromFixOutcome({
      repo: input.repo,
      reason: item.reason,
      feedback: item.feedback,
    }).then((outcome) => {
      if (outcome.kind === "lesson") {
        // Downstream (out of scope for this trigger-only wiring): dedupe via
        // lesson-feed.ts#lessonAlreadyCovered, then open a docs PR appending
        // under `## Learned by the loop` in the repo's AGENTS.md.
        console.info("[lesson-feed] proposed", { repo: input.repo, itemId: item.id, text: outcome.text.slice(0, 200) });
      }
    }).catch(() => { /* swallow — feed is advisory */ });
  }
  return item;
}

/**
 * Mark queued pr-fix items as stale when the upstream PR is merged or closed.
 *
 * This is a deterministic cleanup that catches the failure mode where
 * pr-followup/sync enqueues items without checking the upstream PR's state,
 * leaving merged/closed PRs in the worker queue. The data source is whatever
 * caller passes in — the issues/reconcile route already builds a
 * `mergedOrClosedPrsByRepo` map per tracked repo, so we just consume it.
 *
 * Returns counts for logging/audit. No model judgment.
 */
export async function reconcileStalePrFixItems(
  client: PrFixQueueClient,
  mergedOrClosedPrsByRepo: Map<string, Set<number>>,
  prStateByRepo: Map<string, Map<number, "merged" | "closed">>,
): Promise<{ checked: number; markedStale: number; errored: number }> {
  let checked = 0;
  let markedStale = 0;
  let errored = 0;

  for (const [repo, prNumbers] of mergedOrClosedPrsByRepo) {
    if (prNumbers.size === 0) continue;
    const staleCandidates = await client.prFixQueueItem.findMany({
      where: {
        repo,
        pr: { in: Array.from(prNumbers) },
        status: { in: ["QUEUED", "BLOCKED"] },
      },
    });
    checked += staleCandidates.length;
    for (const item of staleCandidates) {
      try {
        const state = prStateByRepo.get(repo)?.get(item.pr) ?? "merged";
        await client.$transaction(async (tx) => {
          await tx.prFixQueueItem.update({
            where: { id: item.id },
            data: { status: "STALE" },
          });
          await tx.prFixHistory.create({
            data: {
              itemId: item.id,
              action: "mark",
              status: "STALE",
              lane: item.lane,
              note: `Upstream PR state=${state} at reconcile time`,
            },
          });
        });
        markedStale++;
      } catch (err) {
        errored++;
      }
    }
  }

  return { checked, markedStale, errored };
}

export function toAgentQueuePrFixItem(item: any) {
  const fixType = normalizePrFixType(item.type);
  return {
    type: "pr-review-fix",
    fixType,
    id: item.id,
    repo: item.repo,
    pr: item.pr,
    issue: item.issue,
    branch: item.branch,
    url: item.url,
    title: item.title,
    lane: item.lane,
    status: item.status,
    reason: item.reason,
    feedback: item.feedback ?? [],
    evidenceKeys: item.evidenceKeys ?? [],
    headSha: item.headSha,
    author: item.author,
    queuedAt: item.queuedAt,
    updatedAt: item.updatedAt,
    rankingReason: `queued PR review-fix item (${fixType})`,
  };
}

/**
 * Return a BLOCKED pr-fix item to QUEUED with its attempt counter reset, so
 * the loop works it again without needing a hand-pushed commit to retrigger.
 *
 * Accepts `FIXED` items too — the FIXED tombstone is untrusted when the PR
 * head didn't move, and the previously-recommended `mark_pr_fix status=blocked
 * → requeue_pr_fix` two-call recovery required lying about the state. A single
 * honest requeue is preferable (#940).
 *
 * Refuses if the upstream PR is already merged or closed — consistent with
 * `classify_pr_lifecycle` treating those as nothing-left-to-fix. The caller
 * passes `isPrMergedOrClosed` (computed upstream) so this stays a pure db op.
 */
export async function requeuePrFixItem(client: PrFixQueueClient, input: RequeuePrFixInput) {
  if (input.isPrMergedOrClosed) {
    throw new Error("Cannot requeue: upstream PR is merged or closed");
  }

  const item = await client.$transaction(async (tx) => {
    const existing = await tx.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
    if (!existing) return null;
    // Requeue acts on both BLOCKED (the original case) and FIXED (recovery
    // from a no-progress tombstone, #940). STALE is rejected because the
    // upstream PR is gone.
    if (existing.status !== "BLOCKED" && existing.status !== "FIXED") {
      throw new Error(`Cannot requeue: item is ${existing.status}, not BLOCKED or FIXED`);
    }
    const reopenedFrom = existing.status;
    const updated = await tx.prFixQueueItem.update({
      where: { id: existing.id },
      data: { status: "QUEUED", lane: "NORMAL" },
    });
    await tx.prFixHistory.create({
      data: {
        itemId: updated.id,
        action: "requeue",
        status: "QUEUED",
        lane: "NORMAL",
        note:
          (input.note ? `${input.note} (reopened from ${reopenedFrom})` : `operator requeue from ${reopenedFrom}`) +
          (reopenedFrom === "FIXED" ? " — #940 recovery" : ""),
      },
    });
    return updated;
  });
  if (item) {
    // Best-effort cleanup: drop the needs-human label and fold the existing marker
    // comment into a concise requeued/active notice. Never blocks the requeue.
    await surfacePrFixRequeued(input.repo, input.pr, input.note ?? undefined).catch((error) => {
      console.error(`pr-fix-queue requeue cleanup error for ${input.repo}#${input.pr}:`, error);
    });
  }
  return item;
}

export function parseRequeuePrFixInput(body: unknown): RequeuePrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) return { error: "Missing required field: pr" };
  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    note: typeof input.note === "string" ? input.note : null,
    isPrMergedOrClosed: input.isPrMergedOrClosed === true,
  };
}

/**
 * Outcome shape used by `tasks/report`. Mirrors the `tasks/report` route's
 * permitted outcomes so the resolution logic does not have to inspect a raw
 * union from a foreign file.
 */
export type AgentReportOutcome =
  | "pr_opened"
  | "pr_updated"
  | "issue_updated"
  | "issue_closed"
  | "no_changes_needed"
  | "blocked"
  | "failed";

export interface ResolvePrFixFromAgentReportInput {
  repoFullName?: string | null;
  pullRequestNumber?: number | null;
  pullRequestUrl?: string | null;
  outcome: AgentReportOutcome;
  summary?: string | null;
  client?: PrFixQueueClient;
}

export interface ResolvePrFixFromAgentReportResult {
  matched: boolean;
  action: "none" | "blocked" | "fixed" | "deferred" | "skipped";
  itemId?: number | null;
  reason: string;
}

/**
 * Resolve a queued pr-fix item when an agent reports back through
 * `tasks/report`. Without this, non-bridge agents (anything driven through
 * MCP tools or the generic harness loop in AGENTS.md, e.g. pi/opencode) get
 * the pr-fix item served first, do the work, report — and the PrFixQueueItem
 * stays QUEUED, so the next poll serves it again ahead of issue work.
 *
 * Behaviour, matching the bridge's own marking:
 * - No matching item or no PR coordinates → no-op (issue-work reports pass
 *   through untouched).
 * - Outcome `blocked` → mark BLOCKED immediately. Doesn't need PR state; the
 *   agent hit a wall.
 * - Outcome `failed` → no-op. We don't synthesize BLOCKED off a generic
 *   failure — the bridge's reconcile pass still owns that decision.
 * - Anything else (pr_opened/pr_updated/issue_closed/issue_updated/
 *   no_changes_needed) is "done"-like. Verify PR merge state before marking
 *   FIXED so a red PR isn't marked fixed off unverified success — that is
 *   exactly the failure mode the bridge deliberately avoids. If the PR is
 *   not mergeable/merged/closed (e.g. CONFLICTING or unknown), do NOT mark
 *   FIXED; leave the item for the bridge's reconcile pass to settle.
 * - Idempotent: a repeat report for an already-resolved item is a no-op.
 */
export async function resolvePrFixFromAgentReport(
  input: ResolvePrFixFromAgentReportInput,
): Promise<ResolvePrFixFromAgentReportResult> {
  const repo = input.repoFullName?.trim();
  const pr =
    typeof input.pullRequestNumber === "number" && Number.isInteger(input.pullRequestNumber)
      ? input.pullRequestNumber
      : null;

  if (!repo || pr === null || pr === undefined) {
    return { matched: false, action: "none", reason: "no pr coordinates in report" };
  }

  const client = input.client ?? prisma;
  const existing = await client.prFixQueueItem.findUnique({
    where: { repo_pr: { repo, pr } },
  });
  if (!existing) {
    return { matched: false, action: "none", reason: "no matching pr-fix queue item" };
  }

  const currentStatus = normalizePrFixStatus(existing.status) as PrFixStatus | null;
  if (!currentStatus || currentStatus !== "QUEUED") {
    // Already settled (FIXED / BLOCKED / STALE). Idempotent — nothing to do.
    return {
      matched: true,
      action: "skipped",
      itemId: existing.id ?? null,
      reason: `pr-fix item already ${existing.status}`,
    };
  }

  if (input.outcome === "blocked") {
    await markPrFixItem(client as PrFixQueueClient, {
      repo,
      pr,
      status: "BLOCKED",
      note: input.summary ?? null,
    });
    return {
      matched: true,
      action: "blocked",
      itemId: existing.id ?? null,
      reason: "agent reported blocked",
    };
  }

  if (input.outcome === "failed") {
    // Don't second-guess a failure — leave the item queued for the bridge
    // reconcile pass (see reconcileStalePrFixItems / markPrFixItem callers).
    return {
      matched: true,
      action: "skipped",
      itemId: existing.id ?? null,
      reason: "agent reported failed; leaving for bridge reconcile",
    };
  }

  // "Done"-like outcomes. Gate on PR merge state so we don't mark FIXED
  // off an unverified success — the same check the bridge applies.
  try {
    const mergeState = await fetchPullRequestMergeState(repo, pr);
    if (mergeState.mergeable !== true) {
      // Either CONFLICTING, BLOCKED, unknown (null), or explicitly false.
      // Leave queued so the bridge reconcile pass can re-verify on a later
      // tick rather than us putting a tombstone on a red PR.
      return {
        matched: true,
        action: "deferred",
        itemId: existing.id ?? null,
        reason: `pr not mergeable (mergeable_state=${mergeState.mergeableState ?? "unknown"})`,
      };
    }
  } catch (error) {
    // If we can't reach GitHub, defer rather than guess — the bridge will
    // re-verify on the next reconcile pass.
    console.error(`pr-fix-queue resolve: pr merge state check failed for ${repo}#${pr}:`, error);
    return {
      matched: true,
      action: "deferred",
      itemId: existing.id ?? null,
      reason: "pr merge state check failed; leaving for bridge reconcile",
    };
  }

  await markPrFixItem(client as PrFixQueueClient, {
    repo,
    pr,
    status: "FIXED",
    note: input.summary ?? null,
  });
  return {
    matched: true,
    action: "fixed",
    itemId: existing.id ?? null,
    reason: "pr merge state verified",
  };
}
