/**
 * Courier lifecycle tracking for stored external contribution requests
 * (#1538, parent #1349).
 *
 * Submission (#1537) proved admission; THIS module turns Courier's
 * authenticated status reads (`courier-tracking.ts`) into durable, honest
 * lifecycle evidence on the ledger row:
 *
 *   admitted → executing → published / completed / failed
 *                       ↘ unavailable / expired   (never a silent completion)
 *
 * Rules the state machine enforces:
 *
 * - Identity-bound observations. Every accepted response is checked field by
 *   field against the stored admission (`run`, `namespace`) and the canonical
 *   request (`lane`, `baseRepo`, `workRepo`) BEFORE anything is recorded. A
 *   mismatch is refused as an observation and only a redacted diagnostic is
 *   kept — an answer about someone else's run can never land on this row.
 *   (The shipped contract — Courier #836 — deliberately does NOT echo
 *   `workItemId`; the five fields above are the identity echo.)
 * - Publication requires authority. A PR is shown only when Courier's own
 *   projection recorded it (`publication.pr`). Dispatch never creates,
 *   merges, or re-derives a PR, and never shows one from a phase name.
 * - Unknown is not guessed. The projection value `unknown` and any
 *   unrecognized phase keep the last known state (the CRD enum can gain
 *   phases; treating them as a transition would invent one). The recorded
 *   endings this vocabulary has no entry for (`AwaitingReview` without PR
 *   evidence, `HandedOff`) follow the same rule; the verbatim `phase` field
 *   on the projection names the real ending.
 * - Retention is explicit loss. A 404 for a run Dispatch previously admitted
 *   means reaped-or-lost; it maps to `expired` unless final evidence (a PR,
 *   `Done`/`AlreadyDone`, or a recorded failure) is already persisted, in
 *   which case the final evidence is kept and the loss is only noted. It is
 *   NEVER completion.
 * - Bounded, duplicate-prevented refresh. One refresh attempt per row per
 *   cooldown window, claimed by ONE conditional `updateMany` (atomic at the
 *   database, so it holds across Dispatch instances): the claim flips
 *   `trackingCheckedAt` to now only while it is null or older than the
 *   cutoff. Right after the claim the row is RE-READ, so durability merges,
 *   the 404 keep-final check, and the "never observed" `unavailable` marking
 *   all see the current evidence, not a snapshot that predates a refresh that
 *   already settled. Losers answer with the stored evidence plus the
 *   remaining cooldown — no network call, no Courier pressure, and a refresh
 *   never re-submits the contribution.
 * - Credential hygiene. The READ token lives only in `courier-tracking.ts`;
 *   a stored diagnostic is either that module's already-redacted answer or a
 *   string redacted here via `redactSecret`, which also scrubs the surface URL.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { CourierTrackingConfig, TrackingReadResult } from "./courier-tracking";
import { fetchContributionStatus } from "./courier-tracking";
import { redactSecret } from "./courier-admission";
import type { ExternalContributionRow } from "./external-contribution";

/** Persisted lifecycle states derived from verified status observations. */
export const TRACKING_STATES = [
  "admitted",
  "executing",
  "published",
  "completed",
  "failed",
  "unavailable",
  "expired",
] as const;
export type TrackingState = (typeof TRACKING_STATES)[number];

/**
 * States that already carry final (or explicitly terminal-loss) evidence:
 * they never go stale, and a later 404 never overwrites them.
 */
export const FINAL_TRACKING_STATES: ReadonlyArray<TrackingState> = ["published", "completed", "failed", "expired"];

/**
 * Minimum spacing between Courier status reads for one row. Courier docs
 * (external-contributions.md, "Status reads") pace frontends at 15–30s while
 * phases move; the cooldown is the duplicate-prevention floor.
 */
export const TRACKING_REFRESH_COOLDOWN_MS = 15_000;

const DEFAULT_TRACKING_STALE_MS = 900_000; // 15 minutes
const MIN_TRACKING_STALE_MS = 30_000;
const MAX_TRACKING_STALE_MS = 86_400_000; // 24 hours

