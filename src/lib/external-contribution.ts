/**
 * Dispatch-owned external contribution requests (#1537, parent #1349).
 *
 * Persist-before-network state machine around `submitAdmission`:
 *
 *   1. Validate the request and canonicalize its fields.
 *   2. Persist the row (key + canonical fields + payload digest) BEFORE the
 *      first network call, so timeouts, restarts, and lost success responses
 *      all replay the SAME identity and payload.
 *   3. Atomically claim a bounded delivery attempt (see the concurrency
 *      invariant below), then submit to Courier and record exactly one of
 *      three outcomes: `accepted` (identity returned), `rejected` (explicit
 *      Courier refusal), `uncertain` (timeout / network / malformed response
 *      — delivery outcome unknown).
 *
 * Concurrency invariant (#1556 review): Dispatch never intentionally has two
 * live admission HTTP requests for the same `ExternalContributionRequest`,
 * across processes and Dispatch instances. `attemptCount` alone cannot express
 * "an attempt is active" — a caller reading the already-incremented count would
 * fence successfully and double-submit. The claim is therefore a durable
 * in-flight state, not a counter:
 *
 *   - The claim is ONE conditional `updateMany` (atomic at the database, so it
 *     holds across instances): claimable state (`pending` | `uncertain`, or
 *     `in_flight` whose `inFlightUntil` lease has expired) AND
 *     `attemptCount < MAX_DELIVERY_ATTEMPTS`. Winning it flips the row to
 *     `in_flight`, increments `attemptCount`, stamps `lastAttemptAt`, sets the
 *     lease `inFlightUntil = now + inFlightLeaseMs(config.timeoutMs)`, and
 *     writes a fresh random `attemptToken`.
 *   - A caller that loses the claim (someone else holds a live lease) returns
 *     the row as `in_flight` WITHOUT a network call: no attempt increment, no
 *     key or payload change.
 *   - The bounded attempt budget limits how many attempts may START; it never
 *     cancels an attempt that is already running (#1628). A LIVE attempt
 *     therefore outranks the budget: while the final attempt holds an
 *     unexpired lease the row is reported `in_flight` (the delivery may still
 *     succeed), never `retry_exhausted` (which would tell the caller to
 *     abandon the identity and create a new one).
 *   - The lease bounds a crashed attempt: if Dispatch dies after claiming but
 *     before settling, the lease expires `inFlightLeaseMs` after attempt start
 *     (configured admission timeout + `IN_FLIGHT_LEASE_MARGIN_MS`, so it
 *     outlives any response the configured timeout can produce plus margin for
 *     inter-instance clock skew) and the next caller recovers the row with the
 *     SAME idempotency key, consuming the next bounded attempt. No background
 *     worker or scheduler is involved.
 *   - Settlements are guarded by `attemptToken`: the result of an attempt only
 *     applies while its token still owns an `in_flight` row. A recovered
 *     newer attempt rewrites the token, so a delayed response from a stale
 *     attempt can never overwrite the newer attempt's result.
 *
 * Identity rules:
 *   - One idempotency key is one contribution identity (`idempotencyKey`
 *     unique). A repeat submission with the same key and an identical payload
 *     never creates another row and never re-admits an accepted request.
 *   - A changed payload under an existing key is a 409-class conflict.
 *   - Uncertain delivery retries with the ORIGINAL key (Courier dedupes by
 *     key), bounded by `MAX_DELIVERY_ATTEMPTS`. A deliberate new contribution
 *     is a separate row with its own key.
 *
 * Boundaries: this module never calls GitHub (a supplied upstreamIssue URL is
 * stored verbatim and passed to Courier — no claim/label/assign/comment/close),
 * never writes Kubernetes state, and never stores the Courier credential.
 */
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { isValidRepoName } from "./config";
import {
  newIdempotencyKey,
  redactSecret,
  submitAdmission,
  type AdmissionRequestFields,
  type CourierAdmissionConfig,
} from "./courier-admission";

/**
 * Distinct delivery states recorded on the ledger row. `pending` (persisted,
 * never attempted) and `in_flight` (one attempt actively being delivered under
 * a bounded lease) are live states; `accepted` / `rejected` / `uncertain` are
 * settled outcomes.
 */
export const EXTERNAL_CONTRIBUTION_STATUSES = ["pending", "in_flight", "accepted", "rejected", "uncertain"] as const;
export type ExternalContributionStatus = (typeof EXTERNAL_CONTRIBUTION_STATUSES)[number];

/**
 * Bound on Courier delivery retries for one request identity. Uncertain
 * outcomes (timeout / network / malformed / 5xx) may be re-attempted by a
 * later submission with the same key up to this many attempts total; an
 * explicit Courier rejection is terminal and is never retried.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Safety margin added to the configured Courier admission timeout to form the
 * in-flight lease (`inFlightUntil`). The lease must outlive any response the
 * configured timeout can produce — the margin covers the tail after the
 * timeout aborts client-side (response body drain, settlement write) and
 * modest clock skew between Dispatch instances, whose wall clocks judge lease
 * expiry. A premature steal is still safe: it consumes one bounded retry with
 * the SAME key, which Courier dedupes. Documented and pinned by the stale-
 * recovery tests in `external-contribution.test.ts`.
 */
