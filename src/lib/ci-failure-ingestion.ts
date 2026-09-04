/**
 * Turn repeated CI failures on a repository's default branch into issues.
 *
 * `pr-followup` already ingests a failing check when it happens on a pull
 * request. The same failure on the default branch reaches nothing: it has no
 * PR, so nothing ingests it and nothing files anything. A release build that
 * breaks after a merge is therefore invisible to the queue.
 *
 * The policy this implements, and why:
 *
 * - **Only a second consecutive failure files.** One red run is weak evidence:
 *   network blips and rate limits are common and clear themselves. Two in a
 *   row with the same signature is a condition, not an accident.
 * - **Every workflow is eligible.** The repeat rule is the noise filter. An
 *   allowlist would silently exclude whichever workflow nobody remembered to
 *   add, which is the failure this exists to catch.
 * - **A green run closes the issue.** An auto-filed issue nobody auto-closes
 *   goes stale the moment CI recovers, and a queue of stale auto-issues trains
 *   people to ignore the label.
 * - **A recurrence files fresh, linking the old one.** A failure returning
 *   after its issue closed means the fix did not hold — new information, and it
 *   should re-enter the queue with its own priority rather than reopening an
 *   issue whose body describes a different occurrence.
 *
 * Deliberately holds no state of its own. Consecutiveness is read from the
 * workflow's own recent runs, and "already filed" from a marker in the issue
 * body — so there is no table to migrate and an instance that has never seen a
 * repo behaves exactly like one that has.
 */

import { createHash } from "crypto";

/** Marker embedded in an auto-filed issue body, mirroring the AI reviewer's. */
const MARKER_PREFIX = "dispatch-ci-failure";
const MARKER_RE = /<!--\s*dispatch-ci-failure:([a-z0-9]+)\s*-->/i;

/** A workflow run, narrowed to what this module needs. */
export interface CiRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  head_sha: string;
  html_url: string;
  updated_at: string;
}

export interface FailureSignatureInput {
  repoFullName: string;
  workflowName: string;
  jobName: string;
  logExcerpt: string;
}

/**
 * Stable identity for "this workflow is failing for this reason".
 *
 * The log excerpt is normalised before hashing so run-specific noise — ids,
 * timestamps, hex digests, durations — does not make every occurrence look
 * like a new failure. Without that, consecutive failures never match and
 * nothing is ever filed.
 */
