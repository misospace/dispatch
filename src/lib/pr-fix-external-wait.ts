/**
 * Structured external-wait contract (#1250).
 *
 * A `WAITING_EXTERNAL` item must name a concrete, independently verifiable
 * dependency — kind, authoritative ref, observed unsatisfied evidence, a
 * recovery trigger, and a recheck deadline (`retryAt`, already a column).
 * "We have not pushed a patch" is not an external dependency: a new wait
 * mark or worker report without a valid contract fails closed to a
 * generation-pinned PARKED/`invalid_wait` disposition with an audited
 * reason, never a six-hour fake wait.
 *
 * This module owns two things:
 *  1. Bounded schema validation (`parseExternalWaitInput`) — every
 *     WAITING_EXTERNAL writer validates through it (markPrFixItem, the
 *     worker tasks/report path, the operator mark route).
 *  2. A READ-ONLY trigger evaluation contract (`evaluateExternalWaitTrigger`)
 *     so a later recovery worker can decide when a dependency resolves.
 *     It never mutates queue state; unverifiable dependencies evaluate to
 *     "unknown" (held), never silently ready.
 */

import { fetchIssue } from "./github-issues";
import { fetchPullRequestState } from "./github-prs";
import { GITHUB_API, getHeadersAsync, fetchWithRetry } from "./github-auth";

export const EXTERNAL_WAIT_KINDS = ["upstream_pr", "upstream_issue", "ci_check", "external_service"] as const;
export type ExternalWaitKind = (typeof EXTERNAL_WAIT_KINDS)[number];

/** Bounded, typed external-wait contract persisted on PrFixQueueItem.externalWait. */
export interface ExternalWaitContract {
  kind: ExternalWaitKind;
  /** Authoritative identity, e.g. "org/repo#123" or "check:build@<head>". */
  ref: string;
  /** What was observed that shows the dependency is not satisfied. */
  evidence: string;
  /** Recovery predicate, e.g. "upstream PR merged" or "check build succeeds on head <h>". */
  trigger: string;
}

export type ExternalWaitEvaluation = "satisfied" | "unsatisfied" | "unknown";

export type ParsedExternalWait =
  | { ok: true; wait: ExternalWaitContract }
  | { ok: false; reason: string };

const MAX_REF_LENGTH = 200;
const MAX_EVIDENCE_LENGTH = 500;
const MAX_TRIGGER_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a caller-supplied external-wait payload against the bounded
 * schema. Unknown keys are ignored; every required field must be present,
 * a string, non-empty after trimming, and within its cap. There is no
 * coercive default: a missing or malformed field is a validation failure
 * (fail-closed), not a silently unstructured wait.
 */
export function parseExternalWaitInput(raw: unknown): ParsedExternalWait {
  if (!isRecord(raw)) return { ok: false, reason: "externalWait must be an object" };
  const kind = raw.kind;
  const ref = raw.ref;
  const evidence = raw.evidence;
  const trigger = raw.trigger;
  if (typeof kind !== "string" || !EXTERNAL_WAIT_KINDS.includes(kind as ExternalWaitKind)) {
    return { ok: false, reason: `externalWait.kind must be one of ${EXTERNAL_WAIT_KINDS.join(", ")}` };
  }
  for (const [field, value, max] of [
    ["ref", ref, MAX_REF_LENGTH],
    ["evidence", evidence, MAX_EVIDENCE_LENGTH],
    ["trigger", trigger, MAX_TRIGGER_LENGTH],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return { ok: false, reason: `externalWait.${field} must be a non-empty string` };
    }
    if (value.length > max) {
      return { ok: false, reason: `externalWait.${field} exceeds ${max} characters` };
    }
  }
  return {
    ok: true,
    wait: {
      kind: kind as ExternalWaitKind,
      ref: (ref as string).trim(),
      evidence: (evidence as string).trim(),
      trigger: (trigger as string).trim(),
    },
  };
}

/** Parse a stored externalWait JSON column value; null when absent or malformed (legacy wait). */
export function parseStoredExternalWait(raw: unknown): ExternalWaitContract | null {
  const parsed = parseExternalWaitInput(raw);
  return parsed.ok ? parsed.wait : null;
}

