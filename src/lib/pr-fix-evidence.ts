/**
 * PR-fix evidence identity, version, signature, and freshness primitives (#1249).
 *
 * The bounded `evidenceKeys` / `postDispatchEvidenceKeys` caches dedupe by
 * identity only: a first-seen post-dispatch review and a webhook replay of an
 * old one are indistinguishable once the identity is (or is not) in the list,
 * and eviction makes old evidence read as new. This module is the pure core of
 * the durable replacement specified by the #1244/#1248 recovery design:
 *
 * - **Identity** is stable across replays (one key per forge object; a stable
 *   per-PR key for the condition kinds `merge_state`/`merge_conflict`).
 * - **Version** is the state-bearing projection of the identity; only a
 *   version change is a transition.
 * - **Content signature** is a bounded hash that lets an already-recorded
 *   review/comment body under a fresh identity read as repeated text rather
 *   than new work.
 * - **Freshness** is measured against the settling attempt's evidence-snapshot
 *   watermark (the durable ledger sequence stamped at hand-out), never against
 *   forge event timestamps or disposition wall clocks: a webhook delayed past
 *   settlement still records its transition after the watermark, while a
 *   replay never mints a transition at all.
 *
 * Everything here is pure (no Prisma, no network): the durable ledger rows and
 * the watermark stamp live in `pr-fix-queue.ts` / the next-task hand-out, and
 * the reactivation policy that consumes `evaluateEvidenceFreshness` lands in
 * the follow-up (#1253). Do not import forge-specific code from here.
 */

import { createHash } from "node:crypto";

export type PrFixEvidenceKind =
  | "review"
  | "review_comment"
  | "comment"
  | "check_run"
  | "merge_state"
  | "merge_conflict"
  | "unknown";

const EVIDENCE_KIND_VALUES: readonly string[] = [
  "review",
  "review_comment",
  "comment",
  "check_run",
  "merge_state",
  "merge_conflict",
  "unknown",
];

export function isPrFixEvidenceKind(value: string | null | undefined): value is PrFixEvidenceKind {
  return typeof value === "string" && EVIDENCE_KIND_VALUES.includes(value);
}

/**
 * A review is only actionable while `CHANGES_REQUESTED` is its CURRENT state;
 * a dismissed or superseded review is recorded for audit but never reopens.
 */
const ACTIONABLE_REVIEW_STATES = new Set(["changes_requested"]);

/** Problematic persistent merge states (design table `merge_state`). */
const PROBLEMATIC_MERGE_STATES = new Set(["behind", "dirty", "unstable", "has_hooks"]);

/** Failing check conclusions (mirrors `FAILURE_CONCLUSIONS` in linked-pr-health). */
const FAILING_CHECK_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

/**
 * Stable ledger identity for the condition kinds (#1249). `merge_state` and
 * `merge_conflict` describe a CONDITION that persists or clears, not a
 * one-shot observation — deriving the identity from the state string (the
 * pre-#1249 format) made every state string read as a distinct observation,
 * so no durable per-condition baseline could exist. One identity per
 * (kind, repo, PR) makes the ledger row THE baseline: an unchanged condition
 * re-read is never a transition, even after the bounded fast-path caches have
 * evicted it and even when the current disposition was caused by unrelated
 * evidence.
 *
 * The shape matches `computeEvidenceKey` minus the trailing source id, so
 * `parsePostDispatchEvidenceEntry` still derives the eventType from the part
 * before the first ":".
 */
export function conditionEvidenceKey(
  kind: "merge_state" | "merge_conflict",
  repoFullName: string,
  prNumber: number,
): string {
  return `${kind}:${repoFullName}#${prNumber}`;
}

