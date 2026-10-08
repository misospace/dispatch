import { normalizePrFixLane, normalizePrFixStatus, normalizePrFixType, PrFixLane, PrFixStatus, PrFixType, PR_FIX_TYPE_PRIORITY } from "@/types";
import { surfacePrFixBlocked, surfacePrFixRequeued, surfacePrFixUnblocked, extractUrlsFromText, type PrFixUnblockOutcome } from "./pr-fix-surfacing";
import { prisma } from "@/lib/prisma";
import { fetchPullRequestMergeState, fetchPullRequestHeadSha } from "./github-prs";
import { fetchRepositoryMetadata } from "./github-code-search";

export type PrFixQueueClient = {
  issue: {
    findFirst: (args: any) => Promise<any>;
  };
  prFixQueueItem: {
    findUnique: (args: any) => Promise<any>;
    findMany: (args?: any) => Promise<any[]>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  prFixHistory: {
    create: (args: any) => Promise<any>;
    findMany?: (args: any) => Promise<any[]>;
  };
  $transaction: <T>(fn: (tx: PrFixQueueClient) => Promise<T>) => Promise<T>;
};

// #1121: upper bound on an already_addressed evidence string, shared by the
// tasks/report route and the pr-fix-queue/mark parser.
export const MAX_EVIDENCE_LENGTH = 2000;

function alreadyAddressedHistoryNote(input: MarkPrFixInput): string {
  const evidence = input.evidence?.trim();
  return [
    input.note ?? null,
    evidence ? `Evidence: ${evidence}` : null,
    evidence
      ? "Settled as already_addressed: the PR head may be unchanged; the evidence is recorded for the next review (#1121)."
      : "Settled as already_addressed: the PR head may be unchanged; no new push was expected (#1121).",
  ]
    .filter(Boolean)
    .join(" ");
}

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
  /** Item identity — should be the PR URL. Set at first enqueue, only backfilled while empty (#1098). */
  url?: string | null;
  title?: string | null;
  headSha?: string | null;
  author?: string | null;
}

export interface CreateLinkedPrFixInput {
  repo: string;
  pr: number;
  issue: number;
  lane: PrFixLane;
  reason: string;
  feedback: string[];
  evidenceKey: string;
  url?: string | null;
  title?: string | null;
  /**
   * Head observed when the linked follow-up was discovered (#1074). Stored as
   * both the mutable `headSha` and the immutable per-attempt `attemptHeadSha`
   * so the #940 no-progress guard can refuse a FIXED tombstone for a worker
   * that pushed nothing. Null when GitHub could not be read.
   */
  headSha?: string | null;
}

export interface MarkPrFixInput {
  repo: string;
  pr: number;
  status: string;
  note?: string | null;
  // Commit-time revalidation (#1074): when provided, every status write goes
  // through `updateMany({ where: { id, generation } })` and the mark is
  // skipped (no mutation) if the row's generation no longer matches — i.e.
  // the attempt was re-issued (new evidence, requeue) between read and write.
  expectedGeneration?: number | null;
  // Fresh per-attempt head baseline carried into the row when this mark bumps
  // the item back to QUEUED as a new attempt (#1074).
  attemptHeadSha?: string | null;
  // #1121: an explicit "already addressed" settlement. When true (and status is
  // FIXED), the #940 no-progress head-moved guard is bypassed and `evidence` is
  // recorded in the settlement history: the worker asserts the feedback was
  // already handled, so no new push is expected. New evidence still reopens the
  // item; a repeated disagreement reopens via #940 and counts toward fixAttempts.
  alreadyAddressed?: boolean;
  evidence?: string | null;
}

export interface RequeuePrFixInput {
  repo: string;
  pr: number;
  note?: string | null;
  isPrMergedOrClosed?: boolean;
  isRepoArchived?: boolean;
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
  if (input.generation !== undefined && input.generation !== null) {
    if (typeof input.generation !== "number" || !Number.isInteger(input.generation) || input.generation < 1) {
      return { error: "generation must be an integer >= 1" };
    }
  }
  if (input.attemptHeadSha !== undefined && input.attemptHeadSha !== null) {
    if (typeof input.attemptHeadSha !== "string" || !/^[0-9a-fA-F]{7,40}$/.test(input.attemptHeadSha.trim())) {
      return { error: "Invalid attemptHeadSha" };
    }
  }
  if (input.alreadyAddressed !== undefined && typeof input.alreadyAddressed !== "boolean") {
    return { error: "alreadyAddressed must be a boolean" };
  }
  const alreadyAddressed = input.alreadyAddressed === true;
  if (alreadyAddressed && normalizePrFixStatus(input.status) !== "FIXED") {
    return { error: "alreadyAddressed requires status FIXED" };
  }
  if (input.evidence !== undefined && input.evidence !== null && typeof input.evidence !== "string") {
    return { error: "evidence must be a string" };
  }
  const evidence = typeof input.evidence === "string" ? input.evidence.trim() : null;
  if (evidence && evidence.length > MAX_EVIDENCE_LENGTH) {
    return { error: `evidence must be at most ${MAX_EVIDENCE_LENGTH} characters` };
  }
  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    status: normalizePrFixStatus(input.status) as PrFixStatus,
    note: typeof input.note === "string" ? input.note : null,
    expectedGeneration:
      typeof input.generation === "number" && input.generation !== null ? input.generation : undefined,
    attemptHeadSha: typeof input.attemptHeadSha === "string" ? input.attemptHeadSha.trim() : null,
    ...(alreadyAddressed ? { alreadyAddressed: true } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function uniqueAppend(values: string[], value: string, maxItems: number): string[] {
  const next = values.includes(value) ? values : [...values, value];
  return next.slice(-maxItems);
}

/**
 * Append one post-dispatch evidence entry, evicting the OLDEST NON-PRIORITY
 * entry when the list would exceed `maxItems` (#1119). Priority = parsed
 * eventType is `review` / `review_comment` / `comment`: a human asking for
 * changes is actionable no matter what the PR head is, so an actionable
 * review must not be silently evicted in favor of a stale check — the exact
 * loss class #1119 exists to prevent. If every entry is priority, the
 * oldest priority entry is evicted (nothing better to drop).
 */
function appendPostDispatchEvidenceEntry(values: string[], entry: string, maxItems: number): string[] {
  const next = values.includes(entry) ? values : [...values, entry];
  if (next.length <= maxItems) return next;
  const isPriority = (value: string) => {
    const { eventType } = parsePostDispatchEvidenceEntry(value);
    return eventType === "review" || eventType === "review_comment" || eventType === "comment";
  };
  const firstNonPriority = next.findIndex((value) => !isPriority(value));
  const evictIndex = firstNonPriority === -1 ? 0 : firstNonPriority;
  return [...next.slice(0, evictIndex), ...next.slice(evictIndex + 1)];
}

/**
 * Encode one post-dispatch evidence entry as `<evidenceKey>@<head>` (#1119):
 * `head` is the enqueue input's headSha (trimmed, verbatim) when present,
 * else the literal "unknown", so a check_run entry can later be revalidated
 * against the PR's current head at settlement time.
 *
 * Exact contract, honored by `parsePostDispatchEvidenceEntry`:
 * - the entry is split on the FIRST "@": an `@` inside the headSha (an
 *   unvalidated caller string) is part of the head half, not a separator;
 * - a head that is not git-shape (4-64 hex chars) reads back as "unknown" —
 *   so an `@`-bearing headSha degrades to an unknown head, whose entry stays
 *   actionable (conservative) instead of being revalidated against a
 *   fragment of the real head;
 * - the evidenceKey namespace is internal: an `@`-bearing key is not forged
 *   into an actionable check entry, because the event type comes from the
 *   part before the FIRST "@".
 */
function encodePostDispatchEvidenceKey(evidenceKey: string, headSha: string | null | undefined): string {
  const head = typeof headSha === "string" && headSha.trim() ? headSha.trim() : "unknown";
  return `${evidenceKey}@${head}`;
}

/**
 * Parse one post-dispatch evidence entry back into { eventType, head }
 * (#1119): the entry is split on the FIRST "@" — `eventType` is the
 * substring before the FIRST ":" of the part before it, and `head` is the
 * substring after it. `head` is then sanitized to "unknown" unless it is
 * git-shape (`/^[0-9a-fA-F]{4,64}$/`): an invalid-shape head cannot be
 * revalidated, and "unknown" counts as actionable. An absent head reads
 * back as "unknown" — it was never recorded. Unknown event types are
 * non-actionable (fail-closed) in `hasActionablePostDispatchEvidence`.
 */
function parsePostDispatchEvidenceEntry(entry: string): { eventType: string; head: string } {
  const at = entry.indexOf("@");
  const keyPart = at >= 0 ? entry.slice(0, at) : entry;
  const headPart = at >= 0 ? entry.slice(at + 1) : "";
  const colon = keyPart.indexOf(":");
  const eventType = colon >= 0 ? keyPart.slice(0, colon) : keyPart;
  const head = /^[0-9a-fA-F]{4,64}$/.test(headPart) ? headPart : "unknown";
  return { eventType, head };
}

/**
 * Whether any recorded post-dispatch evidence entry is ACTIONABLE for the
 * current PR state, i.e. would justify reopening a settlement as a fresh
 * attempt (#1119, per the #1124 review):
 *
 * - review / review_comment / comment entries are actionable as-is: a human
 *   asking for changes is actionable no matter what the PR head is, so this
 *   is a short-circuit with NO GitHub call (checked first, so a mixed list
 *   with a check entry listed before the review still skips the fetch).
 * - a check_run entry is actionable only when its recorded head is "unknown"
 *   (the check ran on a head we never recorded) or equals the PR's current
 *   head (fetched ONCE, shared by all check entries). A failing check on a
 *   superseded head is stale — the worker already pushed past it. An
 *   unavailable head (fetchPullRequestHeadSha RETURNS null on unreachable
 *   GitHub / unknown shape / deleted PR, and THROWS only in genuinely
 *   unexpected cases) counts the entry as ACTIONABLE (conservative): missing
 *   a reopen silently absorbs the evidence — the exact #1119 bug class —
 *   while a false reopen is cheap, because a merged/deleted PR is reaped to
 *   STALE by the reconcile pass before a worker wastes a run on it.
 * - anything else (merge_state, merge_conflict, unknown) is not actionable.
 *
 * Empty list → false.
 */
async function hasActionablePostDispatchEvidence(
  entries: string[],
  repo: string,
  pr: number,
): Promise<boolean> {
  if (entries.length === 0) return false;

  for (const entry of entries) {
    const { eventType } = parsePostDispatchEvidenceEntry(entry);
    if (eventType === "review" || eventType === "review_comment" || eventType === "comment") {
      return true;
    }
  }

  let currentHead: string | null | undefined;
  for (const entry of entries) {
    const { eventType, head } = parsePostDispatchEvidenceEntry(entry);
    if (eventType !== "check_run") continue;
    if (head === "unknown") return true;
    if (currentHead === undefined) {
      try {
        currentHead = await fetchPullRequestHeadSha(repo, pr);
      } catch (error) {
        console.warn(`[pr-fix-queue] post-dispatch head check failed for ${repo}#${pr}:`, error instanceof Error ? error.message : error);
        return true;
      }
    }
    // null = GitHub unreachable / shape unknown / PR deleted: cannot prove
    // the recorded head is superseded, so treat as actionable (#1119).
    if (currentHead === null) return true;
    if (head === currentHead) return true;
  }
  return false;
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

/**
 * A GitHub Actions run/job URL: what the pre-#1098 ingestion stored as an
 * item URL for CI failures. Never valid item identity (#1118).
 */
const ACTIONS_RUN_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\//;

function isActionsRunUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && ACTIONS_RUN_URL.test(url);
}

/** The item URL an enqueue may write: never a CI job URL (#1098, #1118). */
function itemUrlFromInput(input: EnqueuePrFixInput): string | undefined {
  return input.url && !isActionsRunUrl(input.url) ? input.url : undefined;
}

// `url` is not part of this patch (#1098): the item URL is identity (the PR
// URL) — set at first enqueue, backfilled only while empty. A CI-failure
// re-enqueue's job URL must not flip it; job links belong in feedback/
// evidence (pr-followup-ingestion), not the item URL.
function metadataPatch(input: EnqueuePrFixInput): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const [key, value] of Object.entries({
    issue: input.issue ?? undefined,
    branch: input.branch ?? undefined,
    title: input.title ?? undefined,
    headSha: input.headSha ?? undefined,
    author: input.author ?? undefined,
  })) {
    if (value !== undefined && value !== null && value !== "") patch[key] = value as string | number;
  }
  return patch;
}