export interface ExternalWaitFetchDeps {
  fetchPullRequestState?: (repoFullName: string, prNumber: number) => Promise<{ state: string | null; mergedAt: string | null }>;
  fetchIssueState?: (repoFullName: string, issueNumber: number) => Promise<{ state: string | null } | null>;
  fetchCheckRunConclusion?: (repoFullName: string, ref: string, checkName: string) => Promise<string | null>;
}
async function defaultFetchIssueState(repoFullName: string, issueNumber: number): Promise<{ state: string | null } | null> {
  try {
    const issue = await fetchIssue(repoFullName, issueNumber);
    return { state: (issue as { state?: string }).state ?? null };
  } catch {
    return null;
  }
}

async function defaultFetchCheckRunConclusion(repoFullName: string, ref: string, checkName: string): Promise<string | null> {
  try {
    const response = await fetchWithRetry(
      `${GITHUB_API}/repos/${repoFullName}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
      { headers: await getHeadersAsync() },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { check_runs?: Array<{ name?: string; conclusion?: string | null }> };
    const run = (data.check_runs ?? []).find((candidate) => candidate.name === checkName);
    return run?.conclusion ?? null;
  } catch {
    return null;
  }
}

/** Split "org/repo#123" into [org/repo, 123]; null when not that shape. */
export function parseForgeRef(ref: string): { repoFullName: string; number: number } | null {
  const match = /^(.+)#(\d+)$/.exec(ref.trim());
  if (!match) return null;
  const repoFullName = match[1].trim();
  const number = Number(match[2]);
  if (!repoFullName.includes("/") || !Number.isInteger(number) || number <= 0) return null;
  return { repoFullName, number };
}

/** Split "check:<name>@<head>" into [name, head]; null when not that shape. */
export function parseCheckRef(ref: string): { name: string; head: string } | null {
  const match = /^check:(.+)@(.+)$/.exec(ref.trim());
  if (!match) return null;
  return { name: match[1].trim(), head: match[2].trim() };
}

/**
 * Read-only trigger evaluation: does the recorded dependency now satisfy its
 * recovery trigger? Never mutates state. Any fetch failure, malformed ref,
 * in-flight check, or inherently unverifiable dependency (external_service)
 * evaluates to "unknown" — held, never silently ready.
 */
export async function evaluateExternalWaitTrigger(
  wait: ExternalWaitContract,
  ownerRepo: string | undefined,
  deps: ExternalWaitFetchDeps = {},
): Promise<ExternalWaitEvaluation> {
  const fetchPr = deps.fetchPullRequestState ?? fetchPullRequestState;
  const fetchIssueState = deps.fetchIssueState ?? defaultFetchIssueState;
  const fetchCheck = deps.fetchCheckRunConclusion ?? defaultFetchCheckRunConclusion;
  try {
    if (wait.kind === "upstream_pr") {
      const target = parseForgeRef(wait.ref);
      if (!target) return "unknown";
      const state = await fetchPr(target.repoFullName, target.number);
      if (!state || !state.state) return "unknown";
      if (state.state === "merged" || (state.state === "closed" && !!state.mergedAt)) return "satisfied";
      return "unsatisfied";
    }
    if (wait.kind === "upstream_issue") {
      const target = parseForgeRef(wait.ref);
      if (!target) return "unknown";
      const issue = await fetchIssueState(target.repoFullName, target.number);
      if (!issue || !issue.state) return "unknown";
      return issue.state === "closed" ? "satisfied" : "unsatisfied";
    }
    if (wait.kind === "ci_check") {
      const target = parseCheckRef(wait.ref);
      if (!target) return "unknown";
      // The head in a ci_check ref is a commit SHA resolved against the
      // waiting item's own repo (caller supplies it as ownerRepo).
      const repoFullName = ownerRepo ?? "";
      if (!repoFullName.includes("/")) return "unknown";
      const conclusion = await fetchCheck(repoFullName, target.head, target.name);
      if (!conclusion) return "unknown";
      const normalized = conclusion.toLowerCase();
      if (normalized === "success") return "satisfied";
      if (["failure", "cancelled", "timed_out", "action_required"].includes(normalized)) return "unsatisfied";
      return "unknown"; // in-flight or unrecognized conclusion: held
    }
    // external_service has no generic verifier: an operator or a dedicated
    // service probe decides. Held, by contract.
    return "unknown";
  } catch {
    return "unknown";
  }
}