/** Forge state-bearing fields an observation carries for its kind. */
export interface EvidenceVersionFields {
  /** review: the review's current state ("CHANGES_REQUESTED", ...). */
  state?: string | null;
  /** review / review_comment: commit the review/comment was written against. */
  commitId?: string | null;
  /** comment / review_comment: forge-side `updated_at`. */
  updatedAt?: string | null;
  /** review_comment: its review thread is resolved. */
  resolved?: boolean | null;
  /** review_comment: its review thread is outdated (off the current diff). */
  outdated?: boolean | null;
  /** comment / review_comment / review: the author login of the feedback. */
  actorLogin?: string | null;
  /** check_run head SHA / condition observation head SHA. */
  headSha?: string | null;
  /** check_run lifecycle status ("queued", "in_progress", "completed"). */
  checkStatus?: string | null;
  /** check_run conclusion ("failure", "success", ...). */
  conclusion?: string | null;
  /** merge_state: the merge state status string ("dirty", "behind", ...). */
  mergeStateStatus?: string | null;
  /** merge_conflict: the mergeable field ("CONFLICTING", "MERGEABLE", ...). */
  mergeable?: string | null;
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Canonical version string: the state-bearing fields of an identity, in a
 * fixed per-kind order. Two observations of the same identity share a version
 * exactly when no freshness-bearing field changed, so re-recording one is a
 * no-op. Missing fields normalize to empty; the result is stable across
 * processes and restarts (no object-iteration-order dependence).
 */
export function computeEvidenceVersion(kind: PrFixEvidenceKind, fields: EvidenceVersionFields): string {
  switch (kind) {
    case "review":
      return `state=${norm(fields.state)}|commit=${norm(fields.commitId)}`;
    case "review_comment":
      return `commit=${norm(fields.commitId)}|updated=${norm(fields.updatedAt)}|resolved=${fields.resolved === true ? "y" : "n"}|outdated=${fields.outdated === true ? "y" : "n"}`;
    case "comment":
      return `updated=${norm(fields.updatedAt)}|actor=${norm(fields.actorLogin)}`;
    case "check_run":
      return `head=${norm(fields.headSha)}|status=${norm(fields.checkStatus)}|conclusion=${norm(fields.conclusion)}`;
    case "merge_state":
      return `state=${norm(fields.mergeStateStatus)}|head=${norm(fields.headSha)}`;
    case "merge_conflict":
      return `mergeable=${norm(fields.mergeable)}|head=${norm(fields.headSha)}`;
    case "unknown":
      return "unknown";
  }
}

/**
 * Whether the CURRENT version of an observation is actionable by kind (design
 * predicate 1): the transition matters only when the evidence demands work.
 * `review_comment` exclusion is the #1248 "already-resolved thread" rule:
 * a resolved or outdated inline comment is recorded, never treated as fresh
 * work. Unknown provenance is never silently actionable, and never silently
 * resolved — callers route `unknown` to the defer-and-audit path.
 */
export function isActionableEvidenceVersion(
  kind: PrFixEvidenceKind,
  fields: EvidenceVersionFields,
): boolean {
  switch (kind) {
    case "review":
      return ACTIONABLE_REVIEW_STATES.has(norm(fields.state));
    case "review_comment":
      // Conservative: only an EXPLICIT resolved/outdated thread is inert; a
      // missing thread state (read capability unavailable) stays actionable
      // rather than silently dropping reviewer feedback.
      return fields.resolved !== true && fields.outdated !== true;
    case "comment":
      return true;
    case "check_run":
      return FAILING_CHECK_CONCLUSIONS.has(norm(fields.conclusion));
    case "merge_state":
      return PROBLEMATIC_MERGE_STATES.has(norm(fields.mergeStateStatus));
    case "merge_conflict":
      return norm(fields.mergeable) === "conflicting";
    case "unknown":
      return false;
  }
}

/** Bounded hex length of a content signature (128 bits — collision-safe for
 * the anti-repetition check, small enough to store/index beside the row). */
export const CONTENT_SIGNATURE_LENGTH = 32;

/**
 * Bounded content signature for text-bearing kinds (review / review_comment /
 * comment): hash of (normalized body, author login, state, commit id).
 *
 * Normalization is deliberately minimal and documented (#1244 open question):
 * trim, lowercase, and collapse every whitespace run to a single space. Code
 * fences and quote characters are NOT stripped — repeated bot text differs by
 * formatting exactly as often as not, and under-normalizing only ever keeps
 * evidence actionable (never strands it).
 *
 * The signature includes the commit id, so the SAME body re-pasted against a
 * newer commit gets a different signature and stays actionable; the design's
 * "signature already present at the same or newer head" reduces to "same
 * signature present" because a same signature necessarily names a same
 * commit. Returns null when there is no body text (checks and conditions
 * carry no prose to repeat).
 */
export function computeEvidenceContentSignature(input: {
  body?: string | null;
  actorLogin?: string | null;
  state?: string | null;
  commitId?: string | null;
}): string | null {
  const body = (input.body ?? "").trim();
  if (!body) return null;
  const normalized = body.toLowerCase().replace(/\s+/g, " ");
  const material = [normalized, norm(input.actorLogin), norm(input.state), norm(input.commitId)].join("\u0000");
  return createHash("sha256").update(material).digest("hex").slice(0, CONTENT_SIGNATURE_LENGTH);
}

export type EvidenceFreshnessReason =
  /** The ledger transition for this observation postdates the settling
   * attempt's snapshot watermark and the version demands work. */
  | "fresh_transition_after_watermark"
  /** The observation's transition is at or before the watermark: it was part
   * of the issued hand-out snapshot (or predates it), so it is not new work
   * for that attempt — replay-safe regardless of when it was re-read. */
  | "transition_at_or_before_watermark"
  /** Another ledger identity already carries this content signature at the
   * same commit: repeated text, recorded for audit, not actionable alone. */
  | "repeated_content_signature"
  /** The current version is not actionable by kind (cleared condition,
   * dismissed review, resolved/outdated thread, passing check). */
  | "not_actionable"
  /** No ledger row was recorded for the observation: missing/unknown forge
   * evidence. Never treated as resolved and never treated as fresh; the
   * caller defers and audits (unknown-evidence behavior). */
  | "unknown_provenance"
  /** The disposition's attempt carries no snapshot watermark (pre-#1249 row
   * or a best-effort stamp that lost its race): the durable ledger cannot
   * decide, and callers fall back to the bounded cache fast path. */
  | "no_watermark";

/** The durable ledger state for ONE identity, as recorded. */
export interface EvidenceLedgerSnapshot {
  identity: string;
  /** Version CURRENTLY stored for the identity (post-record). */
  version: string;
  /** Ledger sequence at which the CURRENT version's transition was recorded. */
  sequence: number;
  contentSignature: string | null;
  /** Whether the stored version is actionable by kind. */
  actionable: boolean;
}

export interface EvidenceFreshnessDecision {
  fresh: boolean;
  reason: EvidenceFreshnessReason;
}

/**
 * The shared freshness decision (#1249): evaluate ONE recorded observation for
 * an attempt snapshot. Both the event-driven settle path and the periodic
 * reconciliation (#1253) call this so the two paths cannot drift.
 *
 * Rules, in order (design "Fresh actionable evidence"):
 * 1. No ledger row → `unknown_provenance` — missing/unknown forge evidence is
 *    never silently deemed resolved, and never fresh on its own say-so.
 * 2. Stored version not actionable → `not_actionable` (cleared/dismissed/
 *    resolved states are recorded, not reopened).
 * 3. No watermark on the settling attempt → `no_watermark` (indeterminate;
 *    the bounded cache keeps working until the row carries a snapshot).
 * 4. Repeated content signature under a new identity → `repeated_content_signature`
 *    (anti-repetition; the #940 stale-FIXED net is caller-side and runs
 *    BEFORE this decision — a dedupe suppression must never swallow it).
 * 5. Recorded transition after the watermark → fresh; at or before it → not
 *    fresh. Forge event timestamps never participate: a webhook delayed past
 *    settlement records its transition after the watermark (fresh), while a
 *    replay mints no transition and keeps its pre-watermark sequence
 *    (inert forever).
 */
export function evaluateEvidenceFreshness(args: {
  ledger: EvidenceLedgerSnapshot | null;
  watermark: number | null;
  /** True when another ledger identity already holds this observation's
   * content signature at the same commit (computed by the caller against the
   * item's ledger rows, excluding this identity). */
  repeatedContentSignature?: boolean;
}): EvidenceFreshnessDecision {
  const { ledger, watermark } = args;
  if (!ledger) return { fresh: false, reason: "unknown_provenance" };
  if (!ledger.actionable) return { fresh: false, reason: "not_actionable" };
  if (watermark === null) return { fresh: false, reason: "no_watermark" };
  if (args.repeatedContentSignature) return { fresh: false, reason: "repeated_content_signature" };
  return ledger.sequence > watermark
    ? { fresh: true, reason: "fresh_transition_after_watermark" }
    : { fresh: false, reason: "transition_at_or_before_watermark" };
}

/**
 * Project durable ledger rows into the `<evidenceKey>@<head>` entry format of
 * the #1119 post-dispatch list, so settlement can run the durable set through
 * the same actionability revalidation (head-gated for checks) as the cache.
 * The cache remains the fast path; the ledger is the boundary that survives
 * eviction.
 */
export function ledgerRowsToPostDispatchEntries(
  rows: ReadonlyArray<{ identity: string; headSha?: string | null }>,
): string[] {
  return rows.map((row) => `${row.identity}@${(row.headSha ?? "").trim() || "unknown"}`);
}
