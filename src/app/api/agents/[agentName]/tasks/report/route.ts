import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse, getBoundWorkerAgent } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { resolvePrFixFromAgentReport, MAX_EVIDENCE_LENGTH, type ResolvePrFixFromAgentReportResult } from "@/lib/pr-fix-queue";
import { isValidPrFixOutcome, VALID_PR_FIX_OUTCOMES, type PrFixDecisionContext } from "@/types";
import {
  resolveAlreadyDoneFromAgentReport,
  type ReportCloseCriterion,
  type ResolveAlreadyDoneResult,
} from "@/lib/report-close";
import { asRepoFilePath } from "@/lib/groomer/close-grounding";
import { PLAN_LIMITS } from "@/lib/groomer/plan";
import { getLiveIssueLabels } from "@/lib/claim-gate";
import { AGENT_PREFIX, getAgentFromLabels } from "@/types";

const VALID_TASK_TYPES = ["implement", "followup-pr"] as const;
type ValidTaskType = (typeof VALID_TASK_TYPES)[number];

const VALID_OUTCOMES = [
  "pr_opened",
  "pr_updated",
  "issue_updated",
  "issue_closed",
  "blocked",
  "failed",
  "no_changes_needed",
  "already_addressed",
  "already_done",
  "handed-off",
  "waiting-external",
  "capacity-exhausted",
] as const;
type ValidOutcome = (typeof VALID_OUTCOMES)[number];

/** Internal signal for a malformed already_done close proposal; mapped to 400. */
class CloseValidationError extends Error {}

export interface TaskReportBody {
  taskType: ValidTaskType;
  outcome: ValidOutcome;
  repoFullName?: string;
  issueNumber?: number;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  summary?: string;
  error?: string;
  // #1121: evidence string (commit SHAs / paths) carried by an already_addressed report; recorded in settlement history.
  evidence?: string;
  // #1218: for a `blocked` report, the structured reason. `human_decision`
  // marks BLOCKED with the decision payload; anything else (or a bare give-up)
  // marks PARKED. Validated against PrFixOutcome.
  blockReason?: string;
  // #1218: the human-decision payload attached to a `human_decision` block.
  decision?: PrFixDecisionContext;
  // #1143: the already_done close proposal. The worker supplies per-criterion
  // pinned excerpts; Dispatch re-derives the catalog and applies the shared
  // close policy. Not close authorization on its own.
  close?: { criteria: ReportCloseCriterion[] };
  // #1120: worker-reported task start time (ISO 8601). Accepted only when
  // parseable, not in the future, and within 24h of the report; otherwise
  // omitted and the report time is used. It participates in the idempotency
  // payload hash like the other fields.
  startedAt?: string;
  // The (id, generation) attempt token next-task issued on this followup-pr
  // task, echoed back by the worker (#1074). Required for PR-fix queue
  // settlement; part of the report's payload identity (idempotency hash).
  prFixItem?: { id: string; generation: number; handoutToken?: string } | null;
  capacity?: string;
}

function deriveStatus(outcome: ValidOutcome): string {
  if (outcome === "handed-off") return "handed-off";
  if (outcome === "failed") return "failed";
  if (outcome === "blocked") return "blocked";
  if (outcome === "waiting-external") return "waiting-external";
  // #1256: neutral terminal status — the worker's capacity gave the attempt
  // back; nothing succeeded or failed.
  if (outcome === "capacity-exhausted") return "capacity-exhausted";
  return "completed";
}

// #1120: optional worker-reported start time. Accepted only when it is a
// string that parses to a real date, is not in the future, and is no more
// than MAX_STARTED_AT_AGE_MS before the report; anything else silently falls
// back to the report time so a clock-skewed or bogus value can never produce
// a negative or absurd duration.
const MAX_STARTED_AT_AGE_MS = 24 * 60 * 60 * 1000;

// Require an extended ISO 8601 timestamp with timezone (Z or ±HH:MM), e.g.
// 2026-10-03T04:20:58Z or 2026-10-03T04:20:58.123456+00:00 (Python isoformat).
// Date-only, bare-year, and locale-ambiguous strings are malformed → fallback.
const ISO_8601_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function resolveReportedStartedAt(rawStartedAt: unknown, now: Date): string | undefined {
  if (typeof rawStartedAt !== "string") return undefined;
  if (!ISO_8601_TIMESTAMP_PATTERN.test(rawStartedAt)) return undefined;
  const parsed = new Date(rawStartedAt);
  const time = parsed.getTime();
  if (Number.isNaN(time)) return undefined;
  if (time > now.getTime()) return undefined;
  if (now.getTime() - time > MAX_STARTED_AT_AGE_MS) return undefined;
  return parsed.toISOString();
}

