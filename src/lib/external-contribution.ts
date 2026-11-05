/**
 * Dispatch-owned external contribution requests (#1537, parent #1349).
 *
 * Persist-before-network state machine around `submitAdmission`:
 *
 *   1. Validate the request and canonicalize its fields.
 *   2. Persist the row (key + canonical fields + payload digest) BEFORE the
 *      first network call, so timeouts, restarts, and lost success responses
 *      all replay the SAME identity and payload.
 *   3. Submit to Courier via the configured admission endpoint, then record
 *      exactly one of three distinct outcomes: `accepted` (identity returned),
 *      `rejected` (explicit Courier refusal), `uncertain` (timeout / network /
 *      malformed response — delivery outcome unknown).
 *
 * Identity rules:
 *   - One idempotency key is one contribution identity (`idempotencyKey`
 *     unique). A repeat submission with the same key and an identical payload
 *     never creates another row and never re-admits an accepted request.
 *   - A changed payload under an existing key is a 409-class conflict.
 *   - Uncertain delivery retries with the ORIGINAL key (Courier dedupes by
 *     key), bounded by `MAX_DELIVERY_ATTEMPTS` via an attempt-count fence so
 *     concurrent callers cannot double-submit. A deliberate new contribution
 *     is a separate row with its own key.
 *
 * Boundaries: this module never calls GitHub (a supplied upstreamIssue URL is
 * stored verbatim and passed to Courier — no claim/label/assign/comment/close),
 * never writes Kubernetes state, and never stores the Courier credential.
 */
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { isValidRepoName } from "./config";
import {
  newIdempotencyKey,
  redactSecret,
  submitAdmission,
  type AdmissionRequestFields,
  type CourierAdmissionConfig,
} from "./courier-admission";

/** Distinct delivery outcomes recorded on the ledger row. */
export const EXTERNAL_CONTRIBUTION_STATUSES = ["pending", "accepted", "rejected", "uncertain"] as const;
export type ExternalContributionStatus = (typeof EXTERNAL_CONTRIBUTION_STATUSES)[number];

/**
 * Bound on Courier delivery retries for one request identity. Uncertain
 * outcomes (timeout / network / malformed / 5xx) may be re-attempted by a
 * later submission with the same key up to this many attempts total; an
 * explicit Courier rejection is terminal and is never retried.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Validated, canonical request input (before persistence). */
export interface ContributionInput {
  namespace: string;
  lane: string;
  baseRepo: string;
  baseRef: string;
  workRepo: string;
  goal: string;
  upstreamIssue: string | null;
  idempotencyKey: string | null;
}

type ValidationOk = { ok: true; input: ContributionInput };
type ValidationErr = { ok: false; error: string };

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Reject control characters (newlines included) in single-line wire fields. */
function hasControlChars(text: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(text);
}

/**
 * Validate a raw request body into canonical {@link ContributionInput} fields.
 * Deliberately narrow: Courier owns contribution policy, so this checks only
 * Dispatch-side shape and bounds (types, lengths, repo-name form).
 */
