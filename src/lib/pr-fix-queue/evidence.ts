import { extractUrlsFromText } from "../pr-fix-surfacing";
import { fetchPullRequestHeadSha } from "../github-prs";
import { isPrFixEvidenceKind, ledgerRowsToPostDispatchEntries, normalizeEvidenceContentSignature } from "../pr-fix-evidence";
import { type PrFixQueueClient } from "./client";
import { laneLabel, parseEvidenceObservedAt } from "./shared";
import { type EnqueuePrFixInput } from "./inputs";

/** The item's ledger state relevant to ONE incoming observation. */
export interface EvidenceLedgerView {
  /** Whether this enqueue carries durable evidence fields AND the client
   * exposes the ledger table. False keeps pre-#1249 cache semantics. */
  records: boolean;
  /** The CURRENTLY stored row for this identity, if any. */
  prior: { version: string; sequence: number } | null;
  /** Another identity already holds this observation's content signature. */
  repeatedSignature: boolean;
}

/**
 * The evidence block of ONE observation: the identity/provenance fields the
 * durable ledger records, and nothing about the work itself. `EnqueuePrFixInput`
 * carries these plus lane/type/reason/feedback, so it satisfies this shape;
 * a record-only observation that must never touch work (#1276) passes exactly
 * this and nothing more, which makes "records evidence, enqueues no work" a
 * property of the signature rather than of reviewer discipline.
 */
export type EvidenceObservation = Pick<
  EnqueuePrFixInput,
  | "evidenceKey"
  | "evidenceKind"
  | "evidenceVersion"
  | "evidenceContentSignature"
  | "evidenceObservedAt"
  | "evidenceHeadSha"
  | "evidenceSource"
  | "evidenceActionable"
>;

/**
 * Whether an enqueue carries a COMPLETE durable evidence block. A missing or
 * blank `evidenceVersion` fails closed to the pre-#1249 cache semantics:
 * without a version there is no way to tell a re-read from a transition, and
 * defaulting it to "" would mint a fresh ledger transition (and counter bump)
 * on every periodic re-observation of the same evidence.
 */
export function carriesLedgerFields(input: EvidenceObservation): boolean {
  return (
    !!input.evidenceKey &&
    isPrFixEvidenceKind(input.evidenceKind) &&
    typeof input.evidenceVersion === "string" &&
    input.evidenceVersion.trim().length > 0
  );
}

export async function readEvidenceLedgerView(
  tx: PrFixQueueClient,
  itemId: string,
  input: EvidenceObservation,
): Promise<EvidenceLedgerView> {
  if (!carriesLedgerFields(input) || !tx.prFixEvidence) {
    return { records: false, prior: null, repeatedSignature: false };
  }
  const prior = (await tx.prFixEvidence.findFirst({
    where: { itemId, identity: input.evidenceKey },
  })) as { version: string; sequence: number } | null;
  let repeatedSignature = false;
  const signature = normalizeEvidenceContentSignature(input.evidenceContentSignature);
  if (signature) {
    const matches = await tx.prFixEvidence.findMany({
      where: { itemId, contentSignature: signature },
    });
    repeatedSignature = (matches ?? []).some((row: any) => row.identity !== input.evidenceKey);
  }
  return { records: true, prior: prior ?? null, repeatedSignature };
}

/**
 * Upsert the ledger row for a NEW transition, claiming `sequence` (the value
 * the incrementing item write assigned from the same snapshot). Only called
 * when the (identity, version) pair actually changed — re-recording a stored
 * version never reaches here, so replays never restamp or resequence.
 *
 * Two concurrent transitions for DIFFERENT identities can both assign the
 * same sequence under contention when the pinned write fell back to the
 * unpinned exhausted-loop update (the pin below covers the common path; the
 * fallback is the documented #1134 degradation). Duplicate sequence numbers
 * are benign for watermark comparisons: both rows straddle any watermark
 * together, so a collision can at most reproduce the bounded
 * redundant-attempt cost #1119 already accepts — it can never fake a
 * post-watermark transition that never happened.
 */
export async function recordEvidenceTransition(
  tx: PrFixQueueClient,
  itemId: string,
  input: EvidenceObservation,
  sequence: number,
  repeatedSignature = false,
): Promise<void> {
  if (!tx.prFixEvidence || !input.evidenceKey || !isPrFixEvidenceKind(input.evidenceKind)) return;
  const row = {
    kind: input.evidenceKind,
    version: input.evidenceVersion ?? "",
    contentSignature: normalizeEvidenceContentSignature(input.evidenceContentSignature),
    observedAt: parseEvidenceObservedAt(input.evidenceObservedAt),
    headSha: input.evidenceHeadSha ?? null,
    source: input.evidenceSource ?? null,
    // Missing provenance (legacy caller without the field) records as
    // actionable = true only for kinds the caller gated already; `unknown`
    // kinds stay non-actionable, never silently fresh (design: unknown
    // evidence defers, it does not resolve).
    //
    // #1249 controls 3/7: a NEW identity repeating an already-recorded
    // content signature is recorded as a transition for audit but stamped
    // NON-actionable, so neither the enqueue decision (sticky via
    // isKnownEvidence) nor the settlement durable read (filtered on
    // actionable:true) can ever treat repeated text as fresh work.
    actionable: input.evidenceActionable !== false && !repeatedSignature,
    // The row's ledger position tracks its CURRENT version's transition. A
    // re-versioned row (a dismissed review that is requested again, a
    // condition that reappears) that kept its first version's sequence would
    // sit at or below any live watermark and be silently absorbed at
    // settlement — a false silence, the loss class the watermark exists to
    // prevent. Replay inertness is upstream of this function: a stored
    // (identity, version) never reaches it.
    sequence,
  };
  await tx.prFixEvidence.upsert({
    where: { itemId_identity: { itemId, identity: input.evidenceKey } },
    create: { itemId, identity: input.evidenceKey, ...row, sequence },
    update: row,
  });
}

