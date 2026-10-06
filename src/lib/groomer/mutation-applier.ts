/**
 * Idempotent application of a validated GroomingPlan (dispatch#1063).
 *
 * The applier turns a plan into a diff against the live issue (never the
 * cached one), names that diff with a stable application key, claims the key
 * in GroomingApplication, and applies the diff in a fixed order from least to
 * most impact, halting at the first failure:
 *
 *   labels → comment → title/body → close → status/done
 *
 * Retrying the same key replays recorded steps instead of repeating them;
 * the posted comment also carries the key as a hidden marker, so a comment
 * that landed without being recorded is found on GitHub rather than posted
 * twice. Every other step is a diff from live state, so re-applying it is a
 * no-op rather than a second side effect.
 */

import { createHash } from "crypto";

import type { StatusLabel } from "@/types";
import {
  childBriefKey,
  CHILD_ISSUE_LABELS,
  renderChildIssueBody,
  setDecompositionState,
  UMBRELLA_LABEL,
  type ChildIssueTarget,
  type DecompositionStateClient,
} from "@/lib/decomposition";
import { getBacklogLane } from "@/lib/lane-config";
import { isAutomationAuthor } from "./context";
import { neutralizeMentions } from "./sanitize";
import { inFlightStatus, toGroomerOutput, type ChildBrief, type GroomingPlan } from "./plan";
import type { EvidenceCatalog } from "./plan-evidence";
import type { GroomerOutput } from "./schema";
import {
  evaluateClosePolicy,
  evaluateDecompositionPolicy,
  evaluateReadyPolicy,
  type LiveComment,
  type LiveIssueState,
} from "./mutation-validator";

export const APPLICATION_KEY_VERSION = 1;
export const MAX_GITHUB_COMMENT_CHARS = 4096;

// ─── Label helpers (moved from run.ts) ───────────────────────────────────────

export function applyLabelChanges(current: string[], toAdd: string[], toRemove: string[]): string[] {
  let labels = [...current];
  for (const label of toAdd) {
    if (!labels.includes(label)) labels.push(label);
  }
  for (const label of toRemove) {
    labels = labels.filter((l) => l !== label);
  }
  return labels;
}

/**
 * The exactly-one-status post-condition (dispatch#941): after an applied
 * groom the plan's derived status is the only status/* label, whatever other
 * status labels (owned by the groomer or not) the issue carried.
 */
export function withDerivedStatus(labels: string[], status: StatusLabel): string[] {
  return [...labels.filter((l) => !l.startsWith("status/")), status];
}

function sameLabelSet(a: string[], b: string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((value, index) => value === y[index]);
}

// ─── Title / body guards (moved from run.ts) ─────────────────────────────────

/**
 * A "bad" title the groomer may rewrite: under 10 chars, or a single generic
 * token. Descriptive titles are never rewritten.
 */
export function shouldRewriteTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < 10) return true;
  const words = trimmed.split(/\s+/);
  if (words.length === 1) {
    const lower = trimmed.toLowerCase();
    const GENERIC_TOKENS = ["p0", "p1", "p2", "p3", "p4", "todo", "bug", "fix", "fixme", "wip", "help", "urgent", "critical"];
    if (GENERIC_TOKENS.includes(lower)) return true;
    if (/^[a-z0-9]+$/i.test(trimmed) && trimmed.length <= 6) return true;
  }
  return false;
}

/** A sparse body the groomer may enrich: missing, or under 100 chars once HTML comments are stripped. */
export function shouldEnrichBody(body: string | null): boolean {
  if (body === null || body.trim().length === 0) return true;
  const stripped = body.replace(/<!--[\s\S]*?-->/g, "");
  return stripped.trim().length < 100;
}

// ─── Managed body section ─────────────────────────────────────────────────────

export const MANAGED_BODY_START = "<!-- dispatch-groomer:managed:start -->";
export const MANAGED_BODY_END = "<!-- dispatch-groomer:managed:end -->";

export type ManagedBody =
  | { ok: true; human: string; before: string; after: string; managed: string | null }
  | { ok: false; reason: string };

/**
 * Split an issue body around its one Dispatch-managed section, if present.
 * `human` is the human-authored text (everything outside the section).
 * Malformed markers (unpaired, repeated, or out of order) are reported rather
 * than guessed at, so a human edit that broke them never makes the groomer
 * rewrite text it does not own.
 */
export function parseManagedBody(body: string | null): ManagedBody {
  const text = body ?? "";
  const starts = text.split(MANAGED_BODY_START).length - 1;
  const ends = text.split(MANAGED_BODY_END).length - 1;
  if (starts === 0 && ends === 0) return { ok: true, human: text, before: text, after: "", managed: null };
  if (starts !== 1 || ends !== 1) return { ok: false, reason: "the managed section markers are unpaired or repeated" };
  const start = text.indexOf(MANAGED_BODY_START);
  const end = text.indexOf(MANAGED_BODY_END);
  if (end < start) return { ok: false, reason: "the managed section end marker precedes its start" };
  const before = text.slice(0, start);
  const after = text.slice(end + MANAGED_BODY_END.length);
  const managed = text.slice(start + MANAGED_BODY_START.length, end).trim();
  const human = [before.trim(), after.trim()].filter((part) => part.length > 0).join("\n\n");
  return { ok: true, human, before, after, managed };
}