export function parseContributionInput(body: Record<string, unknown>): ValidationOk | ValidationErr {
  const namespace = body.namespace;
  const lane = body.lane;
  const baseRepo = body.baseRepo;
  const baseRef = body.baseRef;
  const workRepo = body.workRepo;
  const goal = body.goal;
  const upstreamIssue = body.upstreamIssue;
  const idempotencyKey = body.idempotencyKey;

  if (!isString(namespace) || !namespace.trim()) return { ok: false, error: "namespace is required" };
  if (namespace.trim().length > 128) return { ok: false, error: "namespace is too long (max 128 characters)" };
  if (!isString(lane) || !lane.trim()) return { ok: false, error: "lane is required" };
  if (lane.trim().length > 64) return { ok: false, error: "lane is too long (max 64 characters)" };
  if (hasControlChars(lane.trim())) return { ok: false, error: "lane must not contain control characters" };
  if (!isString(baseRepo) || !isValidRepoName(baseRepo.trim())) {
    return { ok: false, error: "baseRepo must be owner/repo" };
  }
  if (!isString(workRepo) || !isValidRepoName(workRepo.trim())) {
    return { ok: false, error: "workRepo must be owner/repo" };
  }
  if (!isString(baseRef) || !baseRef.trim()) return { ok: false, error: "baseRef is required" };
  if (baseRef.trim().length > 256) return { ok: false, error: "baseRef is too long (max 256 characters)" };
  if (hasControlChars(baseRef.trim())) return { ok: false, error: "baseRef must not contain control characters" };
  if (!isString(goal) || !goal.trim()) return { ok: false, error: "goal is required" };
  if (goal.length > 10_000) return { ok: false, error: "goal is too long (max 10000 characters)" };

  let normalizedUpstream: string | null = null;
  if (upstreamIssue !== undefined && upstreamIssue !== null) {
    if (!isString(upstreamIssue)) return { ok: false, error: "upstreamIssue must be a string" };
    const trimmed = upstreamIssue.trim();
    if (trimmed) {
      if (trimmed.length > 512) return { ok: false, error: "upstreamIssue is too long (max 512 characters)" };
      if (hasControlChars(trimmed)) return { ok: false, error: "upstreamIssue must not contain control characters" };
      normalizedUpstream = trimmed;
    }
  }
  // upstreamIssue is stored verbatim and passed to Courier; Dispatch never
  // dereferences it, so a supplied upstream issue URL can never turn into an
  // upstream mutation.

  let normalizedKey: string | null = null;
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (!isString(idempotencyKey)) return { ok: false, error: "idempotencyKey must be a string" };
    const trimmed = idempotencyKey.trim();
    if (trimmed) {
      if (trimmed.length > 256) return { ok: false, error: "idempotencyKey is too long (max 256 characters)" };
      if (hasControlChars(trimmed)) return { ok: false, error: "idempotencyKey must not contain control characters" };
      normalizedKey = trimmed;
    }
  }

  return {
    ok: true,
    input: {
      namespace: namespace.trim(),
      lane: lane.trim(),
      baseRepo: baseRepo.trim(),
      baseRef: baseRef.trim(),
      workRepo: workRepo.trim(),
      goal: goal.trim(),
      upstreamIssue: normalizedUpstream,
      idempotencyKey: normalizedKey,
    },
  };
}

/** Canonical wire fields for a persisted row (fixed key order for a stable digest). */
export function canonicalAdmissionFields(row: {
  namespace: string;
  lane: string;
  baseRepo: string;
  baseRef: string;
  workRepo: string;
  goal: string;
  upstreamIssue: string | null;
  idempotencyKey: string;
}): AdmissionRequestFields {
  return {
    namespace: row.namespace,
    lane: row.lane,
    baseRepo: row.baseRepo,
    baseRef: row.baseRef,
    workRepo: row.workRepo,
    goal: row.goal,
    upstreamIssue: row.upstreamIssue,
    idempotencyKey: row.idempotencyKey,
  };
}

/** sha256 over the canonical request fields — the changed-payload guard. */
export function computePayloadDigest(fields: AdmissionRequestFields): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** The persisted ledger row shape this module reads and writes. */
export type ExternalContributionRow = Prisma.ExternalContributionRequestGetPayload<null>;

/** The subset of the Prisma client this state machine uses (mockable in tests). */
export interface ExternalContributionClient {
  externalContributionRequest: PrismaClient["externalContributionRequest"];
}

export interface SubmissionActor {
  /** Authenticated Dispatch actor (authorizeRequest), recorded on the row. */
  actor: string;
}

export type SubmissionOutcome =
  | { outcome: "created"; request: ExternalContributionRow }
  | { outcome: "resumed"; request: ExternalContributionRow }
  /** Same key + same payload, already accepted — no new identity, no re-admission. */
  | { outcome: "replay_accepted"; request: ExternalContributionRow }
  /** Same key + same payload, already explicitly rejected by Courier. */
  | { outcome: "replay_rejected"; request: ExternalContributionRow }
  /** Same key, delivery not settled, another caller holds the attempt slot. */
  | { outcome: "in_flight"; request: ExternalContributionRow }
  /** Same key, different payload — the changed-payload guard. */
  | { outcome: "payload_conflict"; request: ExternalContributionRow }
  /** Uncertain delivery exhausted the bounded retries. */
  | { outcome: "retry_exhausted"; request: ExternalContributionRow }
  | { outcome: "uncertain"; request: ExternalContributionRow; timeout: boolean }
  | { outcome: "rejected"; request: ExternalContributionRow; httpStatus: number };

/**
 * Classify an already-persisted row against the incoming request, BEFORE any
 * network call. Pure so both the fresh-row and lost-create-race paths share it.
 */
function classifyExisting(row: ExternalContributionRow, digest: string): SubmissionOutcome | null {
  if (row.payloadDigest !== digest) return { outcome: "payload_conflict", request: row };
  if (row.deliveryStatus === "accepted") return { outcome: "replay_accepted", request: row };
  if (row.deliveryStatus === "rejected") return { outcome: "replay_rejected", request: row };
  if (row.attemptCount >= MAX_DELIVERY_ATTEMPTS) return { outcome: "retry_exhausted", request: row };
  return null;
}