export const IN_FLIGHT_LEASE_MARGIN_MS = 5_000;

/** Lease duration for one claimed attempt: admission timeout + margin. */
export function inFlightLeaseMs(admissionTimeoutMs: number): number {
  return admissionTimeoutMs + IN_FLIGHT_LEASE_MARGIN_MS;
}

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
 * True when the row holds a LIVE in-flight attempt — an attempt that is still
 * running under an unexpired lease.
 *
 * Rationale (#1628): the bounded attempt budget limits how many attempts may
 * START; it never cancels an attempt that is already running. A live attempt
 * therefore outranks the budget — the delivery may still succeed, so the row
 * is reported `in_flight` rather than `retry_exhausted` (which tells the
 * caller to abandon the identity and create a new one).
 */
function hasLiveInFlightAttempt(row: ExternalContributionRow, now: Date): boolean {
  return (
    row.deliveryStatus === "in_flight" &&
    row.inFlightUntil !== null &&
    row.inFlightUntil.getTime() > now.getTime()
  );
}

/**
 * Classify an already-persisted row against the incoming request, BEFORE any
 * network call. Pure so both the fresh-row and lost-create-race paths share it.
 *
 * Precedence:
 *   1. changed payload under an existing key -> `payload_conflict`;
 *   2. already accepted -> `replay_accepted`;
 *   3. already rejected -> `replay_rejected`;
 *   4. a LIVE in-flight attempt (unexpired lease) -> null: the running attempt
 *      outranks the attempt budget (#1628) and may still succeed, so the row is
 *      never reported `retry_exhausted` here. Null hands the decision to the
 *      atomic claim, which re-checks lease staleness atomically — which a
 *      read-then-classify cannot — and, when the budget is already spent,
 *      re-reads the row and reports the live attempt as `in_flight`;
 *   5. attempt budget spent -> `retry_exhausted` (a settled `uncertain` row at
 *      the limit, or an `in_flight` row whose lease has EXPIRED at the limit);
 *   6. otherwise null — the atomic claim decides attempt ownership.
 */
function classifyExisting(row: ExternalContributionRow, digest: string): SubmissionOutcome | null {
  if (row.payloadDigest !== digest) return { outcome: "payload_conflict", request: row };
  if (row.deliveryStatus === "accepted") return { outcome: "replay_accepted", request: row };
  if (row.deliveryStatus === "rejected") return { outcome: "replay_rejected", request: row };
  // Lease liveness is judged against a timestamp captured at classification
  // time (right after this row read), never against a stale earlier stamp.
  if (hasLiveInFlightAttempt(row, new Date())) return null;
  if (row.attemptCount >= MAX_DELIVERY_ATTEMPTS) return { outcome: "retry_exhausted", request: row };
  return null;
}

/**
 * Report a freshly re-read row's CURRENT truth after losing the atomic claim
 * or after this attempt's settlement was rejected as stale — always without a
 * network call, and always reflecting the winning caller's state.
 *
 * A LIVE in-flight attempt outranks the attempt budget here too (#1628): a
 * running final attempt is reported `in_flight` even when the budget is spent,
 * because the delivery may still succeed. `retry_exhausted` is reported only
 * when the row is exhausted AND holds no live attempt.
 */
function classifyCurrent(row: ExternalContributionRow, digest: string): SubmissionOutcome {
  const exhausted = row.attemptCount >= MAX_DELIVERY_ATTEMPTS;
  // Lease liveness is judged against a timestamp captured at classification
  // time (right after this row read), never against a stale earlier stamp.
  const live = hasLiveInFlightAttempt(row, new Date());
  if (row.payloadDigest !== digest) return { outcome: "payload_conflict", request: row };
  switch (row.deliveryStatus) {
    case "accepted":
      return { outcome: "replay_accepted", request: row };
    case "rejected":
      return { outcome: "replay_rejected", request: row };
    case "uncertain":
      // A settled row never holds a live lease — every settlement clears
      // `inFlightUntil` — so the live-attempt rule below cannot apply here.
      return exhausted
        ? { outcome: "retry_exhausted", request: row }
        : { outcome: "uncertain", request: row, timeout: false };
    default:
      // `pending` and `in_flight`: another caller holds the attempt (or just
      // claimed it). A live attempt is reported in-flight without touching
      // anything — even at the attempt limit, where the running delivery may
      // still succeed.
      if (live) return { outcome: "in_flight", request: row };
      return exhausted
        ? { outcome: "retry_exhausted", request: row }
        : { outcome: "in_flight", request: row };
  }
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

  // Atomic in-flight claim (#1556 review): ONE conditional update, atomic at
  // the database, so it holds across processes and Dispatch instances. A
  // caller may acquire an attempt only while the row is claimable (`pending`
  // / `uncertain`, or `in_flight` with an EXPIRED lease — a crashed attempt
  // being recovered) and the bounded attempt budget is not exhausted. The
  // winner flips the row to `in_flight`, consumes the next attempt slot, and
  // takes ownership via a fresh random `attemptToken`. A caller reading a live
  // `in_flight` row loses here and reports in-flight without a network call.
  const attemptToken = randomUUID();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + inFlightLeaseMs(config.timeoutMs));
  const claim = await client.externalContributionRequest.updateMany({
    where: {
      idempotencyKey,
      attemptCount: { lt: MAX_DELIVERY_ATTEMPTS },
      OR: [
        { deliveryStatus: { in: ["pending", "uncertain"] } },
        { deliveryStatus: "in_flight", inFlightUntil: { lt: now } },
      ],
    },
    data: {
      deliveryStatus: "in_flight",
      attemptCount: { increment: 1 },
      lastAttemptAt: now,
      inFlightUntil: leaseUntil,
      attemptToken,
    },
  });
  if (claim.count === 0) {
    // Lost the slot: a live lease holds the attempt (or the row just settled
    // / exhausted between our read and the claim). Re-read and report the
    // freshest state without a network call.
    const fresh = await client.externalContributionRequest.findUnique({ where: { idempotencyKey } });
    if (!fresh) throw new Error("external contribution request disappeared mid-submission");
    return classifyCurrent(fresh, digest);
  }

  const result = await submitAdmission(canonicalAdmissionFields(row), config);

  if (result.outcome === "created" || result.outcome === "resumed") {
    const applied = await settleAttempt(client, row.id, attemptToken, {
      deliveryStatus: "accepted",
      courierRun: result.run,
      courierNamespace: result.namespace,
      courierWorkItemId: result.workItemId,
      resumed: result.resumed,
      courierHttpStatus: result.resumed ? 200 : 201,
      lastError: null,
      inFlightUntil: null,
    });
    // Null = this attempt lost ownership while its response was in flight (a
    // recovered newer attempt re-wrote the token). Report the row's current
    // truth — the newer attempt's result stands; Courier dedupes this
    // attempt's delivery by the shared key.
    if (!applied) return lostOwnershipOutcome(client, row.idempotencyKey, digest);
    return { outcome: result.outcome, request: applied };
  }

  if (result.outcome === "rejected") {
    const applied = await settleAttempt(client, row.id, attemptToken, {
      deliveryStatus: "rejected",
      courierHttpStatus: result.httpStatus,
      lastError: redactSecret(result.diagnostic, config.token),
      inFlightUntil: null,
    });
    if (!applied) return lostOwnershipOutcome(client, row.idempotencyKey, digest);
    return { outcome: "rejected", request: applied, httpStatus: result.httpStatus };
  }

  const applied = await settleAttempt(client, row.id, attemptToken, {
    deliveryStatus: "uncertain",
    ...(result.httpStatus !== undefined ? { courierHttpStatus: result.httpStatus } : {}),
    lastError: redactSecret(result.diagnostic, config.token),
    inFlightUntil: null,
  });
  if (!applied) return lostOwnershipOutcome(client, row.idempotencyKey, digest);
  return { outcome: "uncertain", request: applied, timeout: result.timeout };
}