async function resolveIssueId(
  repoFullName: string | undefined,
  issueNumber: number | undefined,
): Promise<string | null> {
  if (!repoFullName || issueNumber === undefined) return null;

  const repo = await prisma.repository.findUnique({
    where: { fullName: repoFullName },
    select: { id: true },
  });

  if (!repo) return null;

  const issue = await prisma.issue.findUnique({
    where: { repositoryId_number: { repositoryId: repo.id, number: issueNumber } },
    select: { id: true },
  });

  return issue?.id ?? null;
}

/**
 * Worker-tier scope check for an `already_done` close (dispatch#1143 review of
 * #1219): the close can ONLY target one concrete issue that is both
 *
 *   (a) tracked in Dispatch's cache (so the close's Prisma mirror update is
 *       not a no-op on a ghost issue), AND
 *   (b) live-assigned to the token-derived worker (`agent/<bound name>` is
 *       present in GitHub's live label set for the issue).
 *
 * The check hits GitHub for the live label set — the Prisma cache can lag a
 * claim made directly on GitHub (#1037), so a stale `agent/<bound>` in cache
 * would let a worker close an issue Dispatch thinks is theirs but another
 * agent actually owns on the forge. Maintainer-tier callers (basic / OIDC /
 * maintainer bearer / auth-disabled) bypass the gate; the close proceeds even
 * for an untracked issue. Errors thrown by the live fetch surface as 503 with
 * a fail-closed refusal — the close never lands on an unreadable assignment.
 *
 * Returns a `NextResponse` to return when the gate denies, or `null` when the
 * gate allows.
 */