/**
 * Persist (if new) and submit one external contribution request.
 *
 * Ordering guarantee: for a new request the row is created before the first
 * network call; the Courier call is always built from the persisted row
 * fields, never from the caller's body, so a restart replays the same
 * identity and payload.
 */
export async function submitExternalContribution(
  client: ExternalContributionClient,
  input: ContributionInput,
  actor: SubmissionActor,
  config: Extract<CourierAdmissionConfig, { ok: true }>,
): Promise<SubmissionOutcome> {
  const idempotencyKey = input.idempotencyKey ?? newIdempotencyKey();
  const fields = canonicalAdmissionFields({ ...input, idempotencyKey });
  const digest = computePayloadDigest(fields);

  let row = await client.externalContributionRequest.findUnique({ where: { idempotencyKey } });
  if (!row) {
    try {
      // Persist BEFORE the first network call (callers assert this ordering).
      row = await client.externalContributionRequest.create({
        data: {
          idempotencyKey,
          createdBy: actor.actor,
          namespace: fields.namespace,
          lane: fields.lane,
          baseRepo: fields.baseRepo,
          baseRef: fields.baseRef,
          workRepo: fields.workRepo,
          goal: fields.goal,
          upstreamIssue: fields.upstreamIssue,
          payloadDigest: digest,
          deliveryStatus: "pending",
          attemptCount: 0,
        },
      });
    } catch (error) {
      // A concurrent request created the same identity first (repeated click,
      // double submit). Re-read and fall through to the replay classification —
      // one key still yields one row and one identity.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        row = await client.externalContributionRequest.findUnique({ where: { idempotencyKey } });
        if (!row) throw error;
      } else {
        throw error;
      }
    }
  }

  const settled = classifyExisting(row, digest);
  if (settled) return settled;

  // Attempt fence: exactly one concurrent caller burns the next attempt slot
  // (optimistic lock on attemptCount, restricted to not-yet-settled rows so a
  // row accepted between our read and the fence is never re-admitted).
  const fence = await client.externalContributionRequest.updateMany({
    where: { idempotencyKey, attemptCount: row.attemptCount, deliveryStatus: { in: ["pending", "uncertain"] } },
    data: { attemptCount: row.attemptCount + 1, lastAttemptAt: new Date() },
  });
  if (fence.count === 0) {
    // Lost the slot: someone else is submitting (or just settled) this
    // identity. Re-read and report the freshest state without a network call.
    const fresh = await client.externalContributionRequest.findUnique({ where: { idempotencyKey } });
    if (!fresh) throw new Error("external contribution request disappeared mid-submission");
    if (fresh.payloadDigest !== digest) return { outcome: "payload_conflict", request: fresh };
    if (fresh.deliveryStatus === "accepted") return { outcome: "replay_accepted", request: fresh };
    if (fresh.deliveryStatus === "rejected") return { outcome: "replay_rejected", request: fresh };
    return { outcome: "in_flight", request: fresh };
  }

  const result = await submitAdmission(canonicalAdmissionFields(row), config);

  if (result.outcome === "created" || result.outcome === "resumed") {
    const updated = await client.externalContributionRequest.update({
      where: { id: row.id },
      data: {
        deliveryStatus: "accepted",
        courierRun: result.run,
        courierNamespace: result.namespace,
        courierWorkItemId: result.workItemId,
        resumed: result.resumed,
        courierHttpStatus: result.resumed ? 200 : 201,
        lastError: null,
      },
    });
    return { outcome: result.outcome, request: updated };
  }

  if (result.outcome === "rejected") {
    const updated = await client.externalContributionRequest.update({
      where: { id: row.id },
      data: {
        deliveryStatus: "rejected",
        courierHttpStatus: result.httpStatus,
        lastError: redactSecret(result.diagnostic, config.token),
      },
    });
    return { outcome: "rejected", request: updated, httpStatus: result.httpStatus };
  }

  const updated = await client.externalContributionRequest.update({
    where: { id: row.id },
    data: {
      deliveryStatus: "uncertain",
      ...(result.httpStatus !== undefined ? { courierHttpStatus: result.httpStatus } : {}),
      lastError: redactSecret(result.diagnostic, config.token),
    },
  });
  return { outcome: "uncertain", request: updated, timeout: result.timeout };
}
