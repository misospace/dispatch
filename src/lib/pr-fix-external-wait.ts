/**
 * Structured external-wait contract (#1250).
 *
 * A `WAITING_EXTERNAL` item must name a concrete, independently verifiable
 * dependency — kind, authoritative ref, observed unsatisfied evidence, a
 * recovery trigger with defined semantics, and a recheck deadline (`retryAt`,
 * already a column). "We have not pushed a patch" is not an external
 * dependency: a new wait mark or worker report without a valid contract
 * fails closed to a generation-pinned PARKED/`invalid_wait` disposition
 * with an audited reason, never a six-hour fake wait.
 *
 * This module owns two things:
 *  1. Bounded schema validation (`parseExternalWaitInput`) — every
 *     WAITING_EXTERNAL writer validates through it (markPrFixItem, the
 *     worker tasks/report path, the operator mark route). Reference syntax
 *     is validated per dependency kind, and the declared recovery trigger
 *     must be one of the predicates the evaluator actually implements for
 *     that kind — arbitrary free-text predicates the evaluator would
 *     silently ignore are rejected at admission.
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

/**
 * Recovery predicates with defined evaluator semantics (#1250). Each kind is
 * only valid for the dependency kinds listed in TRIGGER_KIND_DEPENDENCIES;
 * the evaluator implements exactly these — nothing else is admitted.
 * `cooldown_recheck` declares no live predicate: recovery happens when the
 * bounded recheck deadline (`retryAt`) elapses and the queue reissues the
 * item for a worker to re-verify. `service_ready` is the external_service
 * predicate, which has no generic verifier and always evaluates unknown.
 */
export const EXTERNAL_WAIT_TRIGGERS = ["merged", "closed", "check_success", "cooldown_recheck", "service_ready"] as const;
export type ExternalWaitTriggerKind = (typeof EXTERNAL_WAIT_TRIGGERS)[number];

const TRIGGER_KIND_DEPENDENCIES: Record<ExternalWaitTriggerKind, readonly ExternalWaitKind[]> = {
  merged: ["upstream_pr"],
  closed: ["upstream_issue"],
  check_success: ["ci_check"],
  cooldown_recheck: EXTERNAL_WAIT_KINDS,
  service_ready: ["external_service"],
};

/** Bounded, typed external-wait contract persisted on PrFixQueueItem.externalWait. */
export interface ExternalWaitContract {
  kind: ExternalWaitKind;
  /** Authoritative identity, e.g. "org/repo#123" or "check:build@<head>". */
  ref: string;
  /** What was observed that shows the dependency is not satisfied. */
  evidence: string;
  /** Recovery predicate: { kind, note? }. The kind must be a defined evaluator predicate for this dependency kind. */
  trigger: { kind: ExternalWaitTriggerKind; note?: string };
}

export type ExternalWaitEvaluation = "satisfied" | "unsatisfied" | "unknown";

export type ParsedExternalWait =
  | { ok: true; wait: ExternalWaitContract }
  | { ok: false; reason: string };

const MAX_REF_LENGTH = 200;
const MAX_EVIDENCE_LENGTH = 500;
const MAX_TRIGGER_NOTE_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const name = match[1].trim();
  const head = match[2].trim();
  if (!name || !head) return null;
  return { name, head };
}

/** Per-kind authoritative reference syntax; null when the kind needs no forge-checkable shape. */
function validateRefForKind(kind: ExternalWaitKind, ref: string): string | null {
  if (kind === "upstream_pr" || kind === "upstream_issue") {
    return parseForgeRef(ref) ? null : "externalWait.ref must be an authoritative forge identity of the form \"org/repo#123\"";
  }
  if (kind === "ci_check") {
    return parseCheckRef(ref) ? null : "externalWait.ref must be of the form \"check:<name>@<head-sha>\"";
  }
  // external_service has no authoritative forge syntax; the ref is an
  // opaque service identifier. Evaluation always stays unknown (held).
  return null;
}

