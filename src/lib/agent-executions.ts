/**
 * (#1495) Source-neutral "agent execution observation" core.
 *
 * External sources (e.g. Courier harnesses) report active executions — issue
 * work and PR-fix work — keyed by the durable run UID. This module owns the
 * semantics: validation of the Courier wire contract, the state-fenced
 * upsert, and the read path the Agents page consumes. Observation only:
 * nothing here writes AgentWork rows, leases, or ownership state, and
 * nothing reads them.
 *
 * Wire contract (Courier #637): current state is keyed by (runUID, state) —
 * an upsert, not an event log. Fencing is primarily by state kind: a
 * terminal observation is never replaced by a non-terminal one; `observedAt`
 * orders non-terminal changes and drives staleness display. The wire
 * `idempotencyKey` ONLY dedupes byte-identical deliveries (a retried lost
 * response); it is NEVER the storage identity.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const AGENT_EXECUTION_WORK_TYPES = ["implement", "pr_fix", "followup-pr"] as const;
export type AgentExecutionWorkType = (typeof AGENT_EXECUTION_WORK_TYPES)[number];

export const AGENT_EXECUTION_STATES = [
  "RUNNING",
  "VERIFYING",
  "AWAITING_REVIEW",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "BLOCKED_EXTERNAL",
  "HANDED_OFF",
] as const;
export type AgentExecutionState = (typeof AGENT_EXECUTION_STATES)[number];

/** Terminal states end the execution; a terminal row never reopens. */
export const TERMINAL_AGENT_EXECUTION_STATES: readonly AgentExecutionState[] = [
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "BLOCKED_EXTERNAL",
  "HANDED_OFF",
] as const;

/**
 * Courier wire state vocabulary (#637) → stored uppercase state. The wire
 * states are the contract; the stored values are the internal vocabulary.
 */
const WIRE_STATE_TO_STORED: Record<string, AgentExecutionState> = {
  running: "RUNNING",
  verifying: "VERIFYING",
  "awaiting-review": "AWAITING_REVIEW",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  blocked: "BLOCKED",
  "blocked-external": "BLOCKED_EXTERNAL",
  "handed-off": "HANDED_OFF",
};

export function isAgentExecutionState(value: unknown): value is AgentExecutionState {
  return (
    typeof value === "string" &&
    (AGENT_EXECUTION_STATES as readonly string[]).includes(value)
  );
}

