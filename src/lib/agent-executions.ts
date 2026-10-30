/**
 * (#1495) Source-neutral "agent execution observation" core.
 *
 * External sources (e.g. Courier harnesses) report active executions — issue
 * work and PR-fix work — keyed by (agentName, executionId). This module owns
 * the semantics: validation, the revision-fenced upsert, and the read path
 * the Agents page consumes. Observation only: nothing here writes AgentWork
 * rows, leases, or ownership state, and nothing reads them.
 *
 * Ordering authority is the source-supplied monotonic `revision`, never
 * `lastObservedAt` — the source's clock is display data. A terminal state
 * fences the row wholesale: post-terminal reports are either idempotent
 * replays or rejected, because a restart is a NEW executionId (see
 * TERMINAL_FENCING below).
 */

// ---------------------------------------------------------------------------
// Capability + vocabularies
// ---------------------------------------------------------------------------

/**
 * Capability descriptor returned by GET /api/agent-executions so consumers
 * can discover the surface. Bump `protocolVersion` only for a breaking
 * change to the report contract or the list shape.
 */
export const AGENT_EXECUTION_CAPABILITY = {
  name: "agent-executions",
  protocolVersion: 1,
} as const;

export const AGENT_EXECUTION_WORK_TYPES = ["implement", "pr_fix"] as const;
export type AgentExecutionWorkType = (typeof AGENT_EXECUTION_WORK_TYPES)[number];