/**
 * Durable post-dispatch entries for a settling attempt (#1249): actionable
 * ledger transitions recorded AFTER the attempt's evidence-snapshot watermark,
 * projected into the #1119 `<evidenceKey>@<head>` format so settlement
 * revalidates them (head-gated for checks) through `hasActionablePostDispatch-
 * Evidence` exactly like the bounded cache. No watermark → empty list: the
 * cache fast path stands (legacy rows and lost best-effort stamps behave as
 * before #1249; they never gain a false reopen from ledger rows they cannot
 * bound).
 */
export async function listDurablePostDispatchEntries(
  client: PrFixQueueClient,
  row: any,
): Promise<string[]> {
  if (!client.prFixEvidence || typeof row.attemptEvidenceWatermark !== "number") return [];
  const rows = await client.prFixEvidence.findMany({
    where: { itemId: row.id, sequence: { gt: row.attemptEvidenceWatermark }, actionable: true },
    orderBy: { sequence: "asc" },
  });
  return ledgerRowsToPostDispatchEntries(rows ?? []);
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
export function appendPostDispatchEvidenceEntry(values: string[], entry: string, maxItems: number): string[] {
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
export function encodePostDispatchEvidenceKey(evidenceKey: string, headSha: string | null | undefined): string {
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
export async function hasActionablePostDispatchEvidence(
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
 * Build the surfacing context for a BLOCKED/PARKED item from data Dispatch
 * actually has: the item's worker-execution count (`fixAttempts`), its feedback
 * (the latest is the best available last-attempt context) and its history rows.
 * All fields are optional/fallback-safe so historical rows and old callers
 * still surface something useful. Never throws.
 *
 * Metrics truthfulness (#1218): `workerExecutions` is the dispatchable attempt
 * count and `enqueueRows` is the enqueue/evidence row count; the enqueue count
 * is deliberately NOT emitted as `totalAttempts`.
 */
export async function buildPrFixBlockedContext(
  client: PrFixQueueClient,
  item: { repo: string; pr: number; feedback?: string[] | null; fixAttempts?: number | null; stagnationCount?: number | null; staleDisposition?: boolean | null },
): Promise<import("../pr-fix-surfacing").PrFixSurfaceContext> {
  const context: import("../pr-fix-surfacing").PrFixSurfaceContext = {};

  // #1253: surface the stale-disposition flag when it is set — fresh
  // actionable evidence arrived while the item sat in a hold evidence must
  // not override. Read-only hint; never reopens anything.
  if (item.staleDisposition === true) context.staleDisposition = true;

  const feedback = Array.isArray(item.feedback) ? item.feedback : [];

  const links: string[] = [];
  let lastAttemptSummary: string | null = null;
  for (const entry of feedback) {
    if (!entry) continue;
    lastAttemptSummary = entry;
    const urls = extractUrlsFromTextSafe(entry);
    for (const u of urls) if (!links.includes(u)) links.push(u);
  }
  if (links.length > 0) context.failingRunLinks = links;
  if (lastAttemptSummary) context.lastAttemptSummary = lastAttemptSummary;

  // Worker executions are the real attempt count; report them explicitly, never as the
  // enqueue row count (#1218). The consecutive-stagnation count (#1543) rides
  // alongside so operators can tell a long-but-healthy loop from a stuck one.
  if (typeof item.fixAttempts === "number") context.workerExecutions = item.fixAttempts;
  else context.workerExecutions = null;
  if (typeof item.stagnationCount === "number") context.stagnationCount = item.stagnationCount;

  // Enqueue rows grouped by lane, plus the final failure signature from the
  // latest BLOCKED or PARKED tombstone note. Historical rows without a lane are
  // counted under "unknown".
  try {
    if (client.prFixHistory?.findMany) {
      const history = await client.prFixHistory.findMany({
        where: { item: { repo: item.repo, pr: item.pr } },
        orderBy: { at: "desc" },
      });

      const attemptsByLane: Record<string, number> = {};
      let enqueueCount = 0;
      for (const h of history) {
        if (h.action !== "enqueue") continue;
        enqueueCount += 1;
        const lane = laneLabel(h.lane);
        attemptsByLane[lane] = (attemptsByLane[lane] ?? 0) + 1;
      }
      context.enqueueRows = enqueueCount;
      if (Object.keys(attemptsByLane).length > 0) context.attemptsByLane = attemptsByLane;

      const terminal = history.find(
        (h) => h.action === "mark" && (h.status === "BLOCKED" || h.status === "PARKED") && h.note,
      );
      if (terminal?.note) context.finalFailureSignature = terminal.note;
    }
  } catch {
    // Failure to load history is non-fatal; we still surface with the rest.
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