/** `DISPATCH_COURIER_TRACKING_STALE_MS`, clamped 30s–24h (default 15m). */
export function trackingStaleMs(): number {
  const raw = Number(process.env.DISPATCH_COURIER_TRACKING_STALE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TRACKING_STALE_MS;
  return Math.min(Math.max(raw, MIN_TRACKING_STALE_MS), MAX_TRACKING_STALE_MS);
}

/**
 * Derive the persisted lifecycle state from one VERIFIED observation.
 * `hasPrEvidence` only ever comes from Courier's own recorded
 * `publication.pr` — a phase name alone never produces "published".
 */
export function deriveTrackingState(
  phase: string,
  hasPrEvidence: boolean,
  previous: TrackingState | null,
): TrackingState {
  // Publication authority outranks the phase label: a run with a recorded PR
  // is published whether it is now Verifying, AwaitingReview, or Done.
  if (hasPrEvidence) return "published";
  switch (phase) {
    case "Pending":
      return "admitted";
    case "Claimed":
    case "Running":
    case "Verifying":
      return "executing";
    case "Done":
    case "AlreadyDone":
      return "completed";
    case "Failed":
    case "NeedsHuman":
    case "BlockedExternal":
      return "failed";
    case "AwaitingReview":
    case "HandedOff":
    case "unknown":
      // Recorded endings this vocabulary has no distinct entry for, listed
      // explicitly so the phase switch covers the full contract:
      // `AwaitingReview` WITH a recorded PR is already `published` (the
      // authority check above); without one Dispatch cannot assert
      // publication. `HandedOff` left automation to a human without
      // declaring success or failure. Both are state-preserving by design:
      // the projection's verbatim `phase` field is what names the real
      // ending. Same rule as any unrecognized phase below.
      return previous && previous !== "unavailable" ? previous : "admitted";
    default:
      // A phase newer than this build knows: keep the last known state.
      // `unavailable` was never evidence, only the absence of it, so a
      // trustworthy read replaces it; with no history at all, an existing
      // run is at least admitted.
      return previous && previous !== "unavailable" ? previous : "admitted";
  }
}

/** The subset of the Prisma client the tracking state machine uses. */
export interface TrackingClient {
  externalContributionRequest: PrismaClient["externalContributionRequest"];
}

export type TrackingRefreshOutcome =
  /** Inside the cooldown window: stored evidence, zero network calls. */
  | { outcome: "cooldown"; request: ExternalContributionRow; cooldownRemainingMs: number }
  /** A verified observation was recorded. */
  | { outcome: "observed"; request: ExternalContributionRow }
  /** 404 after admission: state moved to `expired`, or final evidence kept. */
  | { outcome: "expired"; request: ExternalContributionRow }
  /** Identity mismatch: the observation was refused; only a diagnostic was kept. */
  | { outcome: "mismatch"; request: ExternalContributionRow }
  /** Explicit Courier refusal of the read (401/403/405/other 4xx). */
  | { outcome: "refused"; request: ExternalContributionRow; httpStatus: number }
  /** 5xx / timeout / network / incompatible shape: stored evidence is intact. */
  | { outcome: "unavailable"; request: ExternalContributionRow; timeout: boolean; retryAfterMs?: number }
  /**
   * A newer refresh claimed the row while this read was in flight (a slow
   * Courier answer outlived the cooldown). This attempt's result is dropped —
   * exactly like the submission path's token-guarded settlement (#1556): a
   * stale response can never regress the recorded evidence.
   */
  | { outcome: "superseded"; request: ExternalContributionRow };

/** A row is trackable only once Courier returned a run identity. */
export function isTrackable(row: ExternalContributionRow): boolean {
  return row.deliveryStatus === "accepted" && !!row.courierRun;
}

/**
 * The stored-evidence projection served by every read surface (#1538: "a
 * later or offline read can still see the last trustworthy evidence"). It
 * performs NO network call and NEVER exposes a credential.
 */
export function projectTracking(row: ExternalContributionRow, now: Date = new Date()) {
  const state: TrackingState | null =
    (row.trackingState as TrackingState | null) ?? (row.deliveryStatus === "accepted" ? "admitted" : null);
  const hasPublication = !!(row.courierPrUrl || row.courierPrBranch || row.courierPrHeadRepo || row.courierPrHeadSha);
  const hasCause = !!(row.courierCauseCategory || row.courierCauseOutcome);

  // Freshness: the newest evidence timestamp we hold. Non-final states go
  // stale when nothing fresher has been observed inside the window; final
  // evidence does not decay.
  const evidenceTime =
    row.courierObservedAt ?? row.trackingCheckedAt ?? row.updatedAt ?? null;
  const stale =
    state !== null &&
    !FINAL_TRACKING_STATES.includes(state) &&
    evidenceTime !== null &&
    now.getTime() - evidenceTime.getTime() > trackingStaleMs();

  return {
    state,
    stale,
    phase: row.courierPhase,
    ciParked: row.courierCiParked,
    cause: hasCause ? { category: row.courierCauseCategory, outcome: row.courierCauseOutcome } : null,
    publication: hasPublication
      ? {
          pr: row.courierPrUrl,
          branch: row.courierPrBranch,
          headRepo: row.courierPrHeadRepo,
          headSha: row.courierPrHeadSha,
        }
      : null,
    observedAt: row.courierObservedAt,
    phaseEnteredAt: row.courierPhaseEnteredAt,
    finishedAt: row.courierFinishedAt,
    checkedAt: row.trackingCheckedAt,
    lastError: row.trackingError,
  };
}

/** Field-by-field identity check against the stored admission + request. */
function identityMismatch(row: ExternalContributionRow, result: Extract<TrackingReadResult, { outcome: "ok" }>): string | null {
  const expected: Array<[string, string | null, string]> = [
    ["run", row.courierRun, result.status.run],
    ["namespace", row.courierNamespace ?? row.namespace, result.status.namespace],
    ["lane", row.lane, result.status.lane],
    ["baseRepo", row.baseRepo, result.status.baseRepo],
    ["workRepo", row.workRepo, result.status.workRepo],
  ];
  const mismatched = expected
    .filter(([, want, got]) => (want ?? null) !== got)
    .map(([name]) => name);
  return mismatched.length ? mismatched.join(",") : null;
}

/**
 * Guarded settle: apply this attempt's write ONLY while the row still carries
 * the `trackingCheckedAt` timestamp its claim wrote. Every later claim must be
 * ≥ one cooldown apart (the claim predicate demands it), so claim timestamps
 * are unique ownership tokens: if a newer refresh claimed the row while this
 * read was in flight, the guard finds no match and this attempt's result is
 * dropped. A slow, stale response can therefore never regress the recorded
 * evidence (the same hazard the submission path fences with `attemptToken`).
 * Null = ownership lost.
 */
async function settle(
  client: TrackingClient,
  rowId: string,
  attemptStamp: Date,
  data: Prisma.ExternalContributionRequestUpdateManyMutationInput,
): Promise<ExternalContributionRow | null> {
  const applied = await client.externalContributionRequest.updateMany({
    where: { id: rowId, trackingCheckedAt: attemptStamp },
    data,
  });
  if (applied.count === 0) return null;
  return client.externalContributionRequest.findUnique({ where: { id: rowId } });
}

/** A newer claim owns the row: report its current truth, write nothing. */
async function supersededOutcome(client: TrackingClient, rowId: string): Promise<TrackingRefreshOutcome> {
  const fresh = await client.externalContributionRequest.findUnique({ where: { id: rowId } });
  if (!fresh) throw new Error("external contribution request disappeared during tracking");
  return { outcome: "superseded", request: fresh };
}

/**
 * One bounded refresh of one accepted request's lifecycle evidence.
 *
 * Ordering: the cooldown claim commits BEFORE the network call, so a crash
 * mid-read still consumed the window (a refresh is cheap to lose, a stampede
 * is not). The row is re-read once the claim is held, and that fresh row —
 * never the caller's possibly-older snapshot — is the baseline for the
 * identity check, the durability merges, and the 404 keep-final decision.
 * The claim timestamp is also the settlement ownership token: a read
 * whose answer arrives AFTER a newer claim took the slot (slow Courier, short
 * cooldown) is dropped as `superseded` instead of settling, so stale evidence
 * can never regress the recorded state. The contribution itself is never
 * re-submitted — this function only ever GETs.
 */
export async function refreshExternalContributionTracking(
  client: TrackingClient,
  row: ExternalContributionRow,
  config: Extract<CourierTrackingConfig, { ok: true }>,
  now: Date = new Date(),
): Promise<TrackingRefreshOutcome> {
  if (!isTrackable(row)) {
    throw new Error("refreshExternalContributionTracking requires an accepted request with a Courier run identity");
  }

  // Atomic cooldown claim: takes the slot only while `trackingCheckedAt` is
  // null or older than the cutoff. Conditional `updateMany` is atomic at the
  // database, so concurrent refreshes across processes/instances resolve to
  // exactly one network read.
  const cutoff = new Date(now.getTime() - TRACKING_REFRESH_COOLDOWN_MS);
  const claim = await client.externalContributionRequest.updateMany({
    where: {
      id: row.id,
      OR: [{ trackingCheckedAt: null }, { trackingCheckedAt: { lt: cutoff } }],
    },
    data: { trackingCheckedAt: now },
  });
  if (claim.count === 0) {
    const fresh = await client.externalContributionRequest.findUnique({ where: { id: row.id } });
    if (!fresh) throw new Error("external contribution request disappeared during tracking");
    const anchor = fresh.trackingCheckedAt ? fresh.trackingCheckedAt.getTime() : now.getTime();
    const remaining = Math.max(0, anchor + TRACKING_REFRESH_COOLDOWN_MS - now.getTime());
    return { outcome: "cooldown", request: fresh, cooldownRemainingMs: remaining };
  }

  // The claim makes this attempt the row's tracking writer: every settlement
  // (this one included) is fenced by its claim timestamp, so a claimant that
  // loses the token can never write behind us. Re-read the row as the
  // settlement baseline — the caller's snapshot may predate a refresh that
  // already claimed + settled (older than the cooldown), and merging or
  // keep-final checks against that stale snapshot could erase the evidence
  // the earlier refresh recorded.
  const current = await client.externalContributionRequest.findUnique({ where: { id: row.id } });
  if (!current) throw new Error("external contribution request disappeared during tracking");

  const result = await fetchContributionStatus(
    current.courierRun as string,
    current.courierNamespace ?? current.namespace,
    config,
  );

  if (result.outcome === "ok") {
    const mismatched = identityMismatch(current, result);
    if (mismatched) {
      // Refuse the whole observation: a response that does not describe THIS
      // admitted run is evidence of nothing. Keep only the bounded,
      // field-named (values-free) diagnostic.
      const applied = await settle(client, row.id, now, {
        trackingError: redactSecret(
          `courier status identity mismatch on ${mismatched}; the observation was refused and nothing was recorded`,
          config.token,
          config.credentialSurface,
        ),
      });
      if (!applied) return supersededOutcome(client, row.id);
      return { outcome: "mismatch", request: applied };
    }

    const status = result.status;
    const hasPr = !!status.publication?.pr;
    const trackingState = deriveTrackingState(
      status.phase,
      hasPr || !!current.courierPrUrl,
      (current.trackingState as TrackingState | null) ?? null,
    );
    const applied = await settle(client, row.id, now, {
      trackingState,
      courierPhase: status.phase,
      courierCiParked: status.ciParked,
      // The terminal cause is recorded once at a run's ending (Courier only
      // ever attaches it there); like the publication fields, a later
      // partial projection without a `cause` block must not erase it.
      courierCauseCategory: status.cause?.category ?? current.courierCauseCategory,
      courierCauseOutcome: status.cause?.outcome ?? current.courierCauseOutcome,
      // Publication evidence is durable on the Courier side; a later partial
      // projection must never erase earlier recorded pieces.
      courierPrUrl: status.publication?.pr ?? current.courierPrUrl,
      courierPrBranch: status.publication?.branch ?? current.courierPrBranch,
      courierPrHeadRepo: status.publication?.headRepo ?? current.courierPrHeadRepo,
      courierPrHeadSha: status.publication?.headSha ?? current.courierPrHeadSha,
      courierObservedAt: status.observedAt,
      courierPhaseEnteredAt: status.phaseEnteredAt ?? current.courierPhaseEnteredAt,
      courierFinishedAt: status.finishedAt ?? current.courierFinishedAt,
      trackingError: null,
    });
    if (!applied) return supersededOutcome(client, row.id);
    return { outcome: "observed", request: applied };
  }

  if (result.outcome === "notFound") {
    // 404 is ambiguous by design (missing | foreign | reaped). For a run we
    // admitted it means the evidence is gone from Courier. Final evidence
    // already persisted is KEPT (that is the point of persisting before the
    // retention window); anything else becomes the explicit `expired` state.
    const keepsFinal =
      current.trackingState !== null && FINAL_TRACKING_STATES.includes(current.trackingState as TrackingState);
    const applied = await settle(client, row.id, now, {
      ...(keepsFinal ? {} : { trackingState: "expired" as TrackingState }),
      trackingError: redactSecret(
        keepsFinal
          ? `courier no longer reports this run (reaped or lost); the recorded ${current.trackingState} evidence is kept — a 404 is never completion`
          : `${result.diagnostic}; recorded as expired, not completion — re-ingestion would require a new request identity`,
        config.token,
        config.credentialSurface,
      ),
    });
    if (!applied) return supersededOutcome(client, row.id);
    return { outcome: "expired", request: applied };
  }

  if (result.outcome === "refused") {
    const applied = await settle(client, row.id, now, {
      trackingError: redactSecret(result.diagnostic, config.token, config.credentialSurface),
      ...(current.trackingState === null ? { trackingState: "unavailable" as TrackingState } : {}),
    });
    if (!applied) return supersededOutcome(client, row.id);
    return { outcome: "refused", request: applied, httpStatus: result.httpStatus };
  }

  const applied = await settle(client, row.id, now, {
    trackingError: redactSecret(result.diagnostic, config.token, config.credentialSurface),
    ...(current.trackingState === null ? { trackingState: "unavailable" as TrackingState } : {}),
  });
  if (!applied) return supersededOutcome(client, row.id);
  return {
    outcome: "unavailable",
    request: applied,
    timeout: result.timeout,
    ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
  };
}