/**
 * Bound on automatic fix attempts before a REVIEW_FEEDBACK/CI item is handed to
 * a human instead of re-queued. Counts dispatchable attempts (`fixAttempts`),
 * not evidence keys: one review carries a key per inline comment, so counting
 * keys blocked a PR on first sight of a 6-comment review (#1103). Overridable
 * via PR_FIX_MAX_ATTEMPTS; defaults to 5.
 */
export function maxPrFixAttempts(): number {
  const n = Number(process.env.PR_FIX_MAX_ATTEMPTS);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

export async function enqueuePrFixItem(client: PrFixQueueClient, input: EnqueuePrFixInput) {
  const lane = normalizePrFixLane(input.lane);
  const type = normalizePrFixType(input.type);
  const nextStatus: PrFixStatus = lane === "NEEDS_HUMAN" ? "BLOCKED" : "QUEUED";

  let previousStatus: PrFixStatus | undefined;
  const item = await client.$transaction(async (tx) => {
    const existing = await tx.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
    // Deliberately the FIRST-read status: the #1134 pinned loop may re-decide
    // from fresher snapshots, and the post-transaction BLOCKED-surfacing
    // comparison keeps its pre-#1134 meaning.
    previousStatus = existing?.status;
    if (existing) {
      // buildUpdate: the per-snapshot decision + write payload. Everything the
      // write and the history row depend on is derived from ONE row snapshot,
      // so the #1134 pinned-write loop below can re-derive it from a fresh
      // read instead of replaying a stale decision.
      const buildUpdate = (snapshot: any) => {
        // Evidence this item has already recorded must not move it back to
        // QUEUED. The sync re-reads every open PR each sweep, so an event that
        // never goes away — an undismissed CHANGES_REQUESTED review, a comment
        // — otherwise resurrects the item after every resolution and dispatches
        // a coder again 15 minutes later. Observed on misospace/pinchflat#25.
        //
        // The enqueue is still recorded in history: knowing the sync re-observed
        // the evidence is useful, and it is the status flip that causes the
        // churn. New evidence flows through normally.
        //
        // One exception (#940): a `FIXED` item whose PR head hasn't moved since
        // enqueue must be reopened, because the FIXED tombstone is untrusted —
        // a workload reported success without pushing a fix. This is the safety
        // net for the case where markPrFixItem's head-SHA guard ran with
        // missing data or before this re-detection loop kicked in.
        const isKnownEvidence =
          !!input.evidenceKey && (snapshot.evidenceKeys ?? []).includes(input.evidenceKey);
        const headShaUnchanged =
          snapshot.status === "FIXED" &&
          !!snapshot.headSha &&
          typeof input.headSha === "string" &&
          snapshot.headSha === input.headSha;
        const reopenFixStale = isKnownEvidence && headShaUnchanged;

        // Terminal states are sticky. Once an item is STALE (its PR merged or
        // closed) or IGNORED, re-observed evidence must NOT resurrect it to
        // QUEUED — the only way back is an explicit requeue, which refuses
        // merged/closed PRs. Without this the per-sync reap that stales a
        // merged PR is immediately undone by the next fresh review/check event,
        // looping a coder forever on a PR that no longer exists (#1000;
        // observed on pr-reviewer-action #593/#595).
        const isTerminalStatus = snapshot.status === "STALE" || snapshot.status === "IGNORED";

        const nextEvidenceKeys = uniqueAppend(snapshot.evidenceKeys ?? [], input.evidenceKey, 40);

        let resolvedStatus: PrFixStatus;
        let resolvedLane: PrFixLane = lane;
        let statusNote: string | null = null;
        if (isTerminalStatus) {
          resolvedStatus = snapshot.status; // sticky — never resurrect a gone PR
        } else if (reopenFixStale) {
          resolvedStatus = nextStatus; // #940 recovery from a no-progress FIXED tombstone
        } else if (isKnownEvidence) {
          resolvedStatus = snapshot.status; // #25 anti-churn: repeat evidence never flips status
        } else {
          resolvedStatus = nextStatus;
        }

        // Bound the fix loop (#1001). Only a transition back to QUEUED opens a
        // new attempt — more evidence on already-QUEUED work (the rest of one
        // review's inline comments) is the same attempt and never counts
        // (#1103). Past the cap, stop re-queuing and hand the PR to a human —
        // otherwise a human CHANGES_REQUESTED that N automated fixes never
        // satisfy loops forever.
        const priorAttempts = snapshot.fixAttempts ?? 1;
        if (
          resolvedStatus === "QUEUED" &&
          snapshot.status !== "QUEUED" &&
          priorAttempts >= maxPrFixAttempts()
        ) {
          resolvedStatus = "BLOCKED";
          resolvedLane = "NEEDS_HUMAN";
          statusNote = `Bounded at ${priorAttempts} fix attempts (PR_FIX_MAX_ATTEMPTS=${maxPrFixAttempts()}); routed to a human instead of re-queuing (#1001).`;
        }

        // A transition from a non-QUEUED status back to QUEUED is a fresh
        // dispatchable attempt — new work a worker should run — so the item's
        // work-generation identity must change (#1044). Staying QUEUED (e.g.
        // additional evidence on already-pending work) is the same attempt and
        // must keep the identity stable.
        const isFreshAttempt = resolvedStatus === "QUEUED" && snapshot.status !== "QUEUED";

        // Evidence that arrives AFTER this generation was handed to a worker
        // cannot reach the worker already running on it, so record it in
        // postDispatchEvidenceKeys: settlement must open a fresh attempt
        // instead of absorbing it into the in-flight one (#1119).
        // Evidence arriving before hand-out (dispatchedGeneration !==
        // generation, or never dispatched) still joins the same attempt, as
        // before.
        const dispatchedThisGeneration =
          snapshot.dispatchedGeneration != null && snapshot.dispatchedGeneration === snapshot.generation;
        const isPostDispatchNewEvidence =
          !isTerminalStatus &&
          !isKnownEvidence &&
          snapshot.status === "QUEUED" &&
          dispatchedThisGeneration;

        const data = {
          lane: resolvedLane,
          type,
          status: resolvedStatus,
          reason: input.reason,
          feedback: uniqueAppend(snapshot.feedback ?? [], input.feedback, 12),
          evidenceKeys: nextEvidenceKeys,
          // #1098: the item URL is identity — write-once. Backfill it only
          // while empty; never overwrite an existing URL with a re-enqueue's
          // value (e.g. a CI job URL). A stored CI job URL left by the
          // pre-#1098 ingestion counts as empty, so it heals on the next
          // enqueue instead of being frozen by the guard (#1118).
          ...((!snapshot.url || isActionsRunUrl(snapshot.url)) && itemUrlFromInput(input)
            ? { url: itemUrlFromInput(input) }
            : {}),
          // A fresh attempt gets a fresh per-attempt head baseline (#1074):
          // the head the sync observed in THIS enqueue, else the last one
          // observed (#1104). metadataPatch below keeps refreshing the mutable
          // `headSha` as before — the two columns now mean different things.
          ...(isFreshAttempt
            ? {
                ...freshAttemptGeneration(),
                fixAttempts: { increment: 1 },
                attemptHeadSha: input.headSha ?? snapshot.headSha ?? null,
              }
            : {}),
          // Post-dispatch evidence (#1119): record the key that landed on a
          // dispatched QUEUED item, encoded with the enqueue's observed head
          // (or "unknown") so a check entry can be revalidated at settle time.
          // A fresh attempt resets the list. Mutually exclusive with
          // isFreshAttempt (one requires QUEUED, the other not). Past 20
          // entries appendPostDispatchEvidenceEntry evicts the oldest
          // NON-actionable entry (review/comment entries survive eviction).
          ...(isPostDispatchNewEvidence
            ? {
                postDispatchEvidenceKeys: appendPostDispatchEvidenceEntry(
                  snapshot.postDispatchEvidenceKeys ?? [],
                  encodePostDispatchEvidenceKey(input.evidenceKey, input.headSha),
                  20,
                ),
              }
            : {}),
          // A fresh attempt resets the post-dispatch list AND the per-agent
          // hand-out records: the prior generation's records are dead either
          // way, and the skip check must match only the current identity
          // (#1119, #1133).
          ...(isFreshAttempt ? { postDispatchEvidenceKeys: [], agentHandouts: [] } : {}),
          ...metadataPatch(input),
        };

        return {
          data,
          statusNote,
          reopenFixStale,
          // #1134: the append above is computed from THIS snapshot's key list,
          // so the write must be pinned on exactly that list. The
          // isFreshAttempt reset-to-[] is mutually exclusive with the append
          // and is deliberately NOT pinned.
          pinnedKeys: isPostDispatchNewEvidence ? (snapshot.postDispatchEvidenceKeys ?? []) : null,
        };
      };

      // #1134: a plain `update` computed from the read at the top of this
      // branch would clobber a concurrent post-dispatch append that commits in
      // the read→write gap — one entry escapes flagging. So when the write
      // appends post-dispatch evidence, it is pinned on the exact
      // `postDispatchEvidenceKeys` snapshot it read (mirroring markPrFixItem's
      // settle-side pin): a concurrent append in the gap misses the pin, and a
      // bounded in-transaction re-decide re-reads and re-derives EVERY decision
      // (status/lane/attempts/postDispatch) from the fresh row instead of
      // dropping the entry. No network call runs in this loop, so the #1124
      // transaction-timeout hazard does not apply.
      const maxPinnedEnqueueWrites = 3;
      let snapshot = existing;
      let decided = buildUpdate(snapshot);
      let updated: any;
      if (decided.pinnedKeys !== null) {
        let pinnedKeys: string[] = decided.pinnedKeys;
        for (let i = 0; i < maxPinnedEnqueueWrites; i += 1) {
          const { count } = await tx.prFixQueueItem.updateMany({
            where: { id: existing.id, postDispatchEvidenceKeys: { equals: pinnedKeys } },
            data: decided.data,
          });
          if (count === 1) {
            updated = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
            break;
          }
          // The pin missed: a concurrent append landed in the read→write gap (or
          // the row was deleted). Re-read in-transaction and re-decide from the
          // fresh snapshot — no decision is reused from the stale read.
          const fresh = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
          // Row deleted mid-loop: stop re-deciding; the exhausted-loop fallback
          // below runs its plain `update`, which surfaces Prisma's P2025 exactly
          // like the pre-#1134 path did for a deleted row.
          if (!fresh) break;
          snapshot = fresh;
          decided = buildUpdate(fresh);
          // Pin the retry against the FRESH key list the new write was computed
          // from, so a further gap append no-ops it the same way.
          pinnedKeys = fresh.postDispatchEvidenceKeys ?? [];
        }
        if (updated === undefined) {
          // The pin kept missing under sustained contention, or the row was
          // deleted mid-loop (then this plain `update` throws P2025, as the
          // pre-#1134 path did). Otherwise: fall back to ONE plain unpinned
          // write from the last recomputed snapshot. This degrades to the
          // pre-#1134 worst case (a concurrent entry in the final gap can
          // still be clobbered) only when the gap loses 3 writes in a row; no
          // network call runs in here, so the #1124 transaction-timeout hazard
          // does not apply.
          await tx.prFixQueueItem.update({ where: { id: existing.id }, data: decided.data });
          updated = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
        }
      } else {
        // No post-dispatch append: the write does not touch the key list, so it
        // stays a plain update, exactly as before #1134.
        updated = await tx.prFixQueueItem.update({ where: { id: existing.id }, data: decided.data });
      }

      const historyData: Record<string, unknown> = {
        itemId: updated.id,
        action: "enqueue",
        lane: updated.lane,
        reason: input.reason,
        evidenceKey: input.evidenceKey,
      };
      if (decided.reopenFixStale) {
        historyData.note = `Reopened: PR head SHA unchanged since FIXED (${snapshot.headSha}); re-detected evidence on a no-progress tombstone (#940).`;
      } else if (decided.statusNote) {
        historyData.note = decided.statusNote;
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
        // #1098: the item URL is identity (the PR URL) — set it at first
        // enqueue, explicitly, so it is never left to the update patch.
        ...(itemUrlFromInput(input) ? { url: itemUrlFromInput(input) } : {}),
        // A brand-new item is a fresh attempt: capture the head the sync
        // observed now as its immutable per-attempt baseline (#1074).
        attemptHeadSha: input.headSha ?? null,
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
  } else if (previousStatus === "BLOCKED" && item.status === "QUEUED") {
    await retractNeedsHuman(input.repo, input.pr, "requeued", "New evidence reopened this item.");
  }
  return item;
}

/**
 * Drop the needs-human label and fold the BLOCKED marker comment whenever an
 * item leaves BLOCKED. Only requeue used to do this, so an item settled FIXED
 * by a mark kept `needs-human` on an approved PR (#1105). Never throws.
 */
async function retractNeedsHuman(repo: string, pr: number, outcome: PrFixUnblockOutcome, note?: string | null) {
  await surfacePrFixUnblocked(repo, pr, outcome, note ?? undefined).catch((error) => {
    console.error(`pr-fix-queue needs-human cleanup error for ${repo}#${pr}:`, error);
  });
}

export async function createLinkedPrFixItem(
  client: PrFixQueueClient,
  input: CreateLinkedPrFixInput,
): Promise<{ item: any; created: boolean }> {
  try {
    const item = await client.$transaction(async (tx) => {
      const item = await tx.prFixQueueItem.create({
        data: {
          repo: input.repo,
          pr: input.pr,
          issue: input.issue,
          lane: input.lane,
          type: "OTHER",
          status: "QUEUED",
          reason: input.reason,
          feedback: input.feedback,
          evidenceKeys: [input.evidenceKey],
          ...(input.url ? { url: input.url } : {}),
          ...(input.title ? { title: input.title } : {}),
          headSha: input.headSha ?? null,
          attemptHeadSha: input.headSha ?? null,
        },
      });
      await tx.prFixHistory.create({
        data: {
          itemId: item.id,
          action: "enqueue",
          lane: item.lane,
          reason: input.reason,
          evidenceKey: input.evidenceKey,
          note: "Materialized from linked PR health scan.",
        },
      });
      return item;
    });
    return { item, created: true };
  } catch (error) {
    // The unique (repo, pr) constraint is the ownership boundary. If another
    // enqueue won, return its row without mutating or reopening it. A
    // transaction-level P2002 may also come from history, so only treat it as
    // the ownership race when the unique-key winner can be read back.
    if ((error as { code?: string })?.code !== "P2002") throw error;
    const item = await client.prFixQueueItem.findUnique({
      where: { repo_pr: { repo: input.repo, pr: input.pr } },
    });
    if (!item) throw error;
    return { item, created: false };
  }
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
 * Verify that the PR head SHA at fix-time differs from the per-attempt
 * baseline head. Returns one of:
 *
 * - `"passed"` — current head differs from the baseline head. The fix is
 *   real.
 * - `"no-record"` — the caller has no baseline to compare against (legacy
 *   rows, or a fresh attempt that was captured without a head record).
 *   Guard cannot run; we accept.
 * - `"head-unchanged"` — baseline equals current head. Workload reported
 *   success but pushed nothing. Caller must refuse the FIXED.
 * - `"head-unavailable"` — GitHub fetch failed or returned no headSha.
 *   Guard could not run; we accept (better than stranding).
 *
 * #1074: the baseline passed in is the immutable per-attempt
 * `attemptHeadSha` (falling back to the mutable `headSha`), captured when
 * the attempt became dispatchable — NOT the raw enqueue-time `headSha`,
 * which every re-observation overwrites and which let a worker pushing to
 * exactly the recorded SHA defeat the guard by comparison against itself.
 *
 * The `enqueuePrFixItem` path keeps both columns up to date; the
 * `tasks/report` settlement path runs through this function via
 * `markPrFixItem`, so the same guard fires regardless of who called the
 * transition.
 *
 * Best-effort by design: it does not throw. The caller decides what to do
 * with `"head-unchanged"` (refuse the FIXED before any write lands).
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

/**
 * Result of `markPrFixItem` (#1074). A mark either mutated the row
 * (`mutated: true`, with the fresh row) or was skipped without any write
 * (`mutated: false`): `not-found` when no item matches, `generation-mismatch`
 * when an `expectedGeneration` was supplied and the row's generation no
 * longer matches (the attempt was re-issued between read and write).
 */
export type MarkPrFixResult =
  | { mutated: true; item: any }
  | { mutated: false; reason: "generation-mismatch" | "not-found" };

export async function markPrFixItem(
  client: PrFixQueueClient,
  input: MarkPrFixInput,
): Promise<MarkPrFixResult> {
  const nextStatus = normalizePrFixStatus(input.status) as PrFixStatus | null;
  if (!nextStatus) throw new Error("Invalid status");

  const expectedGeneration =
    input.expectedGeneration !== undefined && input.expectedGeneration !== null
      ? input.expectedGeneration
      : undefined;

  // Load the row BEFORE any write: the #940/#1074 guard and the
  // generation-conditional writes both decide on this snapshot, and every
  // write below revalidates at commit time.
  const existing = await client.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
  if (!existing) return { mutated: false, reason: "not-found" };

  // Give-up: BLOCKED items always land in NEEDS_HUMAN so the existing red
  // badge actually means something and so the bridge's ACTIONABLE_LANES
  // filter continues to skip them. See bridge/prfix.py ACTIONABLE_LANES.
  const data: Record<string, unknown> = { status: nextStatus };

  // Reopen a settlement as a fresh attempt on post-dispatch evidence (#1119):
  // the guarded write, the cap give-up, and the history row, all inside one
  // tiny transaction the caller passes in. Pinned on the row's id, its
  // expected generation (#1074), AND the exact post-dispatch evidence
  // snapshot the actionability decision was made on — evidence recorded
  // between the actionability read and this write no-ops the reopen instead
  // of being silently cleared (#1124 review). Returns the fresh row, or null
  // when the pin misses; the caller then feeds the miss into the bounded
  // re-decision loop below. `noteSuffix` is appended to the note when the
  // reopen is taken from the settle-gap retry.
  const writeReopen = async (tx: any, row: any, noteSuffix = ""): Promise<any | null> => {
    const reopenCapped = (row.fixAttempts ?? 1) >= maxPrFixAttempts();
    const reopenData: Record<string, unknown> = reopenCapped
      ? { status: "BLOCKED", lane: "NEEDS_HUMAN", postDispatchEvidenceKeys: [] }
      : {
          status: "QUEUED",
          lane: "NORMAL",
          ...freshAttemptGeneration(),
          fixAttempts: { increment: 1 },
          attemptHeadSha: row.headSha ?? row.attemptHeadSha ?? null,
          postDispatchEvidenceKeys: [],
          // Fresh attempt: per-agent hand-out records for the consumed
          // generation must not suppress its re-dispatch (#1133).
          agentHandouts: [],
        };
    const { count } = await tx.prFixQueueItem.updateMany({
      where: {
        id: row.id,
        ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
        postDispatchEvidenceKeys: { equals: row.postDispatchEvidenceKeys ?? [] },
      },
      data: reopenData,
    });
    if (count !== 1) return null;
    await tx.prFixHistory.create({
      data: {
        itemId: row.id,
        action: "mark",
        status: reopenData.status,
        lane: reopenData.lane,
        note:
          (reopenCapped
            ? `New evidence arrived after this attempt was handed out, but bounded at ${row.fixAttempts ?? 1} fix attempts (PR_FIX_MAX_ATTEMPTS=${maxPrFixAttempts()}); routed to a human (#1119).`
            : `New evidence arrived after this attempt was handed out; reopened as a fresh attempt at the current head (#1119).`) + noteSuffix,
      },
    });
    return tx.prFixQueueItem.findUnique({ where: { id: row.id } });
  };

  const surfaceReopen = async (before: any, reopened: any) => {
    const reopenCapped = (before.fixAttempts ?? 1) >= maxPrFixAttempts();
    if (reopenCapped && before.status !== "BLOCKED") {
      const context = await buildPrFixBlockedContext(client, reopened);
      await surfacePrFixBlocked({ repo: input.repo, pr: input.pr, reason: reopened.reason, latestNote: input.note ?? null, context });
    } else if (!reopenCapped) {
      // Leaving (a would-be) settlement back to a live QUEUED attempt: make sure a
      // needs-human marker is not left behind and surface the new attempt (#1119).
      await retractNeedsHuman(input.repo, input.pr, "requeued", input.note);
    }
  };

  // A settlement (FIXED/BLOCKED) on an item whose post-dispatch evidence list
  // still holds an actionable entry must NOT absorb that evidence: reopen as a
  // fresh dispatchable attempt so a worker actually runs on it (#1119).
  // Evaluated only for settlements, so a non-settle mark never triggers a head
  // fetch. A capped item still gives up to a human, matching the other
  // fresh-attempt caps. The head fetch inside the actionability check always
  // runs OUTSIDE any transaction: Prisma's ~5s interactive-transaction
  // timeout must never have to span a GitHub round-trip (#1124 review).
  const settlesAttempt = nextStatus === "FIXED" || nextStatus === "BLOCKED";
  const reopenOnPostDispatch =
    settlesAttempt &&
    (await hasActionablePostDispatchEvidence(existing.postDispatchEvidenceKeys ?? [], input.repo, input.pr));
  // The initial reopen attempt can miss its keys/generation pin when evidence
  // is recorded between the check above and the write. That is not a
  // generation-mismatch: fall into the bounded re-decision loop below rather
  // than returning no-mutation (#1124 review).
  let reopenPinnedMissed = false;
  if (reopenOnPostDispatch) {
    const reopened = await client.$transaction(async (tx) => writeReopen(tx, existing));
    if (reopened) {
      await surfaceReopen(existing, reopened);
      return { mutated: true, item: reopened };
    }
    reopenPinnedMissed = true;
  }

  if (nextStatus === "BLOCKED") {
    data.lane = "NEEDS_HUMAN";
  } else if (nextStatus === "QUEUED") {
    data.lane = "NORMAL";
    // Marking a non-QUEUED item back to QUEUED creates a fresh dispatchable
    // attempt (same semantics as requeuePrFixItem) — bump the generation
    // alongside the status flip so the work identity changes (#1044).
    if (existing.status !== "QUEUED") {
      Object.assign(data, freshAttemptGeneration(), { fixAttempts: { increment: 1 } });
      // Baseline the fresh attempt NOW, from the caller's head or the last
      // observed one. Leaving it null let the guard fall back to the mutable
      // headSha, which the next sync overwrites with the worker's own push —
      // refusing a real fix as "pushed nothing" (#1074, #1104).
      data.attemptHeadSha = input.attemptHeadSha ?? existing.headSha ?? null;
      // A fresh attempt must not carry post-dispatch evidence recorded for a
      // prior generation (#1119), nor per-agent hand-out records whose skip
      // match must not survive the identity change (#1133).
      data.postDispatchEvidenceKeys = [];
      data.agentHandouts = [];
    }
    // QUEUED → QUEUED: leave the key list untouched — the entries still refer
    // to the current generation and must survive the mark.
  } else if (nextStatus === "STALE" || nextStatus === "IGNORED") {
    // Terminal: the recorded entries are moot; clear them (#1119).
    data.postDispatchEvidenceKeys = [];
  }

  // No-progress guard (#940, rebuilt in #1074): run it BEFORE any write,
  // against the immutable per-attempt baseline, so a refused FIXED never
  // transiently exists. Compare `attemptHeadSha` (this attempt's baseline)
  // with a fallback to the mutable `headSha` for legacy rows.
  // #1121: an explicit already-addressed settlement bypasses the guard — the
  // worker asserts the feedback was already handled, so no push is expected.
  if (nextStatus === "FIXED" && existing.status !== "FIXED" && !input.alreadyAddressed) {
    const baseline = existing.attemptHeadSha ?? existing.headSha;
    const headShaGuard = await assertPrHeadMovedForFix(client, input.repo, input.pr, baseline, input.note ?? null);
    if (headShaGuard === "head-unchanged") {
      // Refuse the tombstone: go straight to QUEUED as a fresh dispatchable
      // attempt — bump the generation in the same update so the identity a
      // worker already consumed is not silently reused (#1044) — and audit
      // why we rejected. No FIXED row is ever written.
      //
      // The refused run was a spent attempt, so it counts toward the cap;
      // past it, hand the PR to a human instead of re-running a worker that
      // keeps pushing nothing (#1103). The retry keeps the refused baseline:
      // the head is unchanged, so it is still the newest observed (#1104).
      const refusalCapped = (existing.fixAttempts ?? 1) >= maxPrFixAttempts();
      const refusalData: Record<string, unknown> = refusalCapped
        ? { status: "BLOCKED", lane: "NEEDS_HUMAN", postDispatchEvidenceKeys: [] }
        : {
            status: "QUEUED",
            lane: "NORMAL",
            ...freshAttemptGeneration(),
            fixAttempts: { increment: 1 },
            attemptHeadSha: input.attemptHeadSha ?? baseline ?? null,
            // The generation bump invalidates any recorded entries and proves
            // no stale post-dispatch list on the fresh attempt (#1119).
            postDispatchEvidenceKeys: [],
            // Same for the per-agent hand-out records (#1133).
            agentHandouts: [],
          };
      const refusal = await client.$transaction(async (tx) => {
        const { count } = await tx.prFixQueueItem.updateMany({
          where: {
            id: existing.id,
            ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
          },
          data: refusalData,
        });
        if (count !== 1) return null;
        const refusedNote = `Refused FIXED: PR head unchanged since attempt baseline (recorded=${baseline ?? "null"}). Workload reported success but pushed nothing (#940, #1074).`;
        await tx.prFixHistory.create({
          data: {
            itemId: existing.id,
            action: "mark",
            status: refusalData.status,
            lane: refusalData.lane,
            note: refusalCapped
              ? `${refusedNote} Bounded at ${existing.fixAttempts ?? 1} fix attempts (PR_FIX_MAX_ATTEMPTS=${maxPrFixAttempts()}); routed to a human instead of re-queuing (#1103).`
              : refusedNote,
          },
        });
        return tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
      });
      if (!refusal) return { mutated: false, reason: "generation-mismatch" };
      if (refusalCapped && existing.status !== "BLOCKED") {
        const context = await buildPrFixBlockedContext(client, refusal);
        await surfacePrFixBlocked({ repo: input.repo, pr: input.pr, reason: refusal.reason, latestNote: input.note ?? null, context });
      } else if (!refusalCapped && existing.status === "BLOCKED") {
        await retractNeedsHuman(input.repo, input.pr, "requeued", input.note);
      }
      return { mutated: true, item: refusal };
    }
  }

  // Shared tail for every successful mark write — settlement and non-settle
  // marks alike.
  const finishMarked = async (row: any): Promise<MarkPrFixResult> => {
    // Only surface a blocked notification when THIS mark is what first puts
    // the item into BLOCKED (from a non-BLOCKED status).
    if (nextStatus === "BLOCKED" && existing.status !== "BLOCKED") {
      const context = await buildPrFixBlockedContext(client, row);
      await surfacePrFixBlocked({ repo: input.repo, pr: input.pr, reason: row.reason, latestNote: input.note ?? null, context });
    } else if (existing.status === "BLOCKED" && (nextStatus === "QUEUED" || nextStatus === "FIXED")) {
      await retractNeedsHuman(input.repo, input.pr, nextStatus === "FIXED" ? "resolved" : "requeued", input.note);
    }
    return { mutated: true, item: row };
  };

  // Fast path: one tiny transaction holding ONLY the guarded settlement
  // write, its history row, and the post-write read — no network call may
  // run in here (#1124 review).
  // #1074: with an expected generation, the status write is conditional on
  // the row still being at that generation — commit-time revalidation. A
  // concurrent re-issue (new evidence, requeue) moves the generation and
  // makes this write a no-op; the history row is skipped too.
  // #1119: for a settlement the write additionally requires the
  // post-dispatch evidence list to be empty — evidence landing in the
  // read→write gap no-ops the settlement (count !== 1) instead of being
  // silently absorbed into it. The keys-clear is deliberately NOT in
  // `data`: it would let a stale write clobber a concurrently recorded
  // entry. Unqualified marks take the same guarded updateMany path (no
  // generation clause) so the settle-gap guard applies to them too.
  if (!reopenPinnedMissed) {
    const settledRow = await client.$transaction(async (tx) => {
      const settleWhere: Record<string, unknown> = {
        id: existing.id,
        ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
        ...(settlesAttempt ? { postDispatchEvidenceKeys: { equals: [] } } : {}),
      };
      const { count } = await tx.prFixQueueItem.updateMany({ where: settleWhere, data });
      if (count !== 1) return null;
      const row = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
      await tx.prFixHistory.create({
        data: { itemId: row.id, action: "mark", status: nextStatus, lane: row.lane, note: input.alreadyAddressed ? alreadyAddressedHistoryNote(input) : input.note ?? undefined },
      });
      return row;
    });
    if (settledRow) return finishMarked(settledRow);
    // Rare miss on a non-settle mark: the row was deleted, or its generation
    // moved between the decision read and the write. Re-read to distinguish —
    // a gone row is not-found (mirrors the forced tail's labeling a few lines
    // below); a surviving row is a generation-mismatch.
    if (!settlesAttempt) {
      const remaining = await client.prFixQueueItem.findUnique({ where: { id: existing.id } });
      return { mutated: false, reason: remaining ? "generation-mismatch" : "not-found" };
    }
  }

  // The guarded write no-oped (or the initial reopen missed its pin): the row
  // moved between the decision read and the write. Bounded re-decision loop
  // (#1124 review): re-read and re-check actionability OUTSIDE any
  // transaction — the head fetch inside hasActionablePostDispatchEvidence
  // must never run while a transaction holds a pool connection — then
  // attempt a keys-pinned reopen or settle write in a tiny transaction. A
  // pinned write that misses means evidence landed AGAIN during the head
  // fetch; loop (bounded) and retry against the fresh row.
  const maxSettleRedecisions = 3;
  let lastFresh = existing;
  for (let i = 0; i < maxSettleRedecisions; i++) {
    const fresh = await client.prFixQueueItem.findUnique({ where: { id: existing.id } });
    if (!fresh) return { mutated: false, reason: "not-found" };
    if (expectedGeneration !== undefined && fresh.generation !== expectedGeneration) {
      // A genuine stale token: the attempt was re-issued (new evidence,
      // requeue) and owns the row now — skipping is correct, not a strand.
      return { mutated: false, reason: "generation-mismatch" };
    }
    lastFresh = fresh;
    const freshKeys: string[] = fresh.postDispatchEvidenceKeys ?? [];
    if (await hasActionablePostDispatchEvidence(freshKeys, input.repo, input.pr)) {
      const reopened = await client.$transaction(async (tx) =>
        writeReopen(tx, fresh, " Post-dispatch evidence landed while this settlement was in flight."),
      );
      if (reopened) {
        await surfaceReopen(fresh, reopened);
        return { mutated: true, item: reopened };
      }
      continue;
    }
    // The recorded entries no longer apply (intermediate head): settle
    // normally, clear them, and say so in the history (#1119). The write is
    // pinned to the exact keys snapshot this no-reopen decision was made on,
    // so an entry landing during the head fetch above no-ops the write
    // instead of being cleared and absorbed.
    const clearedRow = await client.$transaction(async (tx) => {
      const { count } = await tx.prFixQueueItem.updateMany({
        where: {
          id: fresh.id,
          ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
          postDispatchEvidenceKeys: { equals: freshKeys },
        },
        data: { ...data, postDispatchEvidenceKeys: [] },
      });
      if (count !== 1) return null;
      const row = await tx.prFixQueueItem.findUnique({ where: { id: fresh.id } });
      await tx.prFixHistory.create({
        data: {
          itemId: row.id,
          action: "mark",
          status: nextStatus,
          lane: row.lane,
          note: [
            input.alreadyAddressed ? alreadyAddressedHistoryNote(input) : input.note,
            "Recorded post-dispatch evidence no longer applies (intermediate head); cleared (#1119).",
          ]
            .filter(Boolean)
            .join(" "),
        },
      });
      return row;
    });
    if (clearedRow) return finishMarked(clearedRow);
  }

  // The loop exhausted: the pinned writes kept losing the race to evidence
  // that keeps landing. Never return no-mutation for a settle mark merely
  // because of that — the item would stay QUEUED at the generation the
  // worker already consumed, next-task would keep handing the spent
  // generation first to the deduping worker, and the lane would starve
  // (#1124 review). Force a fresh attempt (or, past the cap, a human
  // hand-off): pinned on id (+ the generation when the token defines one)
  // WITHOUT the keys pin, so racing evidence cannot block it.
  const forceCapped = (lastFresh.fixAttempts ?? 1) >= maxPrFixAttempts();
  const forceData: Record<string, unknown> = forceCapped
    ? { status: "BLOCKED", lane: "NEEDS_HUMAN", postDispatchEvidenceKeys: [] }
    : {
        status: "QUEUED",
        lane: "NORMAL",
        ...freshAttemptGeneration(),
        fixAttempts: { increment: 1 },
        attemptHeadSha: lastFresh.headSha ?? lastFresh.attemptHeadSha ?? null,
        postDispatchEvidenceKeys: [],
        // Fresh attempt: per-agent hand-out records for the consumed
        // generation must not suppress its re-dispatch (#1133).
        agentHandouts: [],
      };
  const forced = await client.$transaction(async (tx) => {
    const { count } = await tx.prFixQueueItem.updateMany({
      where: {
        id: existing.id,
        ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
      },
      data: forceData,
    });
    if (count !== 1) return null;
    await tx.prFixHistory.create({
      data: {
        itemId: existing.id,
        action: "mark",
        status: forceData.status,
        lane: forceData.lane,
        // Preserve the caller's note alongside the canned forced-fallback text
        // (same join style as the stale-clear settle branch).
        note: [
          input.note,
          forceCapped
            ? `Post-dispatch evidence kept landing while this settlement was in flight, but bounded at ${lastFresh.fixAttempts ?? 1} fix attempts (PR_FIX_MAX_ATTEMPTS=${maxPrFixAttempts()}); routed to a human (#1119).`
            : `Post-dispatch evidence kept landing while this settlement was in flight; forced a fresh attempt so the racing evidence is not absorbed (#1119).`,
        ]
          .filter(Boolean)
          .join(" "),
      },
    });
    return tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
  });
  if (!forced) {
    // The row is gone or its generation moved even against the unkeyed pin:
    // a concurrent re-issue (or delete) owns the item now — the
    // stale-token skip applies.
    const remaining = await client.prFixQueueItem.findUnique({ where: { id: existing.id } });
    return { mutated: false, reason: remaining ? "generation-mismatch" : "not-found" };
  }
  await surfaceReopen(lastFresh, forced);
  return { mutated: true, item: forced };
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

/**
 * Whether a repo is archived, for the archived-repo guards (#1106). Fails open
 * (false) when GitHub can't answer: refusing or reaping on a lookup failure
 * would strand work that is fine.
 */
export async function isPrFixRepoArchived(repo: string): Promise<boolean> {
  try {
    return (await fetchRepositoryMetadata(repo)).archived === true;
  } catch (error) {
    console.warn(`[pr-fix-queue] archived check failed for ${repo}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Mark QUEUED/BLOCKED pr-fix items STALE when their repo is archived (#1106).
 * Nothing can push to an archived repo, so a dispatched worker can only fail;
 * observed on misospace/llmkube-images#436. Works from the items themselves,
 * not the tracked-repo list, so a repo dropped from tracking still gets
 * reaped. One lookup per distinct repo with active items.
 */
export async function reconcileArchivedRepoPrFixItems(
  client: PrFixQueueClient,
  isArchived: (repo: string) => Promise<boolean> = isPrFixRepoArchived,
): Promise<{ checked: number; markedStale: number; errored: number }> {
  let checked = 0;
  let markedStale = 0;
  let errored = 0;

  const active = await client.prFixQueueItem.findMany({ where: { status: { in: ["QUEUED", "BLOCKED"] } } });
  const byRepo = new Map<string, any[]>();
  for (const item of active) byRepo.set(item.repo, [...(byRepo.get(item.repo) ?? []), item]);

  for (const [repo, items] of byRepo) {
    checked += items.length;
    if (!(await isArchived(repo))) continue;
    for (const item of items) {
      try {
        await client.$transaction(async (tx) => {
          await tx.prFixQueueItem.update({ where: { id: item.id }, data: { status: "STALE" } });
          await tx.prFixHistory.create({
            data: {
              itemId: item.id,
              action: "mark",
              status: "STALE",
              lane: item.lane,
              note: "Upstream repo archived at reconcile time (#1106)",
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

/**
 * Patch that bumps a PrFixQueueItem's `generation` — Dispatch-owned work
 * identity (#1044), exposed to workers via next-task as
 * `followup-pr.prFixItem.generation`. Merge it into the same Prisma update
 * that flips the item back to QUEUED so the bump is atomic with the state
 * transition: Prisma computes `increment` server-side, so concurrent
 * transitions cannot lose a bump the way a read-then-write `generation + 1`
 * would.
 *
 * When to bump: only when a non-QUEUED item becomes dispatchable again as a
 * NEW attempt — requeue from BLOCKED/FIXED, genuinely new evidence reopening a
 * resolved item, the #940 no-progress FIXED recovery, and markPrFixItem's
 * refused-FIXED rollback. Never bump for ordinary reads, repeated sync of
 * known evidence, or updates that stay within the same active attempt —
 * repeated reads of one pending unit of work must return the same identity.
 */
export function freshAttemptGeneration(): { generation: { increment: number } } {
  return { generation: { increment: 1 } };
}

/**
 * A per-agent hand-out record (#1133): `<agentName>@<generation>`. next-task
 * records one when it ships a task token; `agentAlreadyHanded` then skips
 * the item for that agent until the generation moves. Parsing splits on the
 * LAST `@` so an agent name containing `@` survives, and a non-integer
 * generation makes the entry inert (fail-open toward re-handing, never
 * toward an indefinite skip).
 */
export function agentHandoutToken(agentName: string, generation: number): string {
  return `${agentName}@${generation}`;
}

export function parseAgentHandoutToken(entry: unknown): { agentName: string; generation: number } | null {
  if (typeof entry !== "string") return null;
  const idx = entry.lastIndexOf("@");
  if (idx <= 0) return null;
  const generation = Number(entry.slice(idx + 1));
  if (!Number.isInteger(generation) || generation < 1) return null;
  return { agentName: entry.slice(0, idx), generation };
}

/**
 * Whether this item was already handed to `agentName` at its CURRENT
 * generation (#1133). Entries for older generations and malformed entries
 * never match — the skip must only ever suppress a re-hand of the exact
 * work identity the agent already received.
 */
export function agentAlreadyHanded(
  item: { agentHandouts?: unknown; generation?: unknown },
  agentName: string,
): boolean {
  const entries = Array.isArray(item.agentHandouts) ? item.agentHandouts : [];
  const generation = typeof item.generation === "number" ? item.generation : null;
  if (generation === null) return false;
  return entries.some((entry) => {
    const parsed = parseAgentHandoutToken(entry);
    return parsed !== null && parsed.agentName === agentName && parsed.generation === generation;
  });
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
    // Immutable per-attempt baseline for the current generation (#1074);
    // exposed additively so consumers can distinguish it from headSha.
    attemptHeadSha: item.attemptHeadSha,
    author: item.author,
    generation: item.generation,
    // Per-agent hand-out records for the current generation (#1133); the
    // next-task route reads these to skip items this agent already has.
    agentHandouts: item.agentHandouts ?? [],
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
  if (input.isRepoArchived) {
    throw new Error("Cannot requeue: repository is archived");
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
      // Requeue hands the PR back to the worker loop as a fresh attempt —
      // bump the generation in the same update so consumers see a new work
      // identity rather than one they may already have deduplicated (#1044).
      // It is an operator reset, so the attempt count starts over (#1103).
      // Baseline the attempt from the last observed head: a null baseline
      // made the guard fall back to the mutable headSha, which the next sync
      // overwrites with the worker's own push (#1074, #1104).
      data: {
        status: "QUEUED",
        lane: "NORMAL",
        ...freshAttemptGeneration(),
        fixAttempts: 1,
        attemptHeadSha: existing.headSha ?? null,
        // A fresh operator requeue must not carry post-dispatch evidence
        // recorded for a prior attempt (#1119), nor hand-out records that
        // would suppress the item's re-dispatch (#1133).
        postDispatchEvidenceKeys: [],
        agentHandouts: [],
      },
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
  | "failed"
  | "already_addressed";

/**
 * The (id, generation) attempt token `next-task` issues on a followup-pr
 * task and the worker echoes back in `tasks/report` as `prFixItem` (#1074).
 */
export interface PrFixReportAttempt {
  itemId: string;
  generation: number;
}

export interface ResolvePrFixFromAgentReportInput {
  repoFullName?: string | null;
  pullRequestNumber?: number | null;
  pullRequestUrl?: string | null;
  outcome: AgentReportOutcome;
  summary?: string | null;
  // #1121 evidence string (commit SHAs/paths) carried by an `already_addressed` report.
  evidence?: string | null;
  client?: PrFixQueueClient;
  // #1074: required for queue settlement. When present, the report settles
  // exactly the item + generation the token identifies; when absent (legacy
  // report), the queue is never touched.
  attempt?: PrFixReportAttempt | null;
}

export interface ResolvePrFixFromAgentReportResult {
  matched: boolean;
  action: "none" | "blocked" | "fixed" | "deferred" | "requeued" | "skipped";
  itemId?: number | null;
  reason: string;
  // Echoes the attempt generation the report carried (null when the report
  // was legacy / token-less), for audit and idempotency-replay visibility.
  attemptGeneration?: number | null;
}

/**
 * Resolve a queued pr-fix item when an agent reports back through
 * `tasks/report`. Without this, non-bridge agents (anything driven through
 * MCP tools or the generic harness loop in AGENTS.md, e.g. pi/opencode) get
 * the pr-fix item served first, do the work, report — and the PrFixQueueItem
 * stays QUEUED, so the next poll serves it again ahead of issue work.
 *
 * Attempt-token settlement (#1074): a report carries the `prFixItem`
 * (id, generation) token that `next-task` issued. Settlement is only
 * authorized by that token:
 * - Token present → settle exactly that item + generation. A missing item,
 *   a repo/PR that doesn't match the token's item, a stale generation
 *   (the attempt was re-issued: new evidence, requeue), or an already
 *   settled status all skip without mutation. Every status write below is
 *   generation-conditional, so a concurrent re-issue between the check and
 *   the write still lands as a no-op (commit-time revalidation).
 * - Token absent (legacy report) → the queue is NEVER mutated: the report
 *   matches the item (so the response is informative) but takes no action
 *   and makes no GitHub calls. A pre-token worker can no longer settle an
 *   item it was never issued.
 *
 * Within an authorized settlement, behaviour matches the bridge's own
 * marking:
 * - No matching item or no PR coordinates → no-op (issue-work reports pass
 *   through untouched).
 * - Outcome `blocked` → mark BLOCKED immediately. Doesn't need PR state; the
 *   agent hit a wall.
 * - Outcome `failed` → settle the consumed generation (#1133): reopen a
 *   fresh attempt (counted toward PR_FIX_MAX_ATTEMPTS, #1107), or BLOCKED +
 *   NEEDS_HUMAN past the cap. The bridge reconcile pass that used to own
 *   this decision is retired; leaving the item QUEUED at a generation the
 *   worker already consumed starves the lane behind the deduping worker.
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
  const attempt = input.attempt ?? null;

  let existing: any;
  if (attempt) {
    // The token is the settlement authority: load the item the token names
    // and cross-check the report's repo/PR against it (not the other way
    // around).
    existing = await client.prFixQueueItem.findUnique({
      where: { id: attempt.itemId },
    });
    if (!existing) {
      return {
        matched: false,
        action: "none",
        reason: "attempt item not found",
        attemptGeneration: attempt.generation,
      };
    }
    if (existing.repo !== repo || existing.pr !== pr) {
      return {
        matched: true,
        action: "skipped",
        itemId: existing.id ?? null,
        reason: `attempt item does not match reported repo/PR (item is ${existing.repo}#${existing.pr})`,
        attemptGeneration: attempt.generation,
      };
    }
    if (existing.generation !== attempt.generation) {
      // The attempt was re-issued (new evidence, requeue, refused-FIXED
      // rollback) after this worker was dispatched. Its report is stale:
      // settling it would clobber the newer attempt's state.
      return {
        matched: true,
        action: "skipped",
        itemId: existing.id ?? null,
        reason: `stale attempt generation: report issued for generation ${attempt.generation}, item is at generation ${existing.generation}`,
        attemptGeneration: attempt.generation,
      };
    }
  } else {
    existing = await client.prFixQueueItem.findUnique({
      where: { repo_pr: { repo, pr } },
    });
    if (!existing) {
      return { matched: false, action: "none", reason: "no matching pr-fix queue item" };
    }
    // #1074: legacy report (no attempt token). Match, but never settle —
    // no mutation, no GitHub round-trips.
    return {
      matched: true,
      action: "skipped",
      itemId: existing.id ?? null,
      reason: "legacy report without prFixItem attempt token; queue settlement requires an attempt token (#1074)",
    };
  }

  const currentStatus = normalizePrFixStatus(existing.status) as PrFixStatus | null;
  if (!currentStatus || currentStatus !== "QUEUED") {
    // Already settled (FIXED / BLOCKED / STALE). Idempotent — nothing to do.
    return {
      matched: true,
      action: "skipped",
      itemId: existing.id ?? null,
      reason: `pr-fix item already ${existing.status}`,
      attemptGeneration: attempt?.generation ?? null,
    };
  }

  const expectedGeneration = attempt?.generation ?? undefined;

  if (input.outcome === "blocked") {
    const markResult = await markPrFixItem(client as PrFixQueueClient, {
      repo,
      pr,
      status: "BLOCKED",
      note: input.summary ?? null,
      expectedGeneration,
    });
    if (!markResult.mutated) {
      return {
        matched: true,
        action: "skipped",
        itemId: existing.id ?? null,
        reason: `settlement skipped: ${markResult.reason}`,
        attemptGeneration: attempt?.generation ?? null,
      };
    }
    return {
      matched: true,
      action: "blocked",
      itemId: existing.id ?? null,
      reason: "agent reported blocked",
      attemptGeneration: attempt?.generation ?? null,
    };
  }

  if (input.outcome === "failed") {
    // A failed report must not leave the item QUEUED at the generation this
    // worker already consumed (#1133): the bridge reconcile pass that used
    // to own that cleanup is retired, so a consumed generation would sit
    // QUEUED forever and starve the lane behind the deduping worker.
    // Settle the failure into a fresh dispatchable attempt — counted toward
    // PR_FIX_MAX_ATTEMPTS (#1107) — or, past the cap, hand the PR to a
    // human. No PR-state check: a fresh attempt absorbs late evidence by
    // construction (the bump makes it new work).
    //
    // The fresh attempt's per-attempt baseline must be derived from a row
    // read at settlement time, NOT from the caller's pre-read snapshot: a
    // same-generation enqueue (new evidence) updates the mutable headSha
    // without moving status or generation, so the snapshot's head can be
    // stale even though the generation/status pins all still match — and
    // baselining from it would let the #940 guard mistake pre-attempt head
    // movement for worker progress (#1074/#1104). Each pass therefore
    // re-reads the row, derives the baseline from it, and pins the write to
    // the head snapshot that decision was made on; a miss (the head moved
    // again between the re-read and the write) retries on a newer snapshot.
    // Every fresh-attempt pass keeps that pin — settling with a stale
    // baseline defeats the #940 guard no matter how rare the race — so if
    // every pass loses, the report returns the bounded skip below. That
    // skip does not starve the lane (#1133): the per-agent hand-out records
    // make next-task skip the consumed generation for THIS agent while the
    // item stays available to other agents and to any generation-moving
    // transition. The status+generation pins still reject concurrent
    // settles at the same generation (neither BLOCKED nor FIXED bumps).
    const maxFailedRedecisions = 3;
    let settled: { row: any; capped: boolean } | null = null;
    for (let pass = 0; pass < maxFailedRedecisions && !settled; pass++) {
      const fresh = await client.prFixQueueItem.findUnique({ where: { id: existing.id } });
      if (!fresh) break;
      if (fresh.status !== "QUEUED") break;
      if (expectedGeneration !== undefined && fresh.generation !== expectedGeneration) break;
      const capped = (fresh.fixAttempts ?? 1) >= maxPrFixAttempts();
      const data: Record<string, unknown> = capped
        ? { status: "BLOCKED", lane: "NEEDS_HUMAN", postDispatchEvidenceKeys: [] }
        : {
            status: "QUEUED",
            lane: "NORMAL",
            ...freshAttemptGeneration(),
            fixAttempts: { increment: 1 },
            attemptHeadSha: fresh.headSha ?? fresh.attemptHeadSha ?? null,
            postDispatchEvidenceKeys: [],
            // Fresh attempt: the consumed generation's hand-out records must
            // not suppress the item's re-dispatch (#1133).
            agentHandouts: [],
          };
      // The head-snapshot pin guards the fresh-attempt branch's baseline on
      // EVERY pass; the capped BLOCKED branch carries no baseline, so it
      // pins on id + status + generation only.
      const row = await (client as PrFixQueueClient).$transaction(async (tx) => {
        const { count } = await tx.prFixQueueItem.updateMany({
          where: {
            id: existing.id,
            status: "QUEUED",
            ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
            ...(!capped ? { headSha: fresh.headSha ?? null } : {}),
          },
          data,
        });
        if (count !== 1) return null;
        const freshRow = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
        await tx.prFixHistory.create({
          data: {
            itemId: existing.id,
            action: "mark",
            status: data.status,
            lane: data.lane,
            note: [
              input.summary ?? null,
              capped
                ? `Agent reported failed; bounded at ${fresh.fixAttempts ?? 1} fix attempts (PR_FIX_MAX_ATTEMPTS=${maxPrFixAttempts()}), routed to a human instead of re-queuing (#1133).`
                : `Agent reported failed; reopened as a fresh attempt so the consumed generation cannot strand the queue (#1133).`,
            ]
              .filter(Boolean)
              .join(" "),
          },
        });
        return freshRow;
      });
      if (row) settled = { row, capped };
    }
    if (!settled) {
      // The row is gone, its generation moved (the attempt was re-issued),
      // it was already settled at the same generation, or every pass's
      // head-snapshot pin lost the race: nothing to do. The per-agent
      // hand-out records keep the skipped consumed generation from
      // starving this agent's lane (#1133).
      return {
        matched: true,
        action: "skipped",
        itemId: existing.id ?? null,
        reason: "failed settlement skipped: item no longer QUEUED at the reported generation",
        attemptGeneration: attempt?.generation ?? null,
      };
    }
    if (settled.capped && existing.status !== "BLOCKED") {
      const context = await buildPrFixBlockedContext(client, settled.row);
      await surfacePrFixBlocked({ repo, pr, reason: settled.row.reason, latestNote: input.summary ?? null, context });
    }
    return {
      matched: true,
      action: settled.capped ? "blocked" : "requeued",
      itemId: existing.id ?? null,
      reason: settled.capped
        ? "agent reported failed; past the fix-attempt cap, routed to a human"
        : "agent reported failed; reopened as a fresh attempt at the next generation",
      attemptGeneration: attempt?.generation ?? null,
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
        attemptGeneration: attempt?.generation ?? null,
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
      attemptGeneration: attempt?.generation ?? null,
    };
  }

  const alreadyAddressed = input.outcome === "already_addressed";
  // The FIXED baseline is the item's immutable per-attempt `attemptHeadSha`
  // (fallback: mutable `headSha`), re-read inside markPrFixItem BEFORE any
  // write, so a refused FIXED never transiently exists (#1074).
  const markResult = await markPrFixItem(client as PrFixQueueClient, {
    repo,
    pr,
    status: "FIXED",
    note: input.summary ?? null,
    expectedGeneration,
    ...(alreadyAddressed ? { alreadyAddressed: true } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  });
  if (!markResult.mutated) {
    return {
      matched: true,
      action: "skipped",
      itemId: existing.id ?? null,
      reason: `settlement skipped: ${markResult.reason}`,
      attemptGeneration: attempt?.generation ?? null,
    };
  }
  return {
    matched: true,
    action: "fixed",
    itemId: existing.id ?? null,
    reason: alreadyAddressed
      ? `already_addressed: settled without the head-moved guard${input.evidence ? " (evidence recorded)" : ""}`
      : "pr merge state verified",
    attemptGeneration: attempt?.generation ?? null,
  };
}