export function isTerminalAgentExecutionState(
  value: AgentExecutionState,
): boolean {
  return (TERMINAL_AGENT_EXECUTION_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Liveness windows
// ---------------------------------------------------------------------------

/**
 * A non-terminal execution older than this since its last observation is
 * shown as "stale". Staleness is INFORMATIONAL ONLY — it never implies
 * absence of a worker, releases nothing, and mutates nothing. Only the
 * source can retire an execution (via a terminal report).
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
 * the source's final word on a run UID. A delayed NON-terminal delivery must
 * never resurrect terminal work, so it is rejected; a terminal→terminal
 * observation is accepted as a refinement (the first terminal observation
 * stays the end time). A source that restarts the work mints a NEW run UID —
 * the run UID is the attempt identity.
 */

// ---------------------------------------------------------------------------
// Observation input + validation (Courier #637 wire contract)
// ---------------------------------------------------------------------------

/**
 * The validated observation, normalized from the Courier wire body:
 * `version` 1, `agent`, `source`, `run {uid, namespace, name}`,
 * `work {itemId, identity, mode, type?}`, `state`, `observedAt`,
 * optional `pullRequestNumber` / `pullRequestUrl`.
 */
export interface ExecutionObservationInput {
  agentName: string;
  idempotencyKey: string;
  source: string;
  /** Durable attempt identity — a recreated run is a NEW uid. */
  runUid: string;
  runNamespace: string | null;
  runName: string | null;
  /** Opaque work id — NOT a database foreign key. */
  workItemId: string;
  workIdentity: string | null;
  /** Source-neutral work kind. */
  workMode: string | null;
  /** Present only for mapped modes: "implement" or "followup-pr" ("pr_fix" legacy-accepted). */
  workType: string | null;
  /** Stored uppercase state (mapped from the wire vocabulary). */
  executionState: AgentExecutionState;
  /** Raw wire timestamp (ISO 8601); resolved against `now` at apply time. */
  observedAt: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
}

/** The minimal row shape the upsert reads (existing row or null). */
export type ExistingExecutionRow = {
  id: string;
  agentName: string;
  source: string;
  executionId: string;
  workType: string | null;
  workRefUrl: string | null;
  workItemId: string | null;
  workIdentity: string | null;
  mode: string | null;
  runNamespace: string | null;
  runName: string | null;
  pullRequestNumber: number | null;
  executionState: string;
  startedAt: Date | null;
  lastObservedAt: Date;
  endedAt: Date | null;
  summary: string | null;
  idempotencyKey: string;
};

const URL_PATTERN = /^https?:\/\//;

const MAX_AGENT_NAME = 100;
const MAX_IDEMPOTENCY_KEY = 300;
const MAX_SOURCE = 200;
const MAX_RUN_FIELD = 200;
const MAX_WORK_ITEM_ID = 200;
const MAX_WORK_IDENTITY = 300;
const MAX_WORK_MODE = 100;
const MAX_URL = 2000;

function requiredString(value: unknown, field: string, max: number): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new AgentExecutionError(
      "invalid_report",
      `Missing required field: ${field} (non-empty string, max ${max} chars)`,
    );
  }
  return trimmed;
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new AgentExecutionError("invalid_report", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new AgentExecutionError("invalid_report", `${field} exceeds ${max} characters`);
  }
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Validate (and normalize) a Courier observation body. Throws
 * AgentExecutionError (code "invalid_report") on any invalid field.
 */
export function validateExecutionObservation(input: unknown): ExecutionObservationInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AgentExecutionError("invalid_report", "Request body must be a JSON object");
  }
  const raw = input as Record<string, unknown>;

  if (raw.version !== 1) {
    throw new AgentExecutionError(
      "invalid_report",
      "Missing/invalid required field: version (must be 1)",
    );
  }

  const agentName = requiredString(raw.agent, "agent", MAX_AGENT_NAME);
  const idempotencyKey = requiredString(raw.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY);
  const source = requiredString(raw.source, "source", MAX_SOURCE);

  if (typeof raw.run !== "object" || raw.run === null || Array.isArray(raw.run)) {
    throw new AgentExecutionError("invalid_report", "run must be a JSON object");
  }
  const run = raw.run as Record<string, unknown>;
  const runUid = requiredString(run.uid, "run.uid", MAX_RUN_FIELD);
  const runNamespace = optionalString(run.namespace, "run.namespace", MAX_RUN_FIELD);
  const runName = optionalString(run.name, "run.name", MAX_RUN_FIELD);

  if (typeof raw.work !== "object" || raw.work === null || Array.isArray(raw.work)) {
    throw new AgentExecutionError("invalid_report", "work must be a JSON object");
  }
  const work = raw.work as Record<string, unknown>;
  const workItemId = requiredString(work.itemId, "work.itemId", MAX_WORK_ITEM_ID);
  const workIdentity = optionalString(work.identity, "work.identity", MAX_WORK_IDENTITY);
  const workMode = optionalString(work.mode, "work.mode", MAX_WORK_MODE);

  let workType: string | null = null;
  if (work.type !== undefined && work.type !== null) {
    workType = optionalString(work.type, "work.type", MAX_WORK_MODE);
    if (workType && !(AGENT_EXECUTION_WORK_TYPES as readonly string[]).includes(workType)) {
      throw new AgentExecutionError(
        "invalid_report",
        `Invalid work.type: expected one of ${AGENT_EXECUTION_WORK_TYPES.join(", ")}`,
      );
    }
  }

  const storedState = WIRE_STATE_TO_STORED[raw.state as string];
  if (!storedState) {
    throw new AgentExecutionError(
      "invalid_report",
      `Invalid state: expected one of ${Object.keys(WIRE_STATE_TO_STORED).join(", ")}`,
    );
  }

  if (
    typeof raw.observedAt !== "string" ||
    !Number.isFinite(new Date(raw.observedAt).getTime())
  ) {
    throw new AgentExecutionError(
      "invalid_report",
      "Missing/invalid required field: observedAt (ISO 8601 timestamp)",
    );
  }

  let pullRequestNumber: number | null = null;
  if (raw.pullRequestNumber !== undefined && raw.pullRequestNumber !== null) {
    if (
      typeof raw.pullRequestNumber !== "number" ||
      !Number.isInteger(raw.pullRequestNumber) ||
      raw.pullRequestNumber < 1
    ) {
      throw new AgentExecutionError(
        "invalid_report",
        "pullRequestNumber must be a positive integer",
      );
    }
    pullRequestNumber = raw.pullRequestNumber;
  }

  let pullRequestUrl: string | null = null;
  if (raw.pullRequestUrl !== undefined && raw.pullRequestUrl !== null) {
    pullRequestUrl = optionalString(raw.pullRequestUrl, "pullRequestUrl", MAX_URL);
    if (pullRequestUrl && !URL_PATTERN.test(pullRequestUrl)) {
      throw new AgentExecutionError(
        "invalid_report",
        "pullRequestUrl must be an http(s) URL",
      );
    }
  }

  return {
    agentName,
    idempotencyKey,
    source,
    runUid,
    runNamespace,
    runName,
    workItemId,
    workIdentity,
    workMode,
    workType,
    executionState: storedState,
    observedAt: raw.observedAt,
    pullRequestNumber,
    pullRequestUrl,
  };
}

