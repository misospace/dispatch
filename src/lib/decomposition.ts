/**
 * Shared decomposition helpers for the hosted groomer (dispatch#1066).
 *
 * When a GroomingPlan requires decomposition, the applier creates one bounded
 * child issue per ChildBrief. These helpers are the contract both the
 * operator route and the groomer build on: a stable child identity (so child
 * creation is idempotent across retries), the child issue body, and the
 * parent's decomposition-state persistence with its audit entry.
 */

import { createHash } from "crypto";
import type { ChildBrief } from "./groomer/plan";
import { neutralizeMentions } from "./groomer/sanitize";

/** Label that marks an issue as an audit/umbrella parent. */
export const UMBRELLA_LABEL = "umbrella";

/** Labels a created child issue carries; it is not worker-ready until groomed. */
export const CHILD_ISSUE_LABELS: readonly string[] = ["status/backlog"];

/**
 * The brief in canonical hashing form: exactly the ten ChildBrief fields in
 * interface order, strings trimmed, nulls and missing list items kept as
 * null/empty. Missing optional fields therefore hash identically to explicit
 * nulls/empty arrays, so a child stored before the brief was widened keeps
 * its identity (dispatch#1066).
 */
function canonicalChildBrief(brief: ChildBrief): Record<string, unknown> {
  // A field stored before the brief was widened is `undefined`, not null;
  // both canonicalize to null so old briefs keep their identity.
  const text = (value: string | null | undefined): string | null =>
    value === null || value === undefined ? null : String(value).trim();
  const list = (value: readonly string[] | null | undefined): string[] => (value ?? []).map((item) => String(item).trim());
  return {
    title: String(brief.title).trim(),
    problem: String(brief.problem).trim(),
    designDecision: text(brief.designDecision),
    verifiedCurrentBehavior: text(brief.verifiedCurrentBehavior),
    relevantPaths: list(brief.relevantPaths),
    inScope: list(brief.inScope),
    outOfScope: list(brief.outOfScope),
    dependencies: list(brief.dependencies),
    acceptanceCriteria: list(brief.acceptanceCriteria),
    tests: list(brief.tests),
  };
}

/**
 * Stable identity for a child: sha256 over the normalized parent
 * (repo lowercased/trimmed + issue number) and the canonical child brief.
 * The GroomingChildClaim row is keyed by it, which is what makes child
 * creation idempotent.
 */
export function childBriefKey(repoFullName: string, parentIssueNumber: number, brief: ChildBrief): string {
  const payload = {
    v: 1,
    repo: repoFullName.trim().toLowerCase(),
    parent: parentIssueNumber,
    brief: canonicalChildBrief(brief),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Machine-readable marker that identifies a groomer-created child issue. */
export function childBodyMarker(childKey: string): string {
  return `<!-- dispatch-groomer:child=${childKey} -->`;
}

export interface ChildIssueTarget {
  repoFullName: string;
  number: number;
  url: string;
}

/**
 * Deterministic Markdown body for a groomer-created child issue: the child
 * marker first, then the bounded brief, then a footer that tells the next
 * groomer this child is not yet worker-ready. Same input, byte-identical
 * output. Model text never carries live @-mentions, so the result runs
 * through neutralizeMentions.
 */
export function renderChildIssueBody(input: {
  brief: ChildBrief;
  parent: ChildIssueTarget;
  decompositionReason: string | null;
  childKey: string;
}): string {
  const { brief, parent, decompositionReason, childKey } = input;
  const lines: string[] = [childBodyMarker(childKey), "", `Parent: ${parent.url}`];

  const section = (heading: string, bodyLines: string[]): void => {
    if (bodyLines.length === 0) return;
    lines.push("", `## ${heading}`, ...bodyLines);
  };
  const bullets = (items: readonly string[]): string[] => items.map((item) => `- ${item}`);

  section("Problem", [brief.problem]);
  section("Verified current behavior", brief.verifiedCurrentBehavior === null ? [] : [brief.verifiedCurrentBehavior]);
  section("Current relevant code paths", bullets(brief.relevantPaths));
  section("Settled design decision", brief.designDecision === null ? [] : [brief.designDecision]);
  section("In scope", bullets(brief.inScope));
  section("Out of scope", bullets(brief.outOfScope));
  section("Dependencies", bullets(brief.dependencies));
  section("Acceptance criteria", brief.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`));
  section("Tests", bullets(brief.tests));

  const footer: string[] = ["", "---", `Created by the Dispatch hosted groomer when it decomposed ${parent.url}.`];
  if (decompositionReason !== null) footer.push(`Decomposition reason: ${decompositionReason}`);
  footer.push(
    "This child starts as `status/backlog`: it needs its own evidence-backed grooming pass before it is worker-ready. Do not implement it directly from this brief.",
  );
  lines.push(...footer);

  // Trim trailing whitespace (per line and at the end) so the body is
  // canonical regardless of how the brief strings were produced.
  const rendered = lines.join("\n").replace(/[ \t]+$/gm, "").trim();
  return neutralizeMentions(rendered);
}

/**
 * The slice of the Prisma client the shared decomposition persistence needs;
 * the real client satisfies it structurally.
 */
export interface DecompositionStateClient {
  issue: { update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown> };
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

/**
 * Persist a parent's decomposition state and record the audit entry
 * (dispatch#1066). Shared by the operator decompose route and the hosted
 * groomer so decomposition persistence and audit stay in one place.
 */
export async function setDecompositionState(
  client: DecompositionStateClient,
  input: {
    issue: { id: string; labels: readonly string[] };
    repoFullName: string;
    issueNumber: number;
    actor: string;
    decomposed: boolean;
    note: string | null;
    followUpUrls: string[];
  },
): Promise<void> {
  const { issue, repoFullName, issueNumber, actor, decomposed, note, followUpUrls } = input;

  await client.issue.update({
    where: { id: issue.id },
    data: {
      decomposed,
      decomposedAt: decomposed ? new Date() : null,
      decomposedBy: decomposed ? actor : null,
      decomposedNote: note ?? null,
      followUpUrls,
    },
  });

  await client.auditLog.create({
    data: {
      actor,
      action: decomposed ? "issue_decomposed" : "issue_reactivated",
      repoFullName,
      issueNumber,
      issueId: issue.id,
      beforeLabels: [...issue.labels],
      afterLabels: [...issue.labels],
      success: true,
      notes: decomposed
        ? `Issue marked as decomposed. Note: ${note ?? "none"}. Follow-up URLs: ${followUpUrls.join(", ")}`
        : "Issue reactivated (decomposed set to false)",
    },
  });
}