/**
 * Guarded settlement: apply one attempt's result ONLY while that attempt still
 * owns the row — still `in_flight` AND still holding the `attemptToken` its
 * claim wrote. A newer recovered attempt rewrites the token (and the stale
 * attempt's own recovery claim incremented past it), so a delayed response
 * from a stale attempt is a no-op here and can never overwrite the newer
 * attempt's result. Null means the guard did not match (ownership lost).
 */
async function settleAttempt(
  client: ExternalContributionClient,
  rowId: string,
  attemptToken: string,
  data: Prisma.ExternalContributionRequestUpdateManyMutationInput,
): Promise<ExternalContributionRow | null> {
  const applied = await client.externalContributionRequest.updateMany({
    where: { id: rowId, deliveryStatus: "in_flight", attemptToken },
    data,
  });
  if (applied.count === 0) return null;
  const fresh = await client.externalContributionRequest.findUnique({ where: { id: rowId } });
  if (!fresh) throw new Error("external contribution request disappeared mid-settlement");
  return fresh;
}

/** Re-read the row after this attempt's settlement was rejected as stale. */
async function lostOwnershipOutcome(
  client: ExternalContributionClient,
  idempotencyKey: string,
  digest: string,
): Promise<SubmissionOutcome> {
  const fresh = await client.externalContributionRequest.findUnique({ where: { idempotencyKey } });
  if (!fresh) throw new Error("external contribution request disappeared mid-settlement");
  return classifyCurrent(fresh, digest);
}