/**
 * Resolve the row's lastObservedAt from an observation: the ISO `observedAt`
 * is accepted when parseable and not in the future; otherwise now. A future
 * timestamp is clamped to now.
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

/** The later of two timestamps — keeps lastObservedAt monotonic on updates. */
function laterOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

// ---------------------------------------------------------------------------
// Upsert decision (pure) + application (injected deps)
// ---------------------------------------------------------------------------

export type ExecutionObservationOutcome =
  | { status: "created" }
  | { status: "updated" }
  | { status: "duplicate" }
  | { status: "staleIgnored" };

/**
 * Pure decision for the (existing row, observation) pair. Returns either the
 * data to persist, or a terminal outcome. Throws AgentExecutionError for
 * fenced conflicts.
 *
 * - no row → created (startedAt = observedAt; endedAt = observedAt iff terminal);
 * - idempotencyKey replay → duplicate (no mutation) — checked FIRST, so an
 *   identical terminal delivery replays as duplicate rather than fencing;
 * - existing terminal + incoming non-terminal → execution_terminal (409):
 *   a delayed non-terminal must never resurrect terminal work;
 * - existing terminal + incoming terminal → updated, KEEPING the original
 *   endedAt (first terminal observation stays the end time) and startedAt;
 * - existing non-terminal: observedAt >= existing.lastObservedAt → updated
 *   (endedAt = observedAt iff incoming terminal); observedAt <
 *   existing.lastObservedAt → staleIgnored (acknowledged, NO mutation) so
 *   the source stops retrying without overwriting newer state.
 */
export function applyExecutionObservation(
  input: ExecutionObservationInput,
  existing: ExistingExecutionRow | null,
  now: Date,
): ExecutionObservationOutcome & { data?: Record<string, unknown> } {
  const observedAt = resolveObservedAt(input.observedAt, now);
  const terminal = isTerminalAgentExecutionState(input.executionState);

  const descriptive = {
    source: input.source,
    workType: input.workType,
    workRefUrl: input.pullRequestUrl,
    workItemId: input.workItemId,
    workIdentity: input.workIdentity,
    mode: input.workMode,
    runNamespace: input.runNamespace,
    runName: input.runName,
    pullRequestNumber: input.pullRequestNumber,
  };

  // No existing row: create (any state accepted; a terminal creation ends at
  // the observation time).
  if (!existing) {
    return {
      status: "created",
      data: {
        agentName: input.agentName,
        executionId: input.runUid,
        executionState: input.executionState,
        startedAt: observedAt,
        lastObservedAt: observedAt,
        endedAt: terminal ? observedAt : null,
        summary: null,
        idempotencyKey: input.idempotencyKey,
        ...descriptive,
      },
    };
  }

  // Byte-identical delivery replay (a retried lost response): no mutation.
  // This comes BEFORE the terminal fence so an identical terminal delivery
  // replays as duplicate.
  if (existing.idempotencyKey === input.idempotencyKey) {
    return { status: "duplicate" };
  }

  // Existing terminal row: the attempt is over.
  if (isTerminalAgentExecutionState(existing.executionState as AgentExecutionState)) {
    if (!terminal) {
      throw new AgentExecutionError(
        "execution_terminal",
        `Execution ${existing.executionId} for agent ${existing.agentName} already ended (${existing.executionState}); a delayed non-terminal observation may not resurrect it`,
      );
    }
    // Terminal → terminal refinement: keep the original endedAt (the first
    // terminal observation stays the end time) and startedAt. lastObservedAt
    // never regresses: staleness display stays monotonic.
    return {
      status: "updated",
      data: {
        executionState: input.executionState,
        lastObservedAt: laterOf(observedAt, existing.lastObservedAt),
        idempotencyKey: input.idempotencyKey,
        ...descriptive,
      },
    };
  }

  // Existing non-terminal row. observedAt orders NON-terminal changes: a
  // delayed old non-terminal delivery is acknowledged (staleIgnored, no
  // mutation) so the source stops retrying without overwriting newer state.
  // A terminal delivery always applies regardless of observedAt — the state
  // kind is the fence, and the run is over; declining it on clock order
  // would leave a finished run listed as active forever.
  if (!terminal && observedAt.getTime() < existing.lastObservedAt.getTime()) {
    return { status: "staleIgnored" };
  }

  return {
    status: "updated",
    data: {
      executionState: input.executionState,
      lastObservedAt: laterOf(observedAt, existing.lastObservedAt),
      idempotencyKey: input.idempotencyKey,
      endedAt: terminal ? observedAt : null,
      ...descriptive,
    },
  };
}