export const AGENT_EXECUTION_STATES = [
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type AgentExecutionState = (typeof AGENT_EXECUTION_STATES)[number];

/** Terminal states end the execution; a terminal row never reopens. */
export const TERMINAL_AGENT_EXECUTION_STATES: readonly AgentExecutionState[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

export function isAgentExecutionState(value: unknown): value is AgentExecutionState {
  return (
    typeof value === "string" &&
    (AGENT_EXECUTION_STATES as readonly string[]).includes(value)
  );
}

export function isTerminalAgentExecutionState(
  value: AgentExecutionState,
): value is Exclude<AgentExecutionState, "RUNNING"> {
  return (TERMINAL_AGENT_EXECUTION_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Liveness windows
// ---------------------------------------------------------------------------

/**
 * A RUNNING execution older than this since its last observation is shown as
 * "stale". Staleness is INFORMATIONAL ONLY — it never implies absence of a
 * worker, releases nothing, and mutates nothing. Only the source can retire
 * an execution (via a terminal report).
 */
export const AGENT_EXECUTION_LIVENESS_MS = 15 * 60_000;

/** Recently-finished terminal rows stay listed for this long after their last observation. */
export const AGENT_EXECUTION_RECENT_TERMINAL_MS = 24 * 60 * 60_000;

export type ExecutionStaleness = "live" | "stale";

/**
 * Derive display staleness from the row's last observation. Stale is
 * informational only; NEVER implies absence of a worker.
 */
export function deriveExecutionStaleness(
  lastObservedAt: Date,
  now: Date,
): ExecutionStaleness {
  return now.getTime() - lastObservedAt.getTime() > AGENT_EXECUTION_LIVENESS_MS
    ? "stale"
    : "live";
}

// ---------------------------------------------------------------------------
// Typed errors (mapped to HTTP status + code by the route)
// ---------------------------------------------------------------------------

export type AgentExecutionErrorCode =
  // 409-class: the report conflicts with persisted fencing state.
  | "execution_terminal"
  | "stale_report"
  // 400-class: the payload itself is invalid.
  | "invalid_report";

export class AgentExecutionError extends Error {
  readonly code: AgentExecutionErrorCode;
  readonly status: number;

  constructor(code: AgentExecutionErrorCode, message: string) {
    super(message);
    this.name = "AgentExecutionError";
    this.code = code;
    this.status = code === "invalid_report" ? 400 : 409;
  }
}

/**
 * Why terminal rows are fenced (`execution_terminal`): a terminal state is
 * the source's final word on an executionId. Delayed old reports and
 * post-terminal rewrites are rejected rather than applied or duplicated
 * into state changes. A source that restarts the work must mint a NEW
 * executionId — the pair (agentName, executionId) is the attempt identity.
 */

// ---------------------------------------------------------------------------
// Report input + validation
// ---------------------------------------------------------------------------

export interface ExecutionReportInput {
  agentName: string;
  source: string;
  executionId: string;
  workType: string;
  workRefUrl?: string | null;
  issueId?: string | null;
  executionState: string;
  startedAt?: string | null;
  /** Optional ISO timestamp of the source-side observation; display data only. */
  observedAt?: string | null;
  summary?: string | null;
  revision: number;
}

/** The minimal row shape the upsert reads (existing row or null). */
export type ExistingExecutionRow = {
  id: string;
  agentName: string;
  source: string;
  executionId: string;
  workType: string;
  workRefUrl: string | null;
  issueId: string | null;
  executionState: string;
  startedAt: Date | null;
  lastObservedAt: Date;
  endedAt: Date | null;
  summary: string | null;
  revision: number;
};

const WORK_REF_URL_PATTERN = /^https?:\/\//;

const MAX_AGENT_NAME = 100;
const MAX_EXECUTION_ID = 200;
const MAX_SOURCE = 200;
const MAX_SUMMARY = 2000;
const MAX_ISSUE_ID = 200;

/** The `revision` column is INTEGER (Int32): fence at 2**31 - 1. */
const MAX_REVISION = 2 ** 31 - 1;

function trimmedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function optionalString(value: unknown, max: number): { value?: string | null; error?: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string") return { error: "must be a string" };
  const trimmed = value.trim();
  if (trimmed.length > max) return { error: `exceeds ${max} characters` };
  return { value: trimmed.length === 0 ? null : trimmed };
}

/**
 * Validate (and normalize) a report payload. Throws AgentExecutionError
 * (code "invalid_report") on any invalid field.
 */
export function validateExecutionReport(input: unknown): ExecutionReportInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AgentExecutionError("invalid_report", "Request body must be a JSON object");
  }
  const raw = input as Record<string, unknown>;

  const agentName = trimmedString(raw.agentName, MAX_AGENT_NAME);
  if (!agentName) {
    throw new AgentExecutionError(
      "invalid_report",
      `Missing required field: agentName (non-empty string, max ${MAX_AGENT_NAME} chars)`,
    );
  }
  const executionId = trimmedString(raw.executionId, MAX_EXECUTION_ID);
  if (!executionId) {
    throw new AgentExecutionError(
      "invalid_report",
      `Missing required field: executionId (non-empty string, max ${MAX_EXECUTION_ID} chars)`,
    );
  }
  const source = trimmedString(raw.source, MAX_SOURCE);
  if (!source) {
    throw new AgentExecutionError(
      "invalid_report",
      `Missing required field: source (non-empty string, max ${MAX_SOURCE} chars)`,
    );
  }

  const workType = trimmedString(raw.workType, MAX_SOURCE);
  if (!workType || !(AGENT_EXECUTION_WORK_TYPES as readonly string[]).includes(workType)) {
    throw new AgentExecutionError(
      "invalid_report",
      `Invalid workType: expected one of ${AGENT_EXECUTION_WORK_TYPES.join(", ")}`,
    );
  }

  if (!isAgentExecutionState(raw.executionState)) {
    throw new AgentExecutionError(
      "invalid_report",
      `Invalid executionState: expected one of ${AGENT_EXECUTION_STATES.join(", ")}`,
    );
  }
  const executionState = raw.executionState;

  const workRefUrl = optionalString(raw.workRefUrl, 2000);
  if (workRefUrl.error) {
    throw new AgentExecutionError("invalid_report", `workRefUrl ${workRefUrl.error}`);
  }
  if (workRefUrl.value && !WORK_REF_URL_PATTERN.test(workRefUrl.value)) {
    throw new AgentExecutionError(
      "invalid_report",
      "workRefUrl must be an http(s) URL",
    );
  }

  const summary = optionalString(raw.summary, MAX_SUMMARY);
  if (summary.error) {
    throw new AgentExecutionError("invalid_report", `summary ${summary.error}`);
  }

  const issueId = optionalString(raw.issueId, MAX_ISSUE_ID);
  if (issueId.error) {
    throw new AgentExecutionError("invalid_report", `issueId ${issueId.error}`);
  }

  if (
    typeof raw.revision !== "number" ||
    !Number.isInteger(raw.revision) ||
    raw.revision < 0 ||
    // The column is INTEGER (Int32): values above 2**31 - 1 would surface as
    // a 500 at write time, so fence them here as an invalid report.
    raw.revision > MAX_REVISION
  ) {
    throw new AgentExecutionError(
      "invalid_report",
      `Missing/invalid required field: revision (integer 0..${MAX_REVISION})`,
    );
  }

  let startedAt: string | null = null;
  if (raw.startedAt !== undefined && raw.startedAt !== null) {
    if (typeof raw.startedAt !== "string" || !Number.isFinite(new Date(raw.startedAt).getTime())) {
      throw new AgentExecutionError(
        "invalid_report",
        "startedAt must be a valid ISO 8601 timestamp",
      );
    }
    startedAt = raw.startedAt;
  }

  let observedAt: string | null = null;
  if (raw.observedAt !== undefined && raw.observedAt !== null) {
    if (typeof raw.observedAt !== "string" || !Number.isFinite(new Date(raw.observedAt).getTime())) {
      throw new AgentExecutionError(
        "invalid_report",
        "observedAt must be a valid ISO 8601 timestamp",
      );
    }
    observedAt = raw.observedAt;
  }

  return {
    agentName,
    source,
    executionId,
    workType,
    workRefUrl: workRefUrl.value,
    issueId: issueId.value,
    executionState,
    startedAt,
    observedAt,
    summary: summary.value,
    revision: raw.revision,
  };
}

/**
 * Resolve the row's lastObservedAt from a report: the optional ISO
 * `observedAt` is accepted when parseable and not in the future; otherwise
 * now. Never trusted for ordering — ordering authority is `revision`.
 */
export function resolveObservedAt(observedAt: string | null | undefined, now: Date): Date {
  if (observedAt) {
    const parsed = new Date(observedAt);
    if (Number.isFinite(parsed.getTime()) && parsed.getTime() <= now.getTime()) {
      return parsed;
    }
  }
  return now;
}

/** Canonical payload of the report fields an update may carry. */
function samePayload(a: ExistingExecutionRow, input: ExecutionReportInput): boolean {
  return (
    a.source === input.source &&
    a.workType === input.workType &&
    (a.workRefUrl ?? null) === (input.workRefUrl ?? null) &&
    (a.issueId ?? null) === (input.issueId ?? null) &&
    a.executionState === input.executionState &&
    (a.startedAt?.getTime() ?? null) === (input.startedAt ? new Date(input.startedAt).getTime() : null) &&
    (a.summary ?? null) === (input.summary ?? null)
  );
}

// ---------------------------------------------------------------------------
// Upsert decision (pure) + application (injected deps)
// ---------------------------------------------------------------------------

export type ExecutionReportOutcome =
  | { status: "created" }
  | { status: "updated" }
  | { status: "duplicate" };

/**
 * Pure decision for the (existing row, report) pair. Returns either the
 * data to persist, or a terminal outcome. Throws AgentExecutionError for
 * fenced conflicts.
 */
export function applyExecutionReport(
  input: ExecutionReportInput,
  existing: ExistingExecutionRow | null,
  now: Date,
): ExecutionReportOutcome & { data?: Record<string, unknown> } {
  const observedAt = resolveObservedAt(input.observedAt, now);
  const terminal = isTerminalAgentExecutionState(
    input.executionState as AgentExecutionState,
  );

  // No existing row: create (RUNNING or terminal accepted; a terminal
  // creation ends at the observation time).
  if (!existing) {
    return {
      status: "created",
      data: {
        agentName: input.agentName,
        source: input.source,
        executionId: input.executionId,
        workType: input.workType,
        workRefUrl: input.workRefUrl,
        issueId: input.issueId,
        executionState: input.executionState,
        startedAt: input.startedAt ? new Date(input.startedAt) : null,
        lastObservedAt: observedAt,
        endedAt: terminal ? observedAt : null,
        summary: input.summary,
        revision: input.revision,
      },
    };
  }

  // Existing terminal row: the attempt is over.
  if (isTerminalAgentExecutionState(existing.executionState as AgentExecutionState)) {
    if (
      existing.executionState === input.executionState &&
      input.revision <= existing.revision
    ) {
      // Idempotent replay: no mutation, no resurrection, no endedAt drift.
      return { status: "duplicate" };
    }
    // Different state, or a newer revision trying to rewrite history: fenced.
    // A restart is a NEW executionId (see TERMINAL_FENCING above).
    throw new AgentExecutionError(
      "execution_terminal",
      `Execution ${existing.executionId} for agent ${existing.agentName} already ended (${existing.executionState}); a restart must use a new executionId`,
    );
  }

  // Existing RUNNING row: revision is the ordering authority.
  if (input.revision > existing.revision) {
    return {
      status: "updated",
      data: {
        source: input.source,
        workType: input.workType,
        workRefUrl: input.workRefUrl,
        issueId: input.issueId,
        executionState: input.executionState,
        startedAt: input.startedAt ? new Date(input.startedAt) : existing.startedAt,
        lastObservedAt: observedAt,
        endedAt: terminal ? observedAt : null,
        summary: input.summary,
        revision: input.revision,
      },
    };
  }

  if (input.revision === existing.revision) {
    // Same revision: identical payload is an idempotent replay; anything
    // else is a conflicting same-revision report.
    if (samePayload(existing, input)) {
      return { status: "duplicate" };
    }
    throw new AgentExecutionError(
      "stale_report",
      `Conflicting same-revision report for execution ${existing.executionId}: revision ${input.revision} already recorded with a different payload`,
    );
  }

  // Lower revision: out-of-order / delayed report.
  throw new AgentExecutionError(
    "stale_report",
    `Out-of-order report for execution ${existing.executionId}: revision ${input.revision} is older than recorded revision ${existing.revision}`,
  );
}

/**
 * Injectable Prisma surface — mirrors how src/lib/agent-work.ts scopes IO.
 * `updateMany` (not `update`) is the write primitive so the upsert can fence
 * on the observed (revision, executionState) pair and detect a concurrent
 * writer via `count: 0`.
 */
export interface AgentExecutionDeps {
  agentExecution: {
    findUnique(args: {
      where: { agentName_executionId: { agentName: string; executionId: string } };
    }): Promise<ExistingExecutionRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface RecordExecutionReportResult {
  outcome: ExecutionReportOutcome;
  execution: unknown;
}

/** Bounded retry budget for the read/decide/write loop below. */
const REPORT_MAX_ATTEMPTS = 3;

/**
 * Prisma unique-constraint violation (the real client throws
 * PrismaClientKnownRequestError with `code: "P2002"`; tests may throw a
 * plain object with the same shape).
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Apply a validated report through the injected deps, race-safe.
 *
 * The pure decision (`applyExecutionReport`) stays the single decision
 * authority; only the write mechanics serialize concurrent writers:
 *
 * - `update` becomes a conditional `updateMany` fenced on the observed
 *   `(id, revision, executionState)` — a `count: 0` means a concurrent
 *   writer moved the row, so the row is re-read and the decision re-run,
 *   bounded by REPORT_MAX_ATTEMPTS before surfacing 409 `stale_report`
 *   (a lost race is exactly a stale report from this caller's perspective);
 * - a `create` that loses the unique-constraint race (P2002) re-reads and
 *   re-decides instead of bubbling the P2002 to a 500.
 *
 * The caller (route) maps AgentExecutionError to HTTP status + code. Audit
 * is best-effort: a failure to write the audit row never fails the report.
 */
export async function recordExecutionReport(
  deps: AgentExecutionDeps,
  input: ExecutionReportInput,
  options: { actor?: string; now?: Date } = {},
): Promise<RecordExecutionReportResult> {
  const now = options.now ?? new Date();

  for (let attempt = 1; attempt <= REPORT_MAX_ATTEMPTS; attempt++) {
    const existing = await deps.agentExecution.findUnique({
      where: {
        agentName_executionId: {
          agentName: input.agentName,
          executionId: input.executionId,
        },
      },
    });

    // Single decision authority — never re-derived ad hoc.
    const decision = applyExecutionReport(input, existing, now);

    if (decision.status === "duplicate") {
      return { outcome: { status: "duplicate" }, execution: existing };
    }

    if (decision.status === "created") {
      try {
        const execution = await deps.agentExecution.create({ data: decision.data! });
        await writeExecutionAudit(deps, input, options.actor);
        return { outcome: { status: "created" }, execution };
      } catch (error) {
        // Lost the (agentName, executionId) create race: re-read the winner
        // and re-decide. If that still says create, loop (bounded).
        if (isUniqueViolation(error)) continue;
        throw error;
      }
    }

    // "updated": conditional write fenced on the observed pair.
    const result = await deps.agentExecution.updateMany({
      where: {
        id: existing!.id,
        revision: existing!.revision,
        executionState: existing!.executionState,
      },
      data: decision.data!,
    });
    if (result.count > 0) {
      // Display-only re-read for the response body; a further concurrent
      // move by another writer is acceptable here (display data, and the
      // write itself was fenced).
      const execution = await deps.agentExecution.findUnique({
        where: {
          agentName_executionId: {
            agentName: input.agentName,
            executionId: input.executionId,
          },
        },
      });
      await writeExecutionAudit(deps, input, options.actor);
      return { outcome: { status: "updated" }, execution };
    }
    // A concurrent writer moved the row between the read and the write —
    // loop to re-read and re-decide (bounded below).
  }

  throw new AgentExecutionError(
    "stale_report",
    `Execution ${input.executionId} for agent ${input.agentName} kept changing under concurrent writers after ${REPORT_MAX_ATTEMPTS} attempts; retry with a fresh observation`,
  );
}

/**
 * Best-effort audit row for an accepted (created/updated) report — a failure
 * here never fails the report itself.
 */
async function writeExecutionAudit(
  deps: AgentExecutionDeps,
  input: ExecutionReportInput,
  actor: string | undefined,
): Promise<void> {
  try {
    await deps.auditLog.create({
      data: {
        actor: actor ?? input.agentName,
        action: "agent_execution_report",
        repoFullName: "unknown",
        success: true,
        errorMessage: null,
        beforeLabels: [],
        afterLabels: [],
      },
    });
  } catch {
    // Best-effort audit only — never fail the report for the audit row.
  }
}

// ---------------------------------------------------------------------------
// Read path (display-only)
// ---------------------------------------------------------------------------

export type ActiveExecutionRow = ExistingExecutionRow & {
  staleness: ExecutionStaleness;
};

/** Injectable read surface. */
export interface AgentExecutionListDeps {
  agentExecution: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, string>;
      take: number;
    }): Promise<ExistingExecutionRow[]>;
  };
}

/**
 * Display cap for the active-executions list: the Agents page shows the most
 * recently observed rows only. Newest first via the orderBy below.
 */
export const AGENT_EXECUTION_LIST_LIMIT = 200;

/**
 * List executions worth showing: non-terminal rows of any age plus terminal
 * rows whose last observation is inside RECENT_TERMINAL_MS, newest
 * observation first (bounded by AGENT_EXECUTION_LIST_LIMIT), each annotated
 * with display staleness. Read-only — never mutates rows.
 */
export async function listActiveExecutions(
  deps: AgentExecutionListDeps,
  now: Date = new Date(),
): Promise<ActiveExecutionRow[]> {
  const rows = await deps.agentExecution.findMany({
    where: {
      OR: [
        { executionState: { notIn: [...TERMINAL_AGENT_EXECUTION_STATES] } },
        { lastObservedAt: { gte: new Date(now.getTime() - AGENT_EXECUTION_RECENT_TERMINAL_MS) } },
      ],
    },
    orderBy: { lastObservedAt: "desc" },
    take: AGENT_EXECUTION_LIST_LIMIT,
  });
  return rows.map((row) => ({
    ...row,
    staleness: deriveExecutionStaleness(row.lastObservedAt, now),
  }));
}