function managedSection(content: string): string {
  const cleaned = content.split(MANAGED_BODY_START).join("").split(MANAGED_BODY_END).join("").trim();
  return `${MANAGED_BODY_START}\n${cleaned}\n${MANAGED_BODY_END}`;
}

/**
 * The body with `content` as its one managed section. An existing section is
 * replaced in place; otherwise the section is appended after the
 * human-authored text. Text outside the section is kept byte for byte, so
 * re-rendering the same content is a fixed point.
 */
export function renderManagedBody(parsed: Extract<ManagedBody, { ok: true }>, content: string): string {
  const section = managedSection(content);
  if (parsed.managed !== null) return `${parsed.before}${section}${parsed.after}`;
  const human = parsed.before;
  if (human.trim().length === 0) return section;
  const separator = human.endsWith("\n\n") ? "" : human.endsWith("\n") ? "\n" : "\n\n";
  return `${human}${separator}${section}`;
}

// ─── Comment marker ───────────────────────────────────────────────────────────

/** Only the marker Dispatch appends counts: it must end the comment. */
const COMMENT_MARKER_PATTERN = /<!-- dispatch-groomer:apply=([0-9a-f]{64}) -->\s*$/;
/** Any Dispatch groomer marker, to strip from model-written text. */
const ANY_GROOMER_MARKER = /<!--\s*dispatch-groomer:[\s\S]*?-->/g;

export function commentMarker(applicationKey: string): string {
  return `<!-- dispatch-groomer:apply=${applicationKey} -->`;
}

/** The application key a groomer comment carries, if any. */
export function commentMarkerKey(body: string): string | null {
  return COMMENT_MARKER_PATTERN.exec(body)?.[1] ?? null;
}

/**
 * The application key of a comment Dispatch itself posted. A marker in a
 * comment by anyone else is ignored, so a user cannot forge one to suppress
 * or impersonate groomer comments.
 */
