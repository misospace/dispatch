/**
 * Mechanical rebase lane (#1327).
 *
 * A bot-authored PR that goes DIRTY (merge conflict) cannot be repaired by a
 * code-fix attempt: the conflict has to be rebased away first, and only
 * mechanically. The lane's worker contract lives in this module so every
 * producer of a rebase work item — the PR follow-up ingestion path AND the
 * linked-PR health materialization in the agent queue — writes the SAME
 * instruction wall.
 */

import { REBASE_MODEL_EXECUTOR_CAPABILITY, REBASE_MODEL_EXECUTOR_CAPABILITY_VERSION } from "@/lib/rebase-intake";

/**
 * Worker-facing contract for the mechanical rebase lane (#1327). Every
 * conflict call-site shares it — the merge_state event descriptor, the
 * mergeable=CONFLICTING ingestion, and the linked-PR health materialization:
 * the item's reasons ARE the instruction wall, since a rebase hand-off is a
 * followup-pr task and the queue carries no separate instruction channel.
 */
export function rebaseWorkItem(stateLabel: string): {
  lane: "NORMAL";
  type: "REBASE";
  reason: string;
  feedback: string;
} {
  return {
    lane: "NORMAL",
    type: "REBASE",
    reason: `Mechanical rebase: PR ${stateLabel} against base (#1327)`,
    feedback: [
      `Mechanical rebase required: this PR is ${stateLabel} against its base branch (#1327).`,
      "Rebase the PR branch onto the base and resolve conflicts MECHANICALLY ONLY:",
      "lockfiles, version strings, import order, doc indexes, adjacent",
      "non-overlapping hunks, and comment-only overlaps where one side is a",
      "strict subset. Never edit the same logic on both sides; never merge;",
      "never open a new PR. Push with --force-with-lease, then run the repo's",
      "bounded typecheck; an unfixable error in a file this PR touches says the",
      "rebase is not mechanical. On ANY semantic conflict, report outcome",
      '"blocked" with blockReason "human_decision", the conflicting files, and',
      "why the conflict is not mechanical — do NOT resolve it yourself. One",
      "attempt per DIRTY episode; do not retry.",
    ].join("\n"),
  };
}

// ─── Model-assisted rebase contract (#1674) ──────────────────────────────────

/**
 * The negotiated `rebase-model-executor:1` capability changes what the lane's
 * instruction wall says about semantic conflicts: a deterministic-only
 * consumer must stop for a human on any conflict outside the mechanical
 * rules, while a model-assisted consumer runs ONE bounded model-assisted
 * resolution attempt on the lane's configured coordinator. The row's
 * persisted wall (written at enqueue by `rebaseWorkItem`) stays the
 * deterministic contract; the model contract is composed at HAND-OUT time,
 * per poll, so one row can be offered to either consumer class without
 * mutating the row.
 */

/**
 * The bounded semantic-conflict context the model-assisted capability
 * transports (#1674). Shape mirrors the mechanical attempt's structured
 * non-mechanical-conflict refusal (courier#732 `ConflictReport`): the base
 * ref the rebase stopped on, the conflicted paths that are not mechanically
 * resolvable, and a bounded reason.
 *
 * Dispatch does not detect conflicts itself. The mechanical executor's accepted
 * refusal is the producer (#1676): the episode writer persists this context on
 * the row (`semanticConflict`), which is what marks the row MODEL-REQUIRED. A
 * row without one reads as `null` and ships `semanticConflict: null`.
 */
export interface RebaseSemanticConflictContext {
  /** The base ref the mechanical rebase stopped on. */
  base?: string;
  /** The conflicted paths that are not mechanically resolvable. */
  files?: string[];
  /** A bounded human-readable summary of why the conflict is not mechanical. */
  reason?: string;
}

/** Bounds on the transported context. Anything beyond them is dropped. */
const SEMANTIC_CONFLICT_MAX_BASE_LENGTH = 256;
const SEMANTIC_CONFLICT_MAX_FILES = 32;
const SEMANTIC_CONFLICT_MAX_PATH_LENGTH = 256;
const SEMANTIC_CONFLICT_MAX_REASON_LENGTH = 512;

/**
 * Read the bounded semantic-conflict context off a queue row, defensively:
 * a row without one, a non-object value, or a value whose every field is
 * malformed or empty reads as `null`, and the row behaves as an ordinary
 * mechanical REBASE item. Valid fields are kept — over-long strings
 * truncated, over-many paths capped, non-string paths dropped. The context
 * is transport evidence for the model worker, never an authorization:
 * authorization is the negotiated capability plus the operator pool.
 */