/**
 * Injectable Prisma surface — mirrors how src/lib/agent-work.ts scopes IO.
 * `updateMany` (not `update`) is the write primitive so the upsert can fence
 * on the observed idempotency key and detect a concurrent writer via
 * `count: 0`.
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

export interface RecordExecutionObservationResult {
  outcome: ExecutionObservationOutcome;
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
 * Apply a validated observation through the injected deps, race-safe.
 *
 * The pure decision (`applyExecutionObservation`) stays the single decision
 * authority; only the write mechanics serialize concurrent writers:
 *
 * - the write is a conditional `updateMany` fenced on
 *   `(id, idempotencyKey: existing.idempotencyKey)` — a `count: 0` means a
 *   concurrent writer moved the row, so the row is re-read and the decision
 *   re-run, bounded by REPORT_MAX_ATTEMPTS before surfacing 409
 *   `stale_report` (a lost race is exactly a stale report from this
 *   caller's perspective);
 * - a `create` that loses the unique-constraint race (P2002) re-reads and
 *   re-decides instead of bubbling the P2002 to a 500.
 *
 * The caller (route) maps AgentExecutionError to HTTP status + code. Audit
 * is best-effort: a failure to write the audit row never fails the report.
 */
export async function reportExecutionObservation(
  deps: AgentExecutionDeps,
  input: ExecutionObservationInput,
  options: { actor?: string; now?: Date } = {},
): Promise<RecordExecutionObservationResult> {
  const now = options.now ?? new Date();

  for (let attempt = 1; attempt <= REPORT_MAX_ATTEMPTS; attempt++) {
    const existing = await deps.agentExecution.findUnique({
      where: {
        agentName_executionId: {
          agentName: input.agentName,
          executionId: input.runUid,
        },
      },
    });

    // Single decision authority — never re-derived ad hoc.
    const decision = applyExecutionObservation(input, existing, now);

    if (decision.status === "duplicate" || decision.status === "staleIgnored") {
      return { outcome: { status: decision.status }, execution: existing };
    }

    if (decision.status === "created") {
      try {
        const execution = await deps.agentExecution.create({ data: decision.data! });
        await writeExecutionAudit(deps, input, options.actor);
        return { outcome: { status: "created" }, execution };
      } catch (error) {
        // Lost the (agentName, runUid) create race: re-read the winner and
        // re-decide. If that still says create, loop (bounded).
        if (isUniqueViolation(error)) continue;
        throw error;
      }
    }

    // "updated": conditional write fenced on the observed idempotency key.
    const result = await deps.agentExecution.updateMany({
      where: {
        id: existing!.id,
        idempotencyKey: existing!.idempotencyKey,
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
            executionId: input.runUid,
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
    `Execution ${input.runUid} for agent ${input.agentName} kept changing under concurrent writers after ${REPORT_MAX_ATTEMPTS} attempts; retry with a fresh observation`,
  );
}

/**
 * Best-effort audit row for an accepted (created/updated) report — a failure
 * here never fails the report itself.
 */
async function writeExecutionAudit(
  deps: AgentExecutionDeps,
  input: ExecutionObservationInput,
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
