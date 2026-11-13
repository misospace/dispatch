// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IN_FLIGHT_LEASE_MARGIN_MS,
  MAX_DELIVERY_ATTEMPTS,
  canonicalAdmissionFields,
  computePayloadDigest,
  inFlightLeaseMs,
  submitExternalContribution,
  type ContributionInput,
  type ExternalContributionClient,
} from "./external-contribution";
import { createContributionLedger } from "@/test/external-contribution-ledger";

// #1556 review: the in-flight claim/lease concurrency core of the external
// contribution state machine. Production code runs UNMOCKED — only global
// fetch is stubbed and the Prisma delegate is the faithful in-memory ledger
// from `@/test/external-contribution-ledger`, which evaluates the same
// conditional `updateMany` predicates Postgres would.

const COURIER_TOKEN = "courier-secret-token";
const CONFIG = {
  ok: true as const,
  endpoint: new URL("https://courier.internal/v1/contributions"),
  token: COURIER_TOKEN,
  namespaces: ["team-alpha"],
  timeoutMs: 2_000,
};

const ACTOR = { actor: "operator" };

const BASE_INPUT: ContributionInput = {
  namespace: "team-alpha",
  lane: "contribution",
  baseRepo: "acme/widgets",
  baseRef: "main",
  workRepo: "acme/widgets-fork",
  goal: "Add a widget",
  upstreamIssue: "https://github.com/acme/widgets/issues/12",
  idempotencyKey: null,
};

const input = (overrides: Partial<ContributionInput> = {}): ContributionInput => ({ ...BASE_INPUT, ...overrides });

/** Digest of the canonical payload for a given key (what a created row stores). */
function digestFor(key: string): string {
  return computePayloadDigest(canonicalAdmissionFields({ ...BASE_INPUT, idempotencyKey: key }));
}

function courierCreated(run = "run-1", status = 201): Response {
  return {
    ok: true,
    status,
    text: () => Promise.resolve(JSON.stringify({ run, namespace: "team-alpha", workItemId: "wi-1", resumed: false })),
  } as unknown as Response;
}

function courierRejected(status = 400): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(JSON.stringify({ error: "lane unknown" })),
  } as unknown as Response;
}

