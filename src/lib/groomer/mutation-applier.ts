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
import { getBacklogLane } from "@/lib/lane-config";
import { isAutomationAuthor } from "./context";
import { neutralizeMentions } from "./sanitize";
import { inFlightStatus, toGroomerOutput, type GroomingPlan } from "./plan";
import type { EvidenceCatalog } from "./plan-evidence";
import type { GroomerOutput } from "./schema";
import { evaluateClosePolicy, evaluateReadyPolicy, type LiveComment, type LiveIssueState } from "./mutation-validator";

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

export interface GroomingMutationDiff {
  /** The effective legacy view the diff was computed from (after any withholding). */
  output: GroomerOutput;
  /** Why an intended close or ready promotion was withheld at apply time. */
  withheld: { close?: string[]; ready?: string[] };
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

  const output = toGroomerOutput(effective, live.labels);
  const done = effective.verdict.actionability === "already_done";
  const labelsBefore = [...live.labels];
  // status/ready can only be the derived status of a plan whose readiness
  // held (the validator and the ready policy above both require it).
  const labelsAfter = withDerivedStatus(
    applyLabelChanges(labelsBefore, output.labelsToAdd, output.labelsToRemove),
    effective.mutations.status,
  );

  // status/done lands only after the close succeeds, so a failed close
  // leaves the issue open with its previous status (still groomable),
  // never open with status/done (which the selector skips forever).
  const labelsStep = done
    ? [...labelsAfter.filter((l) => !l.startsWith("status/")), ...labelsBefore.filter((l) => l.startsWith("status/"))]
    : labelsAfter;

  const proposedTitle = output.proposedTitle;
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
      const rendered = renderManagedBody(parsed, output.proposedBody);
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
    },
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ─── Application ──────────────────────────────────────────────────────────────

export const APPLY_STEPS = ["labels", "comment", "content", "close", "done_label"] as const;
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

export interface ApplyStepResult {
  status: ApplyStepStatus;
  detail?: string;
  error?: string;
  commentUrl?: string | null;
  at?: string;
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
  /** Record that an unfinished claim is being resumed by another attempt. */
  resume(applicationKey: string): Promise<void>;
  /** Whether a hosted-groomer comment was recorded on this issue since `since`. */
  hasRecentComment(issueId: string, since: Date): Promise<boolean>;
}

export interface ApplierGitHub {
  updateLabels(repoFullName: string, issueNumber: number, labels: string[]): Promise<void>;
  addComment(repoFullName: string, issueNumber: number, body: string): Promise<{ url: string | null }>;
  updateTitleAndBody(repoFullName: string, issueNumber: number, fields: { title?: string; body?: string | null }): Promise<void>;
  closeIssue(repoFullName: string, issueNumber: number): Promise<void>;
  /** Newest first; used to find a comment that landed before its write reported success. */
  fetchRecentComments(repoFullName: string, issueNumber: number, max: number): Promise<LiveComment[]>;
}

export interface ApplyInput {
  repoFullName: string;
  issueNumber: number;
  issueId: string;
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
  const nothing = { claimedByRunId, commentUrl: null, labels: diff.labelsBefore, title: null, body: null, closed: false, failure: null };

  if (existing && existing.status !== "applied") {
    const updatedAt = existing.updatedAt ? new Date(existing.updatedAt).getTime() : NaN;
    if (existing.status === "in_progress" && Number.isFinite(updatedAt) && now().getTime() - updatedAt < ACTIVE_CLAIM_MS) {
      return { outcome: "busy", steps: prior, ...nothing };
    }
    await store.resume(applicationKey);
  }

  if (existing?.status === "applied") {
    const commentUrl = prior.comment?.commentUrl ?? null;
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
    if (failure) {
      steps[step] = { status: "not_attempted", detail: `halted after ${failure.step} failed` };
      return;
    }
    if (landed(prior[step])) {
      steps[step] = { ...prior[step]!, status: "replayed" };
      if (step === "comment") commentUrl = prior.comment?.commentUrl ?? null;
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
      steps[step] = { status: "failed", error, at: now().toISOString() };
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
          found = undefined;
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

  // 4. Close, the highest-impact write, only after everything above landed.
  await run("close", diff.close, async () => {
    await github.closeIssue(repoFullName, issueNumber);
  }, "no close in the plan");

  // 5. status/done, only once the issue is actually closed.
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

  const wrote = APPLY_STEPS.some((step) => steps[step]?.status === "applied" || steps[step]?.status === "replayed");
  const outcome: ApplyOutcome = failure ? (wrote ? "partial" : "failed") : wrote ? "applied" : "noop";
  await persist(failure ? "partial" : "applied");

  return {
    outcome,
    steps,
    claimedByRunId,
    commentUrl,
    labels,
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
}

export interface ApplicationStoreClient {
  groomingApplication: GroomingApplicationDelegateLike;
  groomingRun: { findFirst(args: unknown): Promise<unknown> };
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
    async resume(applicationKey) {
      await delegate.update({ where: { applicationKey }, data: { attempts: { increment: 1 } } });
    },
    async hasRecentComment(issueId, since) {
      const recent = await client.groomingRun.findFirst({
        where: { issueId, commentUrl: { not: null }, createdAt: { gte: since } },
      });
      return recent !== null && recent !== undefined;
    },
  };
}