/**
 * Validate a caller-supplied external-wait payload against the bounded
 * schema. Unknown keys are ignored; every required field must be present,
 * well-formed for its dependency kind, and within its cap. There is no
 * coercive default: a missing or malformed field — including a recovery
 * trigger whose kind has no defined evaluator semantics for the declared
 * dependency — is a validation failure (fail-closed), not a silently
 * unstructured or unverifiable wait.
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
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return { ok: false, reason: `externalWait.${field} must be a non-empty string` };
    }
    if (value.length > max) {
      return { ok: false, reason: `externalWait.${field} exceeds ${max} characters` };
    }
  }
  if (!isRecord(trigger)) {
    return { ok: false, reason: "externalWait.trigger must be an object with a defined recovery predicate kind" };
  }
  const triggerKind = trigger.kind;
  if (typeof triggerKind !== "string" || !EXTERNAL_WAIT_TRIGGERS.includes(triggerKind as ExternalWaitTriggerKind)) {
    return { ok: false, reason: `externalWait.trigger.kind must be one of ${EXTERNAL_WAIT_TRIGGERS.join(", ")}` };
  }
  const allowedKinds = TRIGGER_KIND_DEPENDENCIES[triggerKind as ExternalWaitTriggerKind];
  if (!allowedKinds.includes(kind as ExternalWaitKind)) {
    return { ok: false, reason: `externalWait.trigger.kind "${triggerKind}" is not a defined recovery predicate for dependency kind "${kind}"` };
  }
  const note = trigger.note;
  if (note !== undefined && (typeof note !== "string" || note.length > MAX_TRIGGER_NOTE_LENGTH)) {
    return { ok: false, reason: `externalWait.trigger.note must be a string of at most ${MAX_TRIGGER_NOTE_LENGTH} characters` };
  }
  const refError = validateRefForKind(kind as ExternalWaitKind, ref as string);
  if (refError) return { ok: false, reason: refError };
  return {
    ok: true,
    wait: {
      kind: kind as ExternalWaitKind,
      ref: (ref as string).trim(),
      evidence: (evidence as string).trim(),
      trigger: {
        kind: triggerKind as ExternalWaitTriggerKind,
        ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}),
      },
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

const CHECK_FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

/**
 * Read-only trigger evaluation: does the recorded dependency now satisfy its
 * declared recovery predicate? Never mutates state. The evaluator implements
 * exactly the predicate kinds admitted by `parseExternalWaitInput`; any fetch
 * failure, malformed ref, in-flight check, or inherently unverifiable
 * dependency (`external_service`, `cooldown_recheck`) evaluates to "unknown"
 * — held, never silently ready.
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
    if (wait.trigger.kind === "cooldown_recheck" || wait.trigger.kind === "service_ready") {
      // No live predicate: recovery is the bounded recheck at `retryAt` (the
      // queue reissues the item) or an operator/service probe. Held, by contract.
      return "unknown";
    }
    if (wait.kind === "upstream_pr" && wait.trigger.kind === "merged") {
      const target = parseForgeRef(wait.ref);
      if (!target) return "unknown";
      const state = await fetchPr(target.repoFullName, target.number);
      if (!state || !state.state) return "unknown";
      if (state.state === "merged" || (state.state === "closed" && !!state.mergedAt)) return "satisfied";
      return "unsatisfied";
    }
    if (wait.kind === "upstream_issue" && wait.trigger.kind === "closed") {
      const target = parseForgeRef(wait.ref);
      if (!target) return "unknown";
      const issue = await fetchIssueState(target.repoFullName, target.number);
      if (!issue || !issue.state) return "unknown";
      return issue.state === "closed" ? "satisfied" : "unsatisfied";
    }
    if (wait.kind === "ci_check" && wait.trigger.kind === "check_success") {
      const target = parseCheckRef(wait.ref);
      if (!target) return "unknown";
      // The head in a ci_check ref is a commit SHA resolved against the
      // waiting item's own repo (caller supplies it as ownerRepo).
      if (!ownerRepo || !ownerRepo.includes("/")) return "unknown";
      const conclusion = await fetchCheck(ownerRepo, target.head, target.name);
      if (!conclusion) return "unknown";
      const normalized = conclusion.toLowerCase();
      if (normalized === "success") return "satisfied";
      if (CHECK_FAILURE_CONCLUSIONS.has(normalized)) return "unsatisfied";
      return "unknown"; // in-flight or unrecognized conclusion: held
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