export function groomerCommentKey(comment: Pick<LiveComment, "author" | "body">): string | null {
  return isAutomationAuthor(comment.author) ? commentMarkerKey(comment.body) : null;
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

/**
 * The plan's decomposition intent, when the plan splits the issue into
 * bounded children (dispatch#1066). `null` when the plan does not decompose
 * (or the decomposition was withheld at apply time).
 */
export interface DecompositionIntent {
  briefs: ChildBrief[];
  reason: string | null;
}

export interface GroomingMutationDiff {
  /** The effective legacy view the diff was computed from (after any withholding). */
  output: GroomerOutput;
  /** Why an intended close, ready promotion or decomposition was withheld at apply time. */
  withheld: { close?: string[]; ready?: string[]; decomposition?: string[] };
  labelsBefore: string[];
  /** Final label set. */
  labelsAfter: string[];
  /** Label set of the labels step; differs from labelsAfter only for a close (status/done lands after the close). */
  labelsStep: string[];
  lane: string;
  /** Comment text without the marker; null for none. */
  comment: string | null;
  /** New title; null when unchanged. */
  title: string | null;
  /** New full body; null when unchanged. */
  body: string | null;
  /** Why proposed body enrichment was not applied, when it was not. */
  bodySkippedReason: string | null;
  close: boolean;
  /** The plan's decomposition intent; null when the plan does not decompose. */
  children: DecompositionIntent | null;
}

export interface MutationDiffInput {
  plan: GroomingPlan;
  live: LiveIssueState;
  catalog: EvidenceCatalog;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * The plan with its close or ready promotion withheld: it lands as backlog in
 * the non-claimable lane, and its comment/title/body (written for the
 * withheld decision) are dropped. Only priority/type labels still apply.
 */
function withholdPlan(plan: GroomingPlan, what: string, reasons: string[]): GroomingPlan {
  const backlog = getBacklogLane();
  const rationale = clip(`Dispatch withheld the ${what}: ${reasons.join("; ")}. Model rationale: ${plan.verdict.rationale}`, 1000);
  return {
    ...plan,
    verdict: {
      ...plan.verdict,
      actionability: "backlog",
      rationale,
      lane: backlog
        ? { ...plan.verdict.lane, id: backlog.id, reason: `${plan.verdict.lane.reason} [withheld ${what}]` }
        : { ...plan.verdict.lane },
    },
    mutations: {
      ...plan.mutations,
      status: "status/backlog",
      close: null,
      githubComment: null,
      proposedTitle: null,
      proposedBody: null,
    },
    readiness: {
      ready: false,
      admission: null,
      lane: null,
      evidenceDigest: plan.readiness.evidenceDigest,
      reasons: [`withheld ${what}: ${reasons.join("; ")}`],
    },
  };
}

/**
 * Compute exactly what to write, against the live issue. The close and ready
 * policies are applied here, so nothing downstream can write status/done or
 * status/ready for a plan that does not satisfy them.
 */
export function computeMutationDiff(input: MutationDiffInput): GroomingMutationDiff {
  const { plan, live, catalog } = input;
  const withheld: GroomingMutationDiff["withheld"] = {};
  let effective = plan;
  if (plan.verdict.actionability === "already_done") {
    const reasons = evaluateClosePolicy(plan, catalog);
    if (reasons.length > 0) {
      withheld.close = reasons;
      effective = withholdPlan(plan, "already_done close", reasons);
    }
  } else if (plan.mutations.status === "status/ready") {
    const reasons = evaluateReadyPolicy(plan, catalog);
    if (reasons.length > 0) {
      withheld.ready = reasons;
      effective = withholdPlan(plan, "ready promotion", reasons);
    }
  }

  // The decomposition is a separate, independent decision from the close and
  // ready promotions above: a plan that splits the issue into children is
  // withheld only when its own decomposition policy fails (a close in the
  // same plan, low confidence, or a material uncertainty), never because the
  // close or ready policy did.
  let children: DecompositionIntent | null =
    plan.decomposition.required && plan.decomposition.childBriefs.length > 0
      ? { briefs: plan.decomposition.childBriefs, reason: plan.decomposition.reason }
      : null;
  if (children) {
    const reasons = evaluateDecompositionPolicy(plan);
    if (reasons.length > 0) {
      withheld.decomposition = reasons;
      children = null;
    }
  }

  const output = toGroomerOutput(effective, live.labels);
  const done = effective.verdict.actionability === "already_done";
  const labelsBefore = [...live.labels];
  // status/ready can only be the derived status of a plan whose readiness
  // held (the validator and the ready policy above both require it).
  const labelsAfter = withDerivedStatus(
    applyLabelChanges(labelsBefore, output.labelsToAdd, output.labelsToRemove),
    effective.mutations.status,
  );

  // The umbrella label is deliberately NOT part of labelsAfter (and so not of
  // the labels step): it is added by the children step, and only after every
  // child exists or is reused. The groomer selector excludes umbrella-labeled
  // issues from selection on every path — including a targeted re-groom by
  // issueNumber (which bypasses only the grooming-state exclusion, not the
  // umbrella one) — so landing the umbrella first would make a decomposition
  // that fails halfway un-reselectable, breaking "a partial create converges on
  // retry". The label we write is still folded into ApplyResult.labels below so
  // the freshness baseline and audit record it.
  // status/done lands only after the close succeeds, so a failed close
  // leaves the issue open with its previous status (still groomable),
  // never open with status/done (which the selector skips forever). An issue
  // that carried several statuses is collapsed to status/backlog here, so a
  // failed close cannot leave it with more than one.
  const liveStatuses = labelsBefore.filter((l) => l.startsWith("status/"));
  const withoutStatus = labelsAfter.filter((l) => !l.startsWith("status/"));
  const labelsStep = !done
    ? labelsAfter
    : liveStatuses.length > 1
      ? withDerivedStatus(labelsAfter, "status/backlog")
      : [...withoutStatus, ...liveStatuses];

  // Model text written to the issue never carries a live @-mention.
  const proposedTitle = output.proposedTitle !== undefined ? neutralizeMentions(output.proposedTitle) : undefined;
  const title =
    proposedTitle !== undefined && shouldRewriteTitle(live.title) && proposedTitle !== live.title ? proposedTitle : null;

  let body: string | null = null;
  let bodySkippedReason: string | null = null;
  if (output.proposedBody !== undefined) {
    const parsed = parseManagedBody(live.body);
    if (!parsed.ok) {
      bodySkippedReason = parsed.reason;
    } else if (!shouldEnrichBody(parsed.human)) {
      bodySkippedReason = "the human-authored body is not sparse";
    } else {
      const rendered = renderManagedBody(parsed, neutralizeMentions(output.proposedBody));
      if (rendered !== (live.body ?? "")) body = rendered;
      else bodySkippedReason = "the managed section already holds this content";
    }
  }

  // The model's text never carries a Dispatch marker of its own.
  const rawComment = output.githubComment?.replace(ANY_GROOMER_MARKER, "").trim();
  const comment = rawComment ? neutralizeMentions(rawComment) : null;

  return {
    output,
    withheld,
    labelsBefore,
    labelsAfter,
    labelsStep,
    lane: output.lane.id,
    comment,
    title,
    body,
    bodySkippedReason,
    close: done && live.state === "open" && inFlightStatus(live.labels) === null,
    children,
  };
}

/**
 * Stable identity of one logical application: this repo and issue, the
 * evidence the plan was bound to, the plan schema version, and the
 * normalized mutation intent (the final state the diff writes).
 */
export function computeApplicationKey(input: {
  repoFullName: string;
  issueNumber: number;
  plan: GroomingPlan;
  diff: GroomingMutationDiff;
}): string {
  const { diff } = input;
  const canonical = {
    v: APPLICATION_KEY_VERSION,
    repo: input.repoFullName.toLowerCase(),
    issue: input.issueNumber,
    evidenceDigest: input.plan.evidence.evidenceDigest,
    planVersion: input.plan.schemaVersion,
    intent: {
      labels: [...new Set(diff.labelsAfter)].sort(),
      lane: diff.lane,
      comment: diff.comment,
      title: diff.title,
      body: diff.body,
      close: diff.close,
      // The decomposition is part of the intent: its children are the stable
      // childBriefKeys, so a change to the split (or its withholding) changes
      // the application key. Sorted, because the brief order is not identity —
      // the same set of children in a different order is the same application.
      children: diff.children
        ? diff.children.briefs.map((brief) => childBriefKey(input.repoFullName, input.issueNumber, brief)).sort()
        : null,
    },
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ─── Application ──────────────────────────────────────────────────────────────

/**
 * A step write that failed partway, carrying the partial result that did
 * complete (e.g. the children created before a later child's create threw) so
 * the failed step record — and a retry — can see and reuse it.
 */
export class PartialStepError extends Error {
  constructor(message: string, readonly partial: Partial<ApplyStepResult>) {
    super(message);
    this.name = "PartialStepError";
  }
}

export const APPLY_STEPS = ["labels", "comment", "content", "children", "close", "done_label"] as const;
export type ApplyStep = (typeof APPLY_STEPS)[number];

/**
 * - applied: written this attempt.
 * - replayed: already written by an earlier attempt of this key (recorded,
 *   or found on GitHub by its marker); not repeated.
 * - noop: live state already matches; nothing to write.
 * - skipped: deliberately not written (comment cooldown).
 * - failed: the write failed; later steps were not attempted.
 * - not_attempted: an earlier step failed.
 */
export type ApplyStepStatus = "applied" | "replayed" | "noop" | "skipped" | "failed" | "not_attempted";

/** A created-or-reused child issue, auditable from the run and the parent. */
export interface ChildIssueLink {
  key: string;
  number: number;
  url: string;
}

/** The child issues a decomposition step created and reused this attempt. */
export interface AppliedChildIssues {
  created: ChildIssueLink[];
  reused: ChildIssueLink[];
}

export interface ApplyStepResult {
  status: ApplyStepStatus;
  detail?: string;
  error?: string;
  commentUrl?: string | null;
  at?: string;
  /** Children step: the child issues created and reused this attempt. */
  children?: AppliedChildIssues;
}

export type ApplySteps = Partial<Record<ApplyStep, ApplyStepResult>>;

/**
 * - applied: at least one write, no failure.
 * - noop: nothing needed writing.
 * - partial: some writes landed, a later one failed.
 * - failed: the first needed write failed; nothing landed.
 * - replayed: this key was already fully applied; nothing written.
 * - busy: another attempt claimed this key moments ago and has not finished;
 *   nothing written, so two attempts never apply the same plan at once.
 */
export type ApplyOutcome = "applied" | "noop" | "partial" | "failed" | "replayed" | "busy";

/**
 * An unfinished claim younger than this belongs to an attempt that may still
 * be running; an older one was abandoned (a crash) and may be resumed. Matches
 * the hosted groomer's issue lease TTL.
 */
export const ACTIVE_CLAIM_MS = 10 * 60 * 1000;

export interface ApplicationRecord {
  applicationKey: string;
  groomingRunId: string | null;
  status: string;
  steps: unknown;
  attempts: number;
  updatedAt?: Date | string | null;
}

/**
 * A GroomingChildClaim row, as the applier reads it: the stable child key and
 * the created child's number/URL once the creation has been recorded. A claim
 * whose childNumber is null means the creation write has not been recorded, so
 * re-creating it covers a crashed attempt — though a create whose response was
 * lost after GitHub accepted it can still duplicate, which the child body
 * marker exists to surface for manual discovery.
 */
export interface ChildClaimRecord {
  childKey: string;
  childNumber: number | null;
  childUrl: string | null;
  /**
   * The application that claimed this child (dispatch#1066); null for rows
   * written before the column existed (none in any deployed env). A same-key
   * retry is provably exclusive — the GroomingApplication claim/resume CAS
   * lets exactly one attempt per application key proceed — so a null claim
   * under MY key is my own abandoned create, not a concurrent holder.
   */
  applicationKey: string | null;
  /** When the claim row was last written; the prisma store returns it. */
  updatedAt?: Date | string | null;
}

export interface ApplicationStore {
  /** The record for a key, if one exists. Read-only (dry runs use it). */
  find(applicationKey: string): Promise<ApplicationRecord | null>;
  /** Claim the key. `existing` is the prior record when the key was already claimed. */
  claim(input: {
    applicationKey: string;
    issueId: string;
    groomingRunId: string;
    repoFullName: string;
    issueNumber: number;
  }): Promise<{ existing: ApplicationRecord | null }>;
  save(applicationKey: string, data: { status: string; steps: ApplySteps }): Promise<void>;
  /**
   * Take over an unfinished claim, atomically: succeeds only if the record is
   * still as `seen` (same status and attempt count), so of two attempts
   * resuming the same abandoned claim exactly one proceeds.
   */
  resume(applicationKey: string, seen: ApplicationRecord): Promise<boolean>;
  /** Whether a hosted-groomer comment was recorded on this issue since `since`. */
  hasRecentComment(issueId: string, since: Date): Promise<boolean>;
  /**
   * Claim a child key, atomically (dispatch#1066). `existing` is the prior
   * claim when the child was already created, so a retry reuses it rather than
   * creating a second child. `applicationKey` is recorded on a new claim so a
   * same-key retry can tell its own abandoned create apart from a fresh
   * claim held by a DIFFERENT application.
   */
  claimChild(input: {
    childKey: string;
    parentIssueId: string;
    repoFullName: string;
    parentNumber: number;
    title: string;
    applicationKey: string;
  }): Promise<{ existing: ChildClaimRecord | null }>;
  /** Record the created child's number and URL on its claim. */
  saveChild(childKey: string, data: { childNumber: number; childUrl: string }): Promise<void>;
  /**
   * Persist a parent's decomposition state and its audit entry (dispatch#1066),
   * sharing the operator route's persistence path.
   */
  setDecompositionState(input: {
    issue: { id: string; labels: readonly string[] };
    repoFullName: string;
    issueNumber: number;
    actor: string;
    decomposed: boolean;
    note: string | null;
    followUpUrls: string[];
  }): Promise<void>;
}

export interface ApplierGitHub {
  updateLabels(repoFullName: string, issueNumber: number, labels: string[]): Promise<void>;
  addComment(repoFullName: string, issueNumber: number, body: string): Promise<{ url: string | null }>;
  updateTitleAndBody(repoFullName: string, issueNumber: number, fields: { title?: string; body?: string | null }): Promise<void>;
  closeIssue(repoFullName: string, issueNumber: number): Promise<void>;
  /** Newest first; used to find a comment that landed before its write reported success. */
  fetchRecentComments(repoFullName: string, issueNumber: number, max: number): Promise<LiveComment[]>;
  /** Open a new issue (a decomposition child); returns its number and URL. */
  createIssue(repoFullName: string, input: { title: string; body: string; labels?: string[] }): Promise<{ number: number; url: string }>;
  /** Add a single label to the issue (the children step's umbrella). */
  addLabel(repoFullName: string, issueNumber: number, label: string): Promise<void>;
}

export interface ApplyInput {
  repoFullName: string;
  issueNumber: number;
  issueId: string;
  /** The parent issue's URL, so a child body can link back to it. */
  parentUrl: string;
  groomingRunId: string;
  applicationKey: string;
  diff: GroomingMutationDiff;
  /** Comments re-read by the preconditions, newest first. */
  recentComments: LiveComment[];
  force: boolean;
  commentCooldownHours: number;
  now?: () => Date;
}

export interface ApplyResult {
  outcome: ApplyOutcome;
  steps: ApplySteps;
  /** The run that first claimed this key, when it was not this run. */
  claimedByRunId: string | null;
  commentUrl: string | null;
  /** Labels on GitHub after this attempt, as far as the recorded steps show. */
  labels: string[];
  /** Child issues created or reused this attempt, in brief order. */
  children: ChildIssueLink[];
  title: string | null;
  body: string | null;
  closed: boolean;
  failure: { step: ApplyStep; error: string } | null;
}

function readSteps(value: unknown): ApplySteps {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const steps: ApplySteps = {};
  for (const step of APPLY_STEPS) {
    const entry = (value as Record<string, unknown>)[step];
    if (entry && typeof entry === "object" && typeof (entry as ApplyStepResult).status === "string") {
      steps[step] = entry as ApplyStepResult;
    }
  }
  return steps;
}

function landed(result: ApplyStepResult | undefined): boolean {
  return result?.status === "applied" || result?.status === "replayed";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The comment body with its marker, within GitHub's comment cap. */
export function commentBodyWithMarker(comment: string, applicationKey: string): string {
  const marker = commentMarker(applicationKey);
  const room = MAX_GITHUB_COMMENT_CHARS - marker.length - 2;
  return `${comment.slice(0, room)}\n\n${marker}`;
}

/**
 * Apply a diff under its application key. Never throws for a GitHub write
 * failure: the failure is recorded on its step and later steps are not
 * attempted. Store failures while recording progress are logged and do not
 * undo a write that already landed.
 */
export async function applyGroomingMutations(
  input: ApplyInput,
  github: ApplierGitHub,
  store: ApplicationStore,
): Promise<ApplyResult> {
  const now = input.now ?? (() => new Date());
  const { diff, repoFullName, issueNumber, applicationKey } = input;
  const { existing } = await store.claim({
    applicationKey,
    issueId: input.issueId,
    groomingRunId: input.groomingRunId,
    repoFullName,
    issueNumber,
  });
  const prior = readSteps(existing?.steps);
  const claimedByRunId = existing && existing.groomingRunId !== input.groomingRunId ? existing.groomingRunId : null;
  const nothing = {
    claimedByRunId,
    commentUrl: null,
    labels: diff.labelsBefore,
    children: [] as ChildIssueLink[],
    title: null,
    body: null,
    closed: false,
    failure: null,
  };

  if (existing && existing.status !== "applied") {
    const updatedAt = existing.updatedAt ? new Date(existing.updatedAt).getTime() : NaN;
    if (existing.status === "in_progress" && Number.isFinite(updatedAt) && now().getTime() - updatedAt < ACTIVE_CLAIM_MS) {
      return { outcome: "busy", steps: prior, ...nothing };
    }
    if (!(await store.resume(applicationKey, existing))) {
      return { outcome: "busy", steps: prior, ...nothing };
    }
  }

  if (existing?.status === "applied") {
    const commentUrl = prior.comment?.commentUrl ?? null;
    // A replay surfaces the children an earlier attempt created or reused.
    const children = prior.children?.children
      ? [...prior.children.children.created, ...prior.children.children.reused]
      : [];
    return {
      outcome: "replayed",
      steps: Object.fromEntries(
        Object.entries(prior).map(([step, result]) => [
          step,
          landed(result) ? { ...result, status: "replayed" as const } : result,
        ]),
      ) as ApplySteps,
      ...nothing,
      commentUrl,
      children,
    };
  }

  const steps: ApplySteps = {};
  let failure: ApplyResult["failure"] = null;
  let commentUrl: string | null = null;
  let labels = diff.labelsBefore;

  const persist = async (status: string) => {
    try {
      await store.save(applicationKey, { status, steps });
    } catch (err) {
      console.warn(`[groomer] ${repoFullName}#${issueNumber}: failed to record application progress:`, err);
    }
  };

  const run = async (
    step: ApplyStep,
    needed: boolean,
    write: () => Promise<Omit<ApplyStepResult, "at" | "status"> | void>,
    noopDetail?: string,
  ): Promise<void> => {
    if (landed(prior[step])) {
      steps[step] = { ...prior[step]!, status: "replayed" };
      if (step === "comment") commentUrl = prior.comment?.commentUrl ?? null;
      return;
    }
    if (failure) {
      steps[step] = { status: "not_attempted", detail: `halted after ${failure.step} failed` };
      return;
    }
    if (!needed) {
      steps[step] = { status: "noop", ...(noopDetail ? { detail: noopDetail } : {}) };
      return;
    }
    try {
      const result = await write();
      steps[step] = { status: "applied", ...(result ?? {}), at: now().toISOString() };
    } catch (err) {
      const error = errorMessage(err);
      // A PartialStepError carries the partial result that completed (e.g. the
      // children created before a later create threw), so the failed step
      // record — and a retry — can see and reuse it.
      steps[step] = {
        status: "failed",
        error,
        ...(err instanceof PartialStepError ? err.partial : {}),
        at: now().toISOString(),
      };
      failure = { step, error };
      console.error(`[groomer] ${repoFullName}#${issueNumber}: ${step} failed; later steps not attempted:`, err);
    }
    await persist("in_progress");
  };

  // 1. Labels (status, priority, type). The lowest-impact write, and the one
  //    every later step depends on.
  await run("labels", !sameLabelSet(diff.labelsStep, diff.labelsBefore), async () => {
    await github.updateLabels(repoFullName, issueNumber, diff.labelsStep);
    labels = diff.labelsStep;
  }, "labels already match");

  // 2. Comment. A comment carrying this key's marker is already this
  //    application's comment; a groomer comment inside the cooldown window
  //    (recorded on a run, or found on GitHub by its marker) suppresses a new one.
  let commentDecision: ApplyStepResult | null = null;
  if (!failure && !landed(prior.comment) && diff.comment) {
    const own = input.recentComments.find((c) => groomerCommentKey(c) === applicationKey);
    if (own) {
      commentDecision = { status: "replayed", detail: "already posted for this application", commentUrl: own.url };
      commentUrl = own.url;
    } else if (!input.force && input.commentCooldownHours > 0) {
      const since = new Date(now().getTime() - input.commentCooldownHours * 60 * 60 * 1000);
      const markedRecently = input.recentComments.some((c) => {
        const at = Date.parse(c.createdAt);
        return groomerCommentKey(c) !== null && Number.isFinite(at) && at >= since.getTime();
      });
      if (markedRecently || (await store.hasRecentComment(input.issueId, since))) {
        commentDecision = { status: "skipped", detail: "cooldown" };
      }
    }
  }
  if (commentDecision) {
    steps.comment = commentDecision;
    await persist("in_progress");
  } else {
    await run("comment", diff.comment !== null, async () => {
      const body = commentBodyWithMarker(diff.comment!, applicationKey);
      let posted: { url: string | null };
      try {
        posted = await github.addComment(repoFullName, issueNumber, body);
      } catch (first) {
        // The write may have landed even though it reported failure (e.g. a
        // 504 after GitHub accepted it). Look for the marker before retrying.
        let found: LiveComment | undefined;
        try {
          found = (await github.fetchRecentComments(repoFullName, issueNumber, 10)).find(
            (c) => groomerCommentKey(c) === applicationKey,
          );
        } catch {
          // Cannot tell whether the first write landed: retrying could post
          // it twice, so fail the step; a later attempt finds the marker.
          throw first;
        }
        if (found) {
          posted = { url: found.url };
        } else {
          try {
            posted = await github.addComment(repoFullName, issueNumber, body);
          } catch {
            throw first;
          }
        }
      }
      commentUrl = posted.url ?? null;
      return { commentUrl };
    }, "no comment in the plan");
  }

  // 3. Title and body, in one write. The body change only ever replaces the
  //    Dispatch-managed section; the title only replaces a bad title.
  const fields: { title?: string; body?: string } = {};
  if (diff.title !== null) fields.title = diff.title;
  if (diff.body !== null) fields.body = diff.body;
  await run("content", Object.keys(fields).length > 0, async () => {
    await github.updateTitleAndBody(repoFullName, issueNumber, fields);
    return { detail: Object.keys(fields).join("+") };
  }, diff.bodySkippedReason ?? "title and body unchanged");

  // 4. Children (dispatch#1066): one bounded child issue per brief. Creation
  //    is idempotent through the GroomingChildClaim keyed by the childBriefKey
  //    (a retry reuses a created child and creates only the missing ones). Only
  //    after every child exists or is reused does this step record the parent's
  //    decomposition state with the child URLs as the follow-ups, and only then
  //    add the umbrella label (an additive write) last. The umbrella lands last
  //    — after the state write — so a decomposition that fails mid-create, or
  //    whose state write fails, leaves the parent still re-selectable (the
  //    selector excludes umbrella issues) and converges on retry. It lands
  //    before the close, so a close is never applied on top of a decomposition
  //    that failed to land.
  const children = diff.children;
  let appliedChildren: ChildIssueLink[] = [];
  await run(
    "children",
    children !== null,
    async () => {
      if (children === null) return;
      const parentTarget: ChildIssueTarget = { repoFullName, number: issueNumber, url: input.parentUrl };
      const created: ChildIssueLink[] = [];
      const reused: ChildIssueLink[] = [];
      const links: ChildIssueLink[] = [];
      try {
        for (const brief of children.briefs) {
          const childKey = childBriefKey(repoFullName, issueNumber, brief);
          const { existing } = await store.claimChild({
            childKey,
            parentIssueId: input.issueId,
            repoFullName,
            parentNumber: issueNumber,
            title: brief.title,
            applicationKey: input.applicationKey,
          });
          if (existing && existing.childNumber !== null && existing.childUrl !== null) {
            // An earlier attempt already created this child.
            const link: ChildIssueLink = { key: childKey, number: existing.childNumber, url: existing.childUrl };
            reused.push(link);
            links.push(link);
          } else {
            // A null claim under a DIFFERENT application key with a fresh
            // updatedAt is held by another in-flight attempt claiming the same
            // child; do not create a duplicate on top of it. A null claim under
            // THIS key is my own abandoned create: the GroomingApplication
            // resume CAS already excludes a concurrent same-key attempt, so
            // creating on top of it is how an immediate same-key retry
            // converges. A row with no applicationKey (none exists in any
            // deployed env; the migration ships with the feature) is not mine,
            // so a fresh one is a foreign holder.
            const heldAt = existing?.updatedAt ? new Date(existing.updatedAt).getTime() : NaN;
            if (
              existing &&
              existing.childNumber === null &&
              existing.applicationKey !== input.applicationKey &&
              Number.isFinite(heldAt) &&
              now().getTime() - heldAt < ACTIVE_CLAIM_MS
            ) {
              throw new Error(`child claim ${childKey} is held by another in-flight attempt`);
            }
            const body = renderChildIssueBody({
              brief,
              parent: parentTarget,
              decompositionReason: children.reason,
              childKey,
            });
            const issue = await github.createIssue(repoFullName, {
              title: brief.title,
              body,
              labels: [...CHILD_ISSUE_LABELS],
            });
            await store.saveChild(childKey, { childNumber: issue.number, childUrl: issue.url });
            const link: ChildIssueLink = { key: childKey, number: issue.number, url: issue.url };
            created.push(link);
            links.push(link);
          }
        }
        appliedChildren = links;
        // Record the decomposition state with the parent's label set at the
        // moment of the state write (labelsAfter — the umbrella genuinely is
        // not on the issue yet) and the child URLs, BEFORE the umbrella add:
        // a failure here — like a failed child create above — must leave the
        // parent still re-selectable, so the umbrella, which removes it from
        // every selection path, is the step's final write. The audit entry
        // records labels at state-write time; the umbrella add lands
        // afterwards and its own success/failure is visible on the children
        // step record and the run's groom audit, so the entry never claims a
        // label that has not landed.
        await store.setDecompositionState({
          issue: { id: input.issueId, labels: diff.labelsAfter },
          repoFullName,
          issueNumber,
          actor: "hosted-groomer",
          decomposed: true,
          note: children.reason,
          followUpUrls: links.map((child) => child.url),
        });
        // The umbrella lands last, now that every child exists or is reused and
        // the decomposition state is recorded; a failed create or a failed
        // state write throws before this line, so a partial decomposition never
        // lands the umbrella.
        await github.addLabel(repoFullName, issueNumber, UMBRELLA_LABEL);
        return { children: { created, reused }, detail: `${created.length} created, ${reused.length} reused` };
      } catch (err) {
        // Carry what completed so far so the failed step record (and a retry)
        // can see the children that did land.
        throw new PartialStepError(errorMessage(err), { children: { created, reused } });
      }
    },
    "no decomposition in the plan",
  );

  // 5. Close, the highest-impact write, only after everything above landed.
  await run("close", diff.close, async () => {
    await github.closeIssue(repoFullName, issueNumber);
  }, "no close in the plan");

  // 6. status/done, only once the issue is actually closed.
  const closed = landed(steps.close);
  await run(
    "done_label",
    closed && !sameLabelSet(diff.labelsAfter, diff.labelsStep),
    async () => {
      await github.updateLabels(repoFullName, issueNumber, diff.labelsAfter);
    },
    "no status change after close",
  );

  if (landed(steps.labels)) labels = diff.labelsStep;
  if (landed(steps.done_label)) labels = diff.labelsAfter;
  // The children step writes the umbrella additively (it is not part of
  // diff.labelsAfter), so fold in the label we actually wrote. A union with the
  // current set (not a reset to diff.labelsAfter) keeps whatever the labels /
  // done-label step landed while adding the umbrella the children step wrote.
  if (landed(steps.children)) labels = [...new Set([...labels, UMBRELLA_LABEL])];

  const wrote = APPLY_STEPS.some((step) => steps[step]?.status === "applied" || steps[step]?.status === "replayed");
  const outcome: ApplyOutcome = failure ? (wrote ? "partial" : "failed") : wrote ? "applied" : "noop";
  await persist(failure ? (wrote ? "partial" : "failed") : "applied");

  return {
    outcome,
    steps,
    claimedByRunId,
    commentUrl,
    labels,
    children: appliedChildren,
    title: landed(steps.content) && diff.title !== null ? diff.title : null,
    body: landed(steps.content) && diff.body !== null ? diff.body : null,
    closed,
    failure,
  };
}

// ─── Prisma store ─────────────────────────────────────────────────────────────

interface GroomingApplicationDelegateLike {
  findUnique(args: { where: { applicationKey: string } }): Promise<ApplicationRecord | null>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  update(args: { where: { applicationKey: string }; data: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

/**
 * The slice of the Prisma client the application store needs. Extends
 * `DecompositionStateClient` so the store can also persist a parent's
 * decomposition state through the shared helper (dispatch#1066).
 */
export interface ApplicationStoreClient extends DecompositionStateClient {
  groomingApplication: GroomingApplicationDelegateLike;
  groomingRun: { findFirst(args: unknown): Promise<unknown> };
  /** GroomingChildClaim rows keying a decomposition's children (dispatch#1066). */
  groomingChildClaim: {
    findUnique(args: { where: { childKey: string } }): Promise<ChildClaimRecord | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    update(args: { where: { childKey: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * GroomingApplication-backed store. The unique applicationKey makes the
 * claim atomic: a concurrent claimant loses with P2002 and reads the winner.
 */
export function makePrismaApplicationStore(client: ApplicationStoreClient): ApplicationStore {
  const delegate = client.groomingApplication;
  return {
    find(applicationKey) {
      return delegate.findUnique({ where: { applicationKey } });
    },
    async claim(input) {
      const existing = await delegate.findUnique({ where: { applicationKey: input.applicationKey } });
      if (existing) return { existing };
      try {
        await delegate.create({
          data: {
            applicationKey: input.applicationKey,
            issueId: input.issueId,
            groomingRunId: input.groomingRunId,
            repoFullName: input.repoFullName,
            issueNumber: input.issueNumber,
            status: "in_progress",
            steps: {},
          },
        });
        return { existing: null };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        return { existing: await delegate.findUnique({ where: { applicationKey: input.applicationKey } }) };
      }
    },
    async save(applicationKey, data) {
      await delegate.update({ where: { applicationKey }, data: { status: data.status, steps: data.steps } });
    },
    async resume(applicationKey, seen) {
      // Compare-and-swap on the record as read, with attempts as the version:
      // the winner bumps it, so a second resumer holding the same read
      // matches nothing. Every run that works on the application records its
      // key on its own GroomingRun, so attribution is by applicationKey.
      const { count } = await delegate.updateMany({
        where: { applicationKey, status: seen.status, attempts: seen.attempts },
        data: { attempts: { increment: 1 } },
      });
      return count > 0;
    },
    async hasRecentComment(issueId, since) {
      // A run's comment lands between its createdAt and its last update, so
      // updatedAt is the conservative bound: a run still inside the window
      // may have posted inside it.
      const recent = await client.groomingRun.findFirst({
        where: { issueId, commentUrl: { not: null }, updatedAt: { gte: since } },
      });
      return recent !== null && recent !== undefined;
    },
    async claimChild(input) {
      // The unique childKey makes the claim atomic: a concurrent creator for
      // the same child loses with P2002 and reads the winner's row, so two
      // attempts never create the same child twice. The create records
      // applicationKey (and findUnique selects it back), so a same-key retry
      // can tell its own abandoned create apart from a foreign in-flight
      // holder.
      const child = client.groomingChildClaim;
      const existing = await child.findUnique({ where: { childKey: input.childKey } });
      if (existing) return { existing };
      try {
        await child.create({
          data: {
            childKey: input.childKey,
            parentIssueId: input.parentIssueId,
            repoFullName: input.repoFullName,
            parentNumber: input.parentNumber,
            title: input.title,
            applicationKey: input.applicationKey,
          },
        });
        return { existing: null };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        return { existing: await child.findUnique({ where: { childKey: input.childKey } }) };
      }
    },
    async saveChild(childKey, data) {
      await client.groomingChildClaim.update({ where: { childKey }, data });
    },
    async setDecompositionState(input) {
      await setDecompositionState(client, input);
    },
  };
}