export function computeFailureSignature(input: FailureSignatureInput): string {
  const normalised = (input.logExcerpt || "")
    .replace(/\b[0-9a-f]{7,64}\b/gi, "<hex>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, "<ts>")
    .replace(/\b\d+(\.\d+)?(ms|s|m|h)\b/gi, "<dur>")
    .replace(/\b\d{3,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
  return createHash("sha256")
    .update(`${input.repoFullName}\n${input.workflowName}\n${input.jobName}\n${normalised}`)
    .digest("hex")
    .slice(0, 16);
}

export function buildFailureMarker(signature: string): string {
  return `<!-- ${MARKER_PREFIX}:${signature} -->`;
}

export function extractFailureMarker(body: string | null | undefined): string | null {
  const m = MARKER_RE.exec(body || "");
  return m ? m[1].toLowerCase() : null;
}

/** Runs for one workflow on the default branch, newest first. */
export interface WorkflowHistory {
  workflowName: string;
  runs: CiRun[];
}

/**
 * Group completed default-branch runs by workflow, newest first.
 *
 * In-progress runs are excluded rather than treated as neither-failed-nor-
 * passed: a queued run says nothing about the condition, and letting it sit
 * between two failures would break the consecutiveness test.
 */
export function groupDefaultBranchRuns(runs: CiRun[], defaultBranch: string): WorkflowHistory[] {
  const byWorkflow = new Map<string, CiRun[]>();
  for (const run of runs) {
    if (run.head_branch !== defaultBranch) continue;
    if (run.status !== "completed") continue;
    if (!run.conclusion) continue;
    const list = byWorkflow.get(run.name) ?? [];
    list.push(run);
    byWorkflow.set(run.name, list);
  }
  return [...byWorkflow.entries()].map(([workflowName, list]) => ({
    workflowName,
    runs: list.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
  }));
}

export type WorkflowState =
  | { kind: "healthy"; latest: CiRun }
  | { kind: "first-failure"; latest: CiRun }
  | { kind: "repeated-failure"; latest: CiRun; previous: CiRun }
  | { kind: "unknown" };

/**
 * Classify a workflow from its recent default-branch history.
 *
 * `healthy` is what closes an existing issue; `repeated-failure` is what files
 * one. `first-failure` deliberately does neither — it is the transient case,
 * and acting on it is what would flood the queue.
 */
export function classifyWorkflow(history: WorkflowHistory): WorkflowState {
  const [latest, previous] = history.runs;
  if (!latest) return { kind: "unknown" };
  if (latest.conclusion === "success") return { kind: "healthy", latest };
  if (latest.conclusion !== "failure") return { kind: "unknown" };
  if (!previous || previous.conclusion !== "failure") {
    return { kind: "first-failure", latest };
  }
  return { kind: "repeated-failure", latest, previous };
}

export interface FiledIssue {
  number: number;
  state: "open" | "closed";
  signature: string;
}

export type IngestAction =
  | { action: "none"; reason: string }
  | { action: "file"; signature: string; supersedes: number | null }
  | { action: "close"; issueNumber: number; signature: string };

/**
 * Decide what to do about one workflow, given its state and any issues already
 * filed for it.
 *
 * Pure so the policy is testable without touching GitHub — every branch here
 * is a decision someone argued about on #931, and each one has a test.
 */
export function decideAction(
  state: WorkflowState,
  signature: string | null,
  filed: FiledIssue[],
): IngestAction {
  const openForSignature = filed.find((i) => i.state === "open" && i.signature === signature);

  if (state.kind === "healthy") {
    // Close whatever is open for this workflow, whichever signature it carries:
    // the workflow is green, so no failure of it is outstanding.
    const anyOpen = filed.find((i) => i.state === "open");
    return anyOpen
      ? { action: "close", issueNumber: anyOpen.number, signature: anyOpen.signature }
      : { action: "none", reason: "workflow is green and nothing is open" };
  }
  if (state.kind === "first-failure") {
    return { action: "none", reason: "first failure; waiting for a second to rule out a transient" };
  }
  if (state.kind === "unknown" || !signature) {
    return { action: "none", reason: "no actionable state" };
  }
  if (openForSignature) {
    return { action: "none", reason: `already filed as #${openForSignature.number}` };
  }
  // A closed issue for the same signature means the fix did not hold. File
  // fresh and link it rather than reopening a body that describes the earlier
  // occurrence and may already carry a merged PR.
  const closedForSignature = filed.find((i) => i.state === "closed" && i.signature === signature);
  return { action: "file", signature, supersedes: closedForSignature?.number ?? null };
}

export interface IssueDraft {
  title: string;
  body: string;
}

/** Render the issue an actionable failure produces. */
export function buildIssueDraft(opts: {
  repoFullName: string;
  workflowName: string;
  jobName: string;
  signature: string;
  latest: CiRun;
  previous: CiRun;
  logExcerpt: string;
  supersedes: number | null;
}): IssueDraft {
  const { workflowName, jobName, latest, previous, logExcerpt, supersedes } = opts;
  const excerpt = (logExcerpt || "").trim().slice(0, 4000) || "(no log excerpt available)";
  const lines = [
    `\`${workflowName}\` has failed twice in a row on the default branch, in the same job and for the same reason.`,
    "",
    `- Latest: [${latest.html_url}](${latest.html_url}) (\`${latest.head_sha.slice(0, 8)}\`)`,
    `- Previous: [${previous.html_url}](${previous.html_url}) (\`${previous.head_sha.slice(0, 8)}\`)`,
    `- Failing job: \`${jobName}\``,
    "",
    "A single red run is not filed — this one repeated, so it is a condition rather than a transient.",
    "",
    "```",
    excerpt,
    "```",
  ];
  if (supersedes !== null) {
    lines.push(
      "",
      `This failure was filed before as #${supersedes} and closed. It has returned, so the earlier fix did not hold.`,
    );
  }
  lines.push("", buildFailureMarker(opts.signature));
  return {
    title: `CI: ${workflowName} failing on the default branch (${jobName})`,
    body: lines.join("\n"),
  };
}

export function buildCloseComment(greenRun: CiRun): string {
  return [
    `Closing: \`${greenRun.name}\` is green again on the default branch.`,
    "",
    `Cleared by [${greenRun.html_url}](${greenRun.html_url}) (\`${greenRun.head_sha.slice(0, 8)}\`).`,
    "",
    "If it fails again a fresh issue is filed, linking this one.",
  ].join("\n");
}