export function readRebaseSemanticConflict(row: unknown): RebaseSemanticConflictContext | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const raw = (row as Record<string, unknown>).semanticConflict;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const base =
    typeof record.base === "string" && record.base.trim() !== ""
      ? record.base.slice(0, SEMANTIC_CONFLICT_MAX_BASE_LENGTH)
      : undefined;
  const files = Array.isArray(record.files)
    ? record.files
        .filter((path): path is string => typeof path === "string" && path.trim() !== "")
        .slice(0, SEMANTIC_CONFLICT_MAX_FILES)
        .map((path) => path.slice(0, SEMANTIC_CONFLICT_MAX_PATH_LENGTH))
    : undefined;
  const reason =
    typeof record.reason === "string" && record.reason.trim() !== ""
      ? record.reason.slice(0, SEMANTIC_CONFLICT_MAX_REASON_LENGTH)
      : undefined;

  if (base === undefined && (files === undefined || files.length === 0) && reason === undefined) {
    return null;
  }
  return {
    ...(base !== undefined ? { base } : {}),
    ...(files !== undefined && files.length > 0 ? { files } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * Whether a queue row is model-REQUIRED: it carries a bounded
 * semantic-conflict context, so only a consumer authorized for model-assisted
 * resolution may receive it. A deterministic-only consumer must never be
 * offered this item (#1674).
 */
export function isRebaseModelRequired(row: { semanticConflict?: RebaseSemanticConflictContext | null }): boolean {
  return row.semanticConflict != null;
}

/**
 * The stable conflict-episode identity: a pure function of the AUTHORITATIVE
 * PR/base/head/ref state Dispatch itself holds. `branch` is the head ref,
 * `headSha` the conflicting head. Null branches/heads fold to a literal
 * "unknown" segment so a partially-observed episode still derives ONE
 * deterministic identity, and every side of the comparison (the episode writer,
 * the enqueue-side no-bounce gate, and the dispatch-side context scoping below)
 * folds the same way. Poll timestamps and worker text are deliberately absent:
 * a resync ten seconds later and a restart tomorrow derive the SAME identity
 * for the SAME conflict, and a new push (new head) derives a DIFFERENT one.
 */
export function rebaseEpisodeIdentity(
  repo: string,
  pr: number,
  branch: string | null | undefined,
  headSha: string | null | undefined,
): string {
  const ref = (branch ?? "").trim() || "unknown";
  const head = (headSha ?? "").trim() || "unknown";
  return `rebase-episode:${repo}#${pr}:${ref}:${head}`;
}

/**
 * The persisted context ONLY while it still describes the row's current
 * conflict (#1676). The episode writer persists the context together with the
 * `rebaseEpisodeId` it derived from the head it verified, so a context whose id
 * no longer matches the row's freshest head knowledge belongs to a superseded
 * conflict (a new push is a new episode) and must neither mark the row
 * model-required nor be transported as current evidence. Without that scoping a
 * later mechanical conflict would inherit the previous episode's
 * model-required gate and starve the concurrency-1 rebase lane, or ship a stale
 * file list to the model worker. `headSha` leads because ingestion refreshes it
 * on every observation; `attemptHeadSha` is the fallback the episode writer
 * itself verified against.
 */
export function scopedRebaseSemanticConflict(row: {
  repo?: string | null;
  pr?: number | null;
  branch?: string | null;
  headSha?: string | null;
  attemptHeadSha?: string | null;
  rebaseEpisodeId?: string | null;
  semanticConflict?: unknown;
}): RebaseSemanticConflictContext | null {
  const context = readRebaseSemanticConflict(row);
  if (context === null) return null;
  if (typeof row.repo !== "string" || typeof row.pr !== "number") return null;
  const episodeId = rebaseEpisodeIdentity(
    row.repo,
    row.pr,
    row.branch ?? null,
    row.headSha ?? row.attemptHeadSha ?? null,
  );
  return row.rebaseEpisodeId === episodeId ? context : null;
}

/**
 * The bounded refusal evidence the mechanical executor reports (#1675), narrowed
 * to what the model transport needs.
 */
export type RebaseRefusalEvidence = {
  baseRef: string | null;
  conflictingFiles: string[];
  explanation: string | null;
};

/**
 * Map the mechanical executor's refusal evidence onto the transport context
 * (#1676). Anchored here so the persisted context can never exceed the bounds
 * `readRebaseSemanticConflict` re-applies on the read side: a refusal that
 * reports nothing usable yields `null`, which keeps the row an ordinary
 * mechanical item rather than a model-required row no context accompanies.
 */
export function semanticConflictFromRefusal(evidence: RebaseRefusalEvidence): RebaseSemanticConflictContext | null {
  return readRebaseSemanticConflict({
    semanticConflict: {
      base: evidence.baseRef ?? undefined,
      files: evidence.conflictingFiles,
      reason: evidence.explanation ?? undefined,
    },
  });
}

/**
 * The model-assist instruction wall handed out INSTEAD of the mechanical
 * refusal wall to a poll granted `rebase-model-executor:1` whose agent is in
 * the operator-declared model-worker pool. The mechanical rules stay the
 * fast path; a conflict outside them runs ONE bounded model-assisted
 * resolution attempt on the lane's configured coordinator — exactly one
 * model, concurrency one, no delegation, no silent cloud substitution — and
 * only an attempt that cannot complete or needs an unresolved product
 * decision stops for a human.
 *
 * This wall is what makes a real model call possible for a semantic case:
 * the deterministic wall's "do NOT resolve it yourself" refusal is absent
 * here, deliberately.
 */
export function rebaseModelAssistFeedback(): string[] {
  return [
    "Rebase the PR branch onto its base branch (#1327). Resolve conflicts",
    "MECHANICALLY FIRST where the rules allow: lockfiles, version strings,",
    "import order, doc indexes, adjacent non-overlapping hunks, and",
    "comment-only overlaps where one side is a strict subset. Never edit the",
    "same logic on both sides; never merge; never open a new PR.",
    "A conflict outside the mechanical rules is resolved with the lane's",
    "CONFIGURED MODEL COORDINATOR: exactly the one configured model, one",
    "bounded model-assisted attempt per episode, no delegation, and no",
    "silent substitution of another provider or model. Give the model the",
    "goal, the PR changes, the relevant base changes, and the conflicting",
    "files; preserve the intent of both sides; permit the repository's own",
    "lockfile/version tooling where appropriate.",
    "Publication is unchanged: push with --force-with-lease to the existing",
    "approved PR branch only, then run the repo's bounded checks and report",
    "failures honestly. Model confidence or a clean conflict-marker scan is",
    "never sufficient publication evidence.",
    "Stop for a human (report outcome \"blocked\" with blockReason",
    "\"human_decision\" and why) only when the bounded model-assisted attempt",
    "cannot complete, the resolution requires an unresolved product/design",
    "decision, or validation fails. One attempt per DIRTY episode; do not",
    "retry, and never count a deterministic refusal as a model-assisted",
    "attempt.",
  ];
}

/**
 * The versioned transport block shipped on a REBASE hand-out to a poll
 * granted `rebase-model-executor:1` (with the operator pool check). It
 * carries the granted capability identity and the item's bounded
 * semantic-conflict context, so the consumer can execute the model-assisted
 * contract on this exact episode. Absent from every other hand-out: a
 * deterministic-only consumer's task stays byte-identical.
 */
export interface RebaseModelAssist {
  capability: typeof REBASE_MODEL_EXECUTOR_CAPABILITY;
  version: typeof REBASE_MODEL_EXECUTOR_CAPABILITY_VERSION;
  /** The item's bounded semantic-conflict context; null until one is persisted. */
  semanticConflict: RebaseSemanticConflictContext | null;
}

/**
 * Build the transport block for one granted REBASE hand-out. The capability
 * identity comes from the negotiation module's constants, so the ack's
 * granted verdict and the transport block cannot drift apart.
 */
export function rebaseModelTransport(semanticConflict: RebaseSemanticConflictContext | null): RebaseModelAssist {
  return {
    capability: REBASE_MODEL_EXECUTOR_CAPABILITY,
    version: REBASE_MODEL_EXECUTOR_CAPABILITY_VERSION,
    semanticConflict,
  };
}

/**
 * Whether a stored feedback entry carries the mechanical rebase instruction
 * wall above (#1327). The wall is the mechanical-only lane's worker contract,
 * so the #1675 REBASE→fix transfer drops entries matching this from the
 * transferred repair attempt's retained feedback: a transferred row is an
 * ordinary model-assisted repair attempt, and carrying the wall would hand
 * its worker contradictory mechanical-only instructions. Anchored here (the
 * wall's single producer) so the marker cannot drift from the text workers
 * actually receive.
 */
export function isMechanicalRebaseInstruction(entry: unknown): boolean {
  if (typeof entry !== "string") return false;
  const trimmed = entry.trim();
  return (
    trimmed.startsWith("Mechanical rebase required:") ||
    trimmed.includes("resolve conflicts MECHANICALLY ONLY")
  );
}