/** A response promise the test resolves manually (a blocked in-flight fetch). */
function deferred(): { promise: Promise<Response>; resolve: (r: Response) => void } {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("external contribution in-flight claim", () => {
  let ledger: ReturnType<typeof createContributionLedger>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    ledger = createContributionLedger();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const submit = (overrides: Partial<ContributionInput> = {}) =>
    submitExternalContribution(
      { externalContributionRequest: ledger.delegate } as unknown as ExternalContributionClient,
      input(overrides),
      ACTOR,
      CONFIG,
    );

  it("leases an attempt for the admission timeout plus margin, from the same attempt-start stamp", async () => {
    const gate = deferred();
    fetchMock.mockImplementationOnce(() => gate.promise);
    const pending = submit({ idempotencyKey: "key-lease" });
    await vi.waitFor(() => expect(ledger.rows[0]?.deliveryStatus).toBe("in_flight"));
    const row = ledger.rows[0];
    expect(row.attemptCount).toBe(1);
    expect(row.attemptToken).toBeTruthy();
    // Documented stale threshold: attempt start + configured timeout + margin.
    expect(inFlightLeaseMs(CONFIG.timeoutMs)).toBe(CONFIG.timeoutMs + IN_FLIGHT_LEASE_MARGIN_MS);
    expect(row.inFlightUntil!.getTime() - row.lastAttemptAt!.getTime()).toBe(inFlightLeaseMs(CONFIG.timeoutMs));
    expect(row.inFlightUntil!.getTime()).toBeGreaterThan(Date.now());
    gate.resolve(courierCreated());
    expect((await pending).outcome).toBe("created");
  });

  it("returns in_flight to an overlapping caller without a second Courier request (the #1556 blocker)", async () => {
    // Caller A holds the attempt, blocked inside fetch.
    const gate = deferred();
    fetchMock.mockImplementation(() => gate.promise);
    const first = submit({ idempotencyKey: "key-live" });
    await vi.waitFor(() => expect(ledger.rows[0]?.deliveryStatus).toBe("in_flight"));
    expect(ledger.rows[0].attemptCount).toBe(1);

    // Caller B submits the SAME key + SAME payload while A is still in flight.
    const second = await submit({ idempotencyKey: "key-live" });
    expect(second.outcome).toBe("in_flight");
    expect(second.request.id).toBe(ledger.rows[0].id);
    expect(fetchMock).toHaveBeenCalledTimes(1); // exactly one live Courier request
    expect(ledger.rows[0].attemptCount).toBe(1); // B burned no attempt slot
    expect(ledger.rows[0].idempotencyKey).toBe("key-live");
    expect(second.request.payloadDigest).toBe(ledger.rows[0].payloadDigest);

    // A's response settles normally once released.
    gate.resolve(courierCreated("run-a"));
    const firstResult = await first;
    expect(firstResult.outcome).toBe("created");
    expect(ledger.rows[0].deliveryStatus).toBe("accepted");
    expect(ledger.rows[0].courierRun).toBe("run-a");
    expect(ledger.rows[0].attemptCount).toBe(1);
  });

  it("admits exactly one of two simultaneous submissions to Courier", async () => {
    const gate = deferred();
    fetchMock.mockImplementation(() => gate.promise);
    // No waiting: both callers race from the same absent row.
    const first = submit({ idempotencyKey: "key-both" });
    const second = submit({ idempotencyKey: "key-both" });
    await vi.waitFor(() => expect(ledger.rows[0]?.deliveryStatus).toBe("in_flight"));
    gate.resolve(courierCreated("run-winner"));
    const [ra, rb] = await Promise.all([first, second]);

    const outcomes = [ra.outcome, rb.outcome].sort();
    expect(outcomes).toEqual(["created", "in_flight"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].attemptCount).toBe(1);
    expect(ledger.rows[0].deliveryStatus).toBe("accepted");
  });

  it("recovers a stale in-flight attempt: same key, one new request, exactly one extra attempt", async () => {
    const crashed = ledger.plantRow({
      idempotencyKey: "key-stale",
      payloadDigest: digestFor("key-stale"),
      deliveryStatus: "in_flight",
      attemptCount: 1,
      attemptToken: "crashed-attempt",
      lastAttemptAt: minutesAgo(10),
      inFlightUntil: minutesAgo(9), // lease expired: Dispatch died mid-attempt
    });

    fetchMock.mockResolvedValueOnce(courierCreated("run-recovered"));
    const result = await submit({ idempotencyKey: "key-stale" });

    expect(result.outcome).toBe("created");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent.idempotencyKey).toBe("key-stale"); // the SAME key is reused
    expect(ledger.rows).toHaveLength(1); // never a second ledger row
    expect(ledger.rows[0].id).toBe(crashed.id);
    expect(ledger.rows[0].attemptCount).toBe(2); // the recovery consumed exactly one bounded attempt
    expect(ledger.rows[0].attemptToken).not.toBe("crashed-attempt");
    expect(ledger.rows[0].deliveryStatus).toBe("accepted");
    expect(ledger.rows[0].courierRun).toBe("run-recovered");
  });

  it("does not steal a fresh in-flight attempt: no Courier call, no attempt increment", async () => {
    ledger.plantRow({
      idempotencyKey: "key-fresh",
      payloadDigest: digestFor("key-fresh"),
      deliveryStatus: "in_flight",
      attemptCount: 1,
      attemptToken: "active-attempt",
      lastAttemptAt: new Date(),
      inFlightUntil: new Date(Date.now() + 60_000), // lease live
    });

    const result = await submit({ idempotencyKey: "key-fresh" });

    expect(result.outcome).toBe("in_flight");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ledger.rows[0].attemptCount).toBe(1);
    expect(ledger.rows[0].attemptToken).toBe("active-attempt");
    expect(ledger.rows[0].deliveryStatus).toBe("in_flight");
  });

  it("a stale attempt's delayed success cannot overwrite a newer attempt's result", async () => {
    // Attempt A claims, then Dispatch "dies" before its response arrives.
    const gate = deferred();
    fetchMock.mockImplementationOnce(() => gate.promise);
    const staleAttempt = submit({ idempotencyKey: "key-late" });
    await vi.waitFor(() => expect(ledger.rows[0]?.deliveryStatus).toBe("in_flight"));
    const tokenA = ledger.rows[0].attemptToken;

    // The lease expires; a newer attempt legitimately recovers and completes.
    ledger.rows[0].inFlightUntil = new Date(Date.now() - 1_000);
    fetchMock.mockResolvedValueOnce(courierCreated("run-new"));
    const recovered = await submit({ idempotencyKey: "key-late" });
    expect(recovered.outcome).toBe("created");
    expect(ledger.rows[0].courierRun).toBe("run-new");
    expect(ledger.rows[0].attemptCount).toBe(2);
    expect(ledger.rows[0].attemptToken).not.toBe(tokenA);

    // A's delayed response finally arrives — it must not overwrite B's state.
    gate.resolve(courierCreated("run-late"));
    const lateResult = await staleAttempt;
    expect(lateResult.outcome).toBe("replay_accepted");
    expect(ledger.rows[0].deliveryStatus).toBe("accepted");
    expect(ledger.rows[0].courierRun).toBe("run-new");
    expect(ledger.rows[0].attemptCount).toBe(2);
    expect(lateResult.request.id).toBe(ledger.rows[0].id);
  });

  it("a stale attempt's delayed rejection cannot flip a newer attempt's acceptance", async () => {
    const gate = deferred();
    fetchMock.mockImplementationOnce(() => gate.promise);
    const staleAttempt = submit({ idempotencyKey: "key-late-rej" });
    await vi.waitFor(() => expect(ledger.rows[0]?.deliveryStatus).toBe("in_flight"));

    ledger.rows[0].inFlightUntil = new Date(Date.now() - 1_000);
    fetchMock.mockResolvedValueOnce(courierCreated("run-new"));
    await submit({ idempotencyKey: "key-late-rej" });
    expect(ledger.rows[0].deliveryStatus).toBe("accepted");

    gate.resolve(courierRejected(422)); // the stale attempt was, in fact, refused
    const lateResult = await staleAttempt;
    expect(lateResult.outcome).toBe("replay_accepted");
    expect(ledger.rows[0].deliveryStatus).toBe("accepted"); // the newer result stands
  });

  it("clears the lease on an uncertain settlement so the next caller retries immediately", async () => {
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);
    const first = await submit({ idempotencyKey: "key-uncertain" });
    expect(first.outcome).toBe("uncertain");
    expect(ledger.rows[0].deliveryStatus).toBe("uncertain");
    expect(ledger.rows[0].inFlightUntil).toBeNull(); // no live claim remains
    expect(ledger.rows[0].attemptCount).toBe(1);

    // Retry with the SAME key claims immediately (uncertain is claimable
    // regardless of any lease leftover) and consumes attempt 2.
    fetchMock.mockResolvedValueOnce(courierCreated("run-retry"));
    const second = await submit({ idempotencyKey: "key-uncertain" });
    expect(second.outcome).toBe("created");
    expect(ledger.rows[0].attemptCount).toBe(2);
    expect(ledger.rows[0].deliveryStatus).toBe("accepted");
  });

  it("settles a rejected response body as uncertain so the same key retries without waiting for the lease", async () => {
    // #1627: fetch resolves after headers arrive; text() rejects mid-read.
    // The client must return uncertain (not throw), so the row settles with a
    // diagnostic and a cleared lease instead of staying in_flight until expiry.
    const bodyFailure = {
      ok: true,
      status: 201,
      text: () => Promise.reject(new DOMException("body timed out", "AbortError")),
    } as unknown as Response;
    fetchMock.mockResolvedValueOnce(bodyFailure);
    const first = await submit({ idempotencyKey: "key-body-fail" });
    expect(first.outcome).toBe("uncertain");
    if (first.outcome === "uncertain") expect(first.timeout).toBe(true);
    expect(ledger.rows[0].deliveryStatus).toBe("uncertain");
    expect(ledger.rows[0].inFlightUntil).toBeNull(); // no live claim remains
    expect(ledger.rows[0].attemptCount).toBe(1);
    expect(ledger.rows[0].lastError).toBeTruthy();
    expect(ledger.rows[0].lastError).not.toContain(COURIER_TOKEN);

    // The original key is reusable immediately (no lease wait) and carries the
    // SAME idempotency key out to Courier on attempt 2.
    fetchMock.mockResolvedValueOnce(courierCreated("run-body-retry"));
    const second = await submit({ idempotencyKey: "key-body-fail" });
    expect(second.outcome).toBe("created");
    expect(ledger.rows[0].attemptCount).toBe(2);
    expect(ledger.rows[0].deliveryStatus).toBe("accepted");
    const sent = JSON.parse((fetchMock.mock.calls[1] as [URL, RequestInit])[1].body as string);
    expect(sent.idempotencyKey).toBe(second.request.idempotencyKey);
  });

  it("never recovers past the bounded attempt budget, even from a stale lease", async () => {
    ledger.plantRow({
      idempotencyKey: "key-maxed",
      payloadDigest: digestFor("key-maxed"),
      deliveryStatus: "in_flight",
      attemptCount: MAX_DELIVERY_ATTEMPTS,
      attemptToken: "last-attempt",
      lastAttemptAt: minutesAgo(30),
      inFlightUntil: minutesAgo(29), // long stale
    });

    const result = await submit({ idempotencyKey: "key-maxed" });
    expect(result.outcome).toBe("retry_exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ledger.rows[0].attemptCount).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(ledger.rows[0].attemptToken).toBe("last-attempt"); // ownership untouched
  });

  it("still reports a changed payload as a conflict while an attempt is in flight", async () => {
    ledger.plantRow({
      idempotencyKey: "key-live",
      payloadDigest: digestFor("key-live"),
      deliveryStatus: "in_flight",
      attemptCount: 1,
      attemptToken: "active-attempt",
      lastAttemptAt: new Date(),
      inFlightUntil: new Date(Date.now() + 60_000),
    });

    const result = await submit({ idempotencyKey: "key-live", goal: "A DIFFERENT goal" });
    expect(result.outcome).toBe("payload_conflict");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ledger.rows[0].attemptCount).toBe(1);
  });
});