async function enforceAlreadyDoneWorkerScope(
  auth: Awaited<ReturnType<typeof authorizeRequest>>,
  repoFullName: string,
  issueNumber: number,
): Promise<NextResponse<{ error: string }> | null> {
  // Maintainer / OIDC / basic / auth-disabled callers are unconstrained —
  // the route's agent-name URL gate already passed.
  if (!auth.authorized) return null;
  if (auth.type !== "bearer" || auth.tier !== "worker") return null;

  const bound = getBoundWorkerAgent(auth);
  // An unbound legacy worker token has no agent identity to scope against —
  // it cannot close a tracked issue on someone else's behalf; deny.
  if (!bound) {
    return errorResponse(
      "Worker token is not bound to an agent; an already_done close requires a bound worker credential or a maintainer token",
      403,
    );
  }

  const issueId = await resolveIssueId(repoFullName, issueNumber);
  if (!issueId) {
    return errorResponse(
      `Worker token is bound to agent "${bound}" and may only close issues Dispatch tracks; ${repoFullName}#${issueNumber} is not tracked`,
      403,
    );
  }

  // The labels GitHub currently has are authoritative for the assignment
  // decision (matches the issue-status and claim gates — #1037).
  let liveLabels: string[];
  try {
    liveLabels = await getLiveIssueLabels(repoFullName, issueNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(
      `Could not verify live GitHub labels for ${repoFullName}#${issueNumber}: ${message}`,
      503,
    );
  }

  if (getAgentFromLabels(liveLabels) !== `${AGENT_PREFIX}${bound}`) {
    return errorResponse(
      `Worker token is bound to agent "${bound}" and may only close issues live-assigned to it; ${repoFullName}#${issueNumber} is not assigned to that agent`,
      403,
    );
  }

  return null;
}

function buildTouchedUrls(
  report: TaskReportBody,
): string[] {
  const urls: string[] = [];

  if (report.repoFullName && report.issueNumber !== undefined) {
    urls.push(`https://github.com/${report.repoFullName}/issues/${report.issueNumber}`);
  }

  if (report.pullRequestUrl) {
    urls.push(report.pullRequestUrl);
  } else if (report.repoFullName && report.pullRequestNumber !== undefined) {
    urls.push(`https://github.com/${report.repoFullName}/pull/${report.pullRequestNumber}`);
  }

  return urls;
}

/**
 * Deterministic JSON for report payload comparison: object keys sorted,
 * `undefined` entries omitted. Two reports that differ only in key order or
 * in explicitly-undefined optional fields hash identically.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function reportPayloadHash(
  payload: Omit<TaskReportBody, "startedAt"> & { startedAt?: unknown },
): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentName: string }> },
) {
  const { agentName } = await params;

  // Authenticate
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  // A bound worker credential may only report for its own agent; an unbound
  // legacy worker token is refused on this identity-scoped route (#1129).
  const scopeError = await enforceWorkerAgentScope(auth, agentName);
  if (scopeError) return scopeError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse("Invalid JSON body", 400);
  }

  const raw = body as Record<string, unknown>;

  const taskType = raw.taskType;
  if (typeof taskType !== "string" || !VALID_TASK_TYPES.includes(taskType as ValidTaskType)) {
    return errorResponse(`Invalid taskType. Must be one of: ${VALID_TASK_TYPES.join(", ")}`, 400);
  }

  const outcome = raw.outcome;
  if (typeof outcome !== "string" || !VALID_OUTCOMES.includes(outcome as ValidOutcome)) {
    return errorResponse(`Invalid outcome. Must be one of: ${VALID_OUTCOMES.join(", ")}`, 400);
  }

  if (outcome === "capacity-exhausted") {
    if (typeof raw.capacity !== "string" || raw.capacity.trim().length === 0 || raw.capacity.trim().length > 200) {
      return errorResponse("capacity must be a non-empty recognized capacity identifier of at most 200 characters", 400);
    }
    if (!raw.prFixItem || typeof raw.prFixItem !== "object" || Array.isArray(raw.prFixItem)) {
      return errorResponse("capacity-exhausted requires the issued prFixItem { id, generation } token", 400);
    }
    // #1256 review: the release is fenced to the EXACT issued hand-out, so
    // the per-hand-out receipt token is a hard gate for this outcome (other
    // outcomes never required it and are unchanged).
    const rawCapacityAttempt = raw.prFixItem as { handoutToken?: unknown };
    if (typeof rawCapacityAttempt.handoutToken !== "string" || rawCapacityAttempt.handoutToken.trim().length === 0) {
      return errorResponse("capacity-exhausted requires the issued prFixItem.handoutToken receipt token", 400);
    }
    // The outcome's entire effect is the queue settlement; a report without
    // the PR coordinates would record an AgentRun and silently settle nothing.
    // Claimed-issue exhaustion uses POST /api/issues/capacity-handoff instead.
    if (typeof raw.repoFullName !== "string" || raw.repoFullName.trim() === "" || typeof raw.pullRequestNumber !== "number") {
      return errorResponse("capacity-exhausted requires repoFullName and pullRequestNumber (issue work uses POST /api/issues/capacity-handoff)", 400);
    }
  }

  if (raw.issueNumber !== undefined && (typeof raw.issueNumber !== "number" || !Number.isInteger(raw.issueNumber))) {
    return errorResponse("issueNumber must be an integer", 400);
  }

  if (raw.pullRequestNumber !== undefined && (typeof raw.pullRequestNumber !== "number" || !Number.isInteger(raw.pullRequestNumber))) {
    return errorResponse("pullRequestNumber must be an integer", 400);
  }

  const stringFields: readonly string[] = ["repoFullName", "pullRequestUrl", "summary", "error", "evidence", "capacity"];
  for (const field of stringFields) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") {
      return errorResponse(`${field} must be a string`, 400);
    }
  }

  // #1218: a `blocked` report may carry a structured reason and a
  // human-decision payload. Validate both here so a malformed value is a 400
  // rather than a silently-ignored field. They are only meaningful for a
  // `blocked` outcome; the resolver ignores them otherwise.
  let blockReason: string | undefined;
  if (raw.blockReason !== undefined) {
    if (typeof raw.blockReason !== "string" || !isValidPrFixOutcome(raw.blockReason.trim())) {
      return errorResponse(
        `blockReason must be one of: ${VALID_PR_FIX_OUTCOMES.join(", ")}`,
        400,
      );
    }
    blockReason = raw.blockReason.trim();
  }

  let decision: PrFixDecisionContext | undefined;
  if (raw.decision !== undefined && raw.decision !== null) {
    if (typeof raw.decision !== "object" || Array.isArray(raw.decision)) {
      return errorResponse("decision must be an object", 400);
    }
    const rawDecision = raw.decision as Record<string, unknown>;
    const parsedDecision: PrFixDecisionContext = {};
    if (rawDecision.question !== undefined && rawDecision.question !== null) {
      if (typeof rawDecision.question !== "string") {
        return errorResponse("decision.question must be a string", 400);
      }
      if (rawDecision.question.trim()) parsedDecision.question = rawDecision.question.trim();
    }
    if (rawDecision.options !== undefined && rawDecision.options !== null) {
      if (!Array.isArray(rawDecision.options) || rawDecision.options.some((o) => typeof o !== "string")) {
        return errorResponse("decision.options must be an array of strings", 400);
      }
      const options = (rawDecision.options as string[]).map((o) => o.trim()).filter(Boolean);
      if (options.length > 0) parsedDecision.options = options;
    }
    if (rawDecision.evidence !== undefined && rawDecision.evidence !== null) {
      if (typeof rawDecision.evidence !== "string") {
        return errorResponse("decision.evidence must be a string", 400);
      }
      if (rawDecision.evidence.trim()) parsedDecision.evidence = rawDecision.evidence.trim();
    }
    decision = parsedDecision;
  }

  // #1121/#1143: evidence is meaningful for an already_addressed settlement and
  // for an already_done close — it is trimmed, bounded, and recorded in the
  // settlement/close history. On any other outcome it is ignored (never hashed,
  // never persisted). A non-string evidence is rejected above by the
  // stringFields validation.
  const isAlreadyAddressed = (outcome as ValidOutcome) === "already_addressed";
  const isAlreadyDone = (outcome as ValidOutcome) === "already_done";
  if (isAlreadyDone && (taskType !== "implement" || (raw.prFixItem !== undefined && raw.prFixItem !== null))) {
    return errorResponse("already_done is only valid for implement reports without prFixItem", 400);
  }
  const evidence =
    (isAlreadyAddressed || isAlreadyDone) && typeof raw.evidence === "string"
      ? raw.evidence.trim()
      : undefined;
  if (evidence && evidence.length > MAX_EVIDENCE_LENGTH) {
    return errorResponse(`evidence must be at most ${MAX_EVIDENCE_LENGTH} characters`, 400);
  }

  // #1143: the already_done close proposal. The worker supplies per-criterion
  // pinned excerpts; the server re-derives the catalog and applies the shared
  // close policy. Only parsed for already_done; ignored otherwise (like
  // evidence). Paths are normalized through the same conservative
  // `asRepoFilePath` the groomer uses.
  let closeCriteria: ReportCloseCriterion[] | undefined;
  if (isAlreadyDone) {
    if (raw.close === undefined || raw.close === null || typeof raw.close !== "object" || Array.isArray(raw.close)) {
      return errorResponse("close must be an object for an already_done report", 400);
    }
    const rawClose = raw.close as Record<string, unknown>;
    const rawCriteria = rawClose.criteria;
    if (!Array.isArray(rawCriteria)) {
      return errorResponse("close.criteria must be an array", 400);
    }
    if (rawCriteria.length === 0 || rawCriteria.length > PLAN_LIMITS.closeCriteria) {
      return errorResponse(
        `close.criteria must have between 1 and ${PLAN_LIMITS.closeCriteria} items`,
        400,
      );
    }
    try {
      closeCriteria = rawCriteria.map((item, i) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          throw new CloseValidationError(`close.criteria[${i}] must be an object`);
        }
        const entry = item as Record<string, unknown>;
        if (
          typeof entry.criterion !== "string" ||
          entry.criterion.trim().length === 0 ||
          entry.criterion.trim().length > PLAN_LIMITS.shortText
        ) {
          throw new CloseValidationError(
            `close.criteria[${i}].criterion must be a non-empty string of at most ${PLAN_LIMITS.shortText} characters`,
          );
        }
        const path = typeof entry.path === "string" ? asRepoFilePath(entry.path) : null;
        if (!path) {
          throw new CloseValidationError(`close.criteria[${i}].path must be a repository file path`);
        }
        if (
          typeof entry.excerpt !== "string" ||
          entry.excerpt.trim().length === 0 ||
          entry.excerpt.length > PLAN_LIMITS.excerpt
        ) {
          throw new CloseValidationError(
            `close.criteria[${i}].excerpt must be a non-empty string of at most ${PLAN_LIMITS.excerpt} characters`,
          );
        }
        return { criterion: entry.criterion.trim(), path, excerpt: entry.excerpt };
      });
    } catch (err) {
      if (err instanceof CloseValidationError) return errorResponse(err.message, 400);
      throw err;
    }
  }

  // Optional attempt token for PR-fix queue settlement (#1074). The worker
  // echoes the prFixItem { id, generation } that next-task issued.
  if (raw.prFixItem !== undefined && raw.prFixItem !== null) {
    if (typeof raw.prFixItem !== "object" || Array.isArray(raw.prFixItem)) {
      return errorResponse("prFixItem must be an object", 400);
    }
    const prFixItem = raw.prFixItem as Record<string, unknown>;
    if (typeof prFixItem.id !== "string" || prFixItem.id.trim().length === 0) {
      return errorResponse("prFixItem.id must be a non-empty string", 400);
    }
    if (typeof prFixItem.generation !== "number" || !Number.isInteger(prFixItem.generation) || prFixItem.generation < 1) {
      return errorResponse("prFixItem.generation must be an integer >= 1", 400);
    }
    // #1256: optional per-hand-out receipt token. Optional here so legacy
    // (pre-receipt) reports keep settling every other outcome; the resolver
    // enforces its presence for `capacity-exhausted`.
    if (prFixItem.handoutToken !== undefined && prFixItem.handoutToken !== null) {
      if (typeof prFixItem.handoutToken !== "string" || prFixItem.handoutToken.trim().length === 0 || prFixItem.handoutToken.trim().length > 100) {
        return errorResponse("prFixItem.handoutToken must be a non-empty string of at most 100 characters", 400);
      }
    }
  }

  // Optional worker-chosen opaque key. Present → the report becomes
  // idempotently retryable; absent → current at-least-once behavior (#1044).
  // Trimmed and capped so the unique index cannot be abused with unbounded
  // key material; otherwise fully opaque to Dispatch.
  const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
  const rawIdempotencyKey = raw.idempotencyKey;
  if (rawIdempotencyKey !== undefined && typeof rawIdempotencyKey !== "string") {
    return errorResponse("idempotencyKey must be a non-empty string", 400);
  }
  const idempotencyKey =
    typeof rawIdempotencyKey === "string" ? rawIdempotencyKey.trim() : undefined;
  if (idempotencyKey !== undefined && idempotencyKey.length === 0) {
    return errorResponse("idempotencyKey must be a non-empty string", 400);
  }
  if (idempotencyKey !== undefined && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return errorResponse(`idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`, 400);
  }

  // #1143: an already_done close targets one concrete issue and must carry a
  // report-scoped idempotency key (the compare-and-swap token that keeps a
  // retried report from executing the close twice).
  if (isAlreadyDone) {
    const reportRepo = raw.repoFullName;
    const reportIssue = raw.issueNumber;
    if (typeof reportRepo !== "string" || reportRepo.trim().length === 0 || reportIssue === undefined) {
      return errorResponse("repoFullName and issueNumber are required for an already_done report", 400);
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(reportRepo.trim())) {
      return errorResponse("repoFullName must be an owner/repo slug for an already_done report", 400);
    }
    if (typeof idempotencyKey !== "string") {
      return errorResponse(
        "an already_done report requires an idempotencyKey so the close is not applied twice",
        400,
      );
    }
  }

  const prFixItem =
    raw.prFixItem && typeof raw.prFixItem === "object" && !Array.isArray(raw.prFixItem)
      ? {
          id: (raw.prFixItem as { id: string }).id.trim(),
          generation: (raw.prFixItem as { generation: number }).generation,
          handoutToken:
            typeof (raw.prFixItem as { handoutToken?: unknown }).handoutToken === "string"
              ? (raw.prFixItem as { handoutToken: string }).handoutToken.trim()
              : undefined,
        }
      : undefined;

  // #1120: computed once before the report so the same instant is used for
  // startedAt validation and finishedAt.
  const now = new Date();

  const report: TaskReportBody = {
    taskType: taskType as ValidTaskType,
    outcome: outcome as ValidOutcome,
    repoFullName: typeof raw.repoFullName === "string" ? raw.repoFullName.trim() : undefined,
    issueNumber: raw.issueNumber as number | undefined,
    pullRequestNumber: raw.pullRequestNumber as number | undefined,
    pullRequestUrl: raw.pullRequestUrl as string | undefined,
    summary: raw.summary as string | undefined,
    error: raw.error as string | undefined,
    evidence,
    // #1218: structured block classification; participates in the idempotency
    // payload hash like the other report fields.
    blockReason,
    decision,
    close: closeCriteria ? { criteria: closeCriteria } : undefined,
    // #1120: normalized worker start time; undefined → report time (now).
    startedAt: resolveReportedStartedAt(raw.startedAt, now),
    prFixItem,
    capacity: typeof raw.capacity === "string" ? raw.capacity.trim() : undefined,
  };

  try {
    // Resolve issueId from repoFullName + issueNumber
    const issueId = await resolveIssueId(report.repoFullName, report.issueNumber);

    // Build touched URLs
    const touchedIssueUrls = buildTouchedUrls(report);

    // Persist AgentRun
    const runData = {
      agentName,
      runType: report.taskType,
      status: deriveStatus(report.outcome),
      // #1120: worker-reported start time when valid, else the report time.
      startedAt: report.startedAt ? new Date(report.startedAt) : now,
      finishedAt: now,
      summary: report.summary,
      errorMessage: report.error,
      touchedIssueUrls,
      issueId,
    };

    let run: { id: string };
    let duplicate = false;
    let storedResolution: ResolvePrFixFromAgentReportResult | undefined;
    let storedCloseResolution: ResolveAlreadyDoneResult | undefined;

    if (typeof idempotencyKey === "string") {
      // Idempotent reporting (#1044): claim the key and create the AgentRun in
      // ONE transaction, so a committed claim always carries its result. A
      // concurrent or retried report with the same (agentName, idempotencyKey)
      // loses the unique-index race (P2002) and replays the stored result
      // instead of re-running the report or its side effects.
      // #1120/#1044: hash the RAW body value, not the time-validated one, so an
      // identical-body retry keeps the same payload identity even when
      // startedAt's acceptance flips across the 24h boundary between attempts.
      const payloadHash = reportPayloadHash({ ...report, startedAt: raw.startedAt });
      try {
        run = await prisma.$transaction(async (tx) => {
          const claim = await tx.agentReportDedupe.create({
            data: { agentName, idempotencyKey, payloadHash },
          });
          const created = await tx.agentRun.create({ data: runData });
          await tx.agentReportDedupe.update({
            where: { id: claim.id },
            data: { agentRunId: created.id },
          });
          return created;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = await prisma.agentReportDedupe.findUnique({
          where: { agentName_idempotencyKey: { agentName, idempotencyKey } },
        });
        if (!existing) throw error;
        if (existing.payloadHash !== payloadHash) {
          return errorResponse(
            `idempotencyKey was already used with a different report payload for agent ${agentName}`,
            409,
          );
        }
        if (!existing.agentRunId) {
          // Unreachable while the claim and the AgentRun commit together; guard
          // against a half-written claim from any future refactor.
          return errorResponse("idempotencyKey is claimed but has no recorded result", 409);
        }
        duplicate = true;
        run = { id: existing.agentRunId };
        storedResolution =
          (existing.prFixResolution as ResolvePrFixFromAgentReportResult | null) ?? undefined;
        storedCloseResolution =
          (existing.closeResolution as ResolveAlreadyDoneResult | null) ?? undefined;
      }
    } else {
      run = await prisma.agentRun.create({ data: runData });
    }

    let prFixResolution: ResolvePrFixFromAgentReportResult;
    if (duplicate) {
      // Never re-run side effects for an already-processed key. Replay the
      // stored resolution when available; otherwise report an explicit skip.
      prFixResolution = storedResolution ?? {
        matched: true,
        action: "skipped",
        itemId: null,
        reason: "duplicate report (idempotency key already processed); PR-fix resolution not re-run",
      };
    } else {
      // If the report corresponds to a queued pr-fix item, resolve it. Without
      // this, non-bridge agents (anything driven through MCP tools or the generic
      // harness loop) leave the item QUEUED and it is re-served ahead of issue
      // work on every poll. See issue #868.
      prFixResolution = await resolvePrFixFromAgentReport({
        repoFullName: report.repoFullName,
        pullRequestNumber: report.pullRequestNumber,
        pullRequestUrl: report.pullRequestUrl,
        outcome: report.outcome,
        summary: report.summary,
        error: report.error,
        evidence: report.evidence,
        // #1218: a `blocked` report's structured reason / decision payload;
        // the resolver ignores both for any other outcome.
        blockReason: report.blockReason,
        decision: report.decision,
        capacity: report.capacity,
        agentName,
        // #1074: settlement is authorized by the attempt token the worker was
        // issued; a report without one never mutates the queue.
        attempt: prFixItem
          ? { itemId: prFixItem.id, generation: prFixItem.generation, handoutToken: prFixItem.handoutToken }
          : null,
      });
      if (typeof idempotencyKey === "string") {
        // Persist the resolution before responding so a retry replays the real
        // result rather than the skip marker. This runs after the claim/run
        // transaction and is awaited: a failure surfaces as a 5xx on THIS
        // response, and the worker's retry then takes the duplicate branch
        // (same agentRunId, skip marker) — side effects are never re-run either
        // way. It cannot move inside the claim transaction because the
        // resolver makes GitHub round-trips and itself opens transactions.
        await prisma.agentReportDedupe.update({
          where: { agentName_idempotencyKey: { agentName, idempotencyKey } },
          data: { prFixResolution: prFixResolution as unknown as Prisma.InputJsonValue },
        });
      }
    }

    // #1143: an already_done report closes the issue through the shared close
    // policy, evaluated against a server-built, revision-pinned catalog. The
    // resolution is persisted like the PR-fix one, so a retried report with the
    // same idempotency key replays the close outcome instead of re-executing it.
    let closeResolution: ResolveAlreadyDoneResult | undefined;
    if (isAlreadyDone) {
      if (duplicate) {
        // Idempotent replay: the original attempt already passed the
        // worker-tier scope gate, the close policy, and the freshness re-check
        // (or recorded a refusal). A retry re-runs none of those, and the
        // stored resolution carries the audit-worthy outcome.
        closeResolution = storedCloseResolution ?? {
          matched: true,
          action: "skipped",
          reason:
            "duplicate report (idempotency key already processed); the already_done close was not re-run — the outcome was not recorded, so verify the issue state and audit log before retrying",
          reasons: [],
          repoFullName: report.repoFullName!,
          issueNumber: report.issueNumber!,
          headSha: null,
          evidenceDigest: null,
          criteria: [],
        };
      } else {
        // #1143 review (Blocker 1): a bound worker may only close issues that
        // are tracked AND live-assigned to the token-derived agent. Enforce
        // before any GitHub close or status-label write so an unauthorized
        // close cannot reach the apply path. Maintainer / OIDC / basic /
        // auth-disabled callers are unconstrained — the gate is a no-op for
        // them.
        const scopeDenial = await enforceAlreadyDoneWorkerScope(
          auth,
          report.repoFullName!,
          report.issueNumber!,
        );
        if (scopeDenial) return scopeDenial;

        closeResolution = await resolveAlreadyDoneFromAgentReport({
          repoFullName: report.repoFullName!,
          issueNumber: report.issueNumber!,
          criteria: report.close!.criteria,
          evidence: report.evidence,
          actor: agentName,
          issueId,
          client: prisma,
          // #1143 review of #1219 P1: the bound agent closes the snapshot-vs-
          // final-read window — the apply-time freshness re-check also requires
          // the FINAL live issue labels to still assign the issue to
          // `agent/<boundAgent>`. Maintainer / OIDC / basic / auth-disabled
          // callers leave this undefined so no extra constraint applies.
          boundAgent: getBoundWorkerAgent(auth),
        });
        if (typeof idempotencyKey === "string") {
          await prisma.agentReportDedupe.update({
            where: { agentName_idempotencyKey: { agentName, idempotencyKey } },
            data: { closeResolution: closeResolution as unknown as Prisma.InputJsonValue },
          });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      agentName,
      report,
      agentRunId: run.id,
      prFixResolution,
      ...(closeResolution ? { closeResolution } : {}),
      ...(duplicate ? { duplicate: true } : {}),
    });
  } catch (error) {
    // An unexpected failure after validation (DB write, idempotency claim,
    // resolution persistence) must surface as a structured 5xx, not an
    // unhandled rejection — a worker retrying after a 5xx relies on the
    // idempotency key to land in the duplicate branch.
    return handleApiError("report task", error);
  }
}
