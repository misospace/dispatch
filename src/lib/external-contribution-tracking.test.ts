// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveTrackingState,
  isTrackable,
  projectTracking,
  refreshExternalContributionTracking,
  TRACKING_REFRESH_COOLDOWN_MS,
  trackingStaleMs,
  type TrackingClient,
} from "./external-contribution-tracking";
import { createContributionLedger, type ContributionLedgerRow } from "@/test/external-contribution-ledger";
import type { ExternalContributionRow } from "./external-contribution";

// #1538: the observation state machine — identity-bound recording, publication
// authority, honest expired-vs-completed handling, bounded duplicate-prevented
// refresh, and the offline stored-evidence projection. Only global fetch is
// stubbed; the ledger double enforces the real conditional-update predicates.

const READ_TOKEN = "courier-read-token";
const config = {
  ok: true as const,
  statusBase: new URL("https://courier.internal/v1/contributions"),
  credentialSurface: new URL("https://courier.internal/v1/contributions"),
  token: READ_TOKEN,
  timeoutMs: 30_000,
};

function rowOf(partial: Partial<ContributionLedgerRow>): ExternalContributionRow {
  return partial as ExternalContributionRow;
}

function statusBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    run: "run-77",
    namespace: "team-alpha",
    lane: "contribution",
    baseRepo: "acme/widgets",
    workRepo: "acme/widgets-fork",
    phase: "Running",
    ciParked: false,
    observedAt: "2026-11-20T10:00:00.000Z",
    ...overrides,
  });
}

function statusResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("deriveTrackingState", () => {
  it("maps the CRD phases to the lifecycle vocabulary", () => {
    expect(deriveTrackingState("Pending", false, null)).toBe("admitted");
    for (const phase of ["Claimed", "Running", "Verifying"]) {
      expect(deriveTrackingState(phase, false, null)).toBe("executing");
    }
    for (const phase of ["Done", "AlreadyDone"]) {
      expect(deriveTrackingState(phase, false, null)).toBe("completed");
    }
    for (const phase of ["Failed", "NeedsHuman", "BlockedExternal"]) {
      expect(deriveTrackingState(phase, false, null)).toBe("failed");
    }
  });

  it("publication evidence outranks the phase label", () => {
    expect(deriveTrackingState("Verifying", true, "executing")).toBe("published");
    expect(deriveTrackingState("AwaitingReview", true, null)).toBe("published");
    expect(deriveTrackingState("Done", true, null)).toBe("published");
  });

  it("keeps the last known state for unknown/unrecognized phases", () => {
    expect(deriveTrackingState("unknown", false, "executing")).toBe("executing");
    expect(deriveTrackingState("SomeNewPhase", false, "published")).toBe("published");
    expect(deriveTrackingState("unknown", false, null)).toBe("admitted");
  });

  it("keeps the last known state for the recorded endings with no distinct vocabulary entry", () => {
    // `AwaitingReview` without PR evidence cannot be asserted published, and
    // `HandedOff` declares neither success nor failure: both are
    // state-preserving, and the verbatim `phase` field names the ending.
    expect(deriveTrackingState("AwaitingReview", false, "executing")).toBe("executing");
    expect(deriveTrackingState("HandedOff", false, "admitted")).toBe("admitted");
    expect(deriveTrackingState("HandedOff", false, null)).toBe("admitted");
    expect(deriveTrackingState("AwaitingReview", false, "unavailable")).toBe("admitted");
  });
});

describe("trackingStaleMs", () => {
  afterEach(() => delete process.env.DISPATCH_COURIER_TRACKING_STALE_MS);

  it("defaults to 15m and clamps 30s..24h", () => {
    delete process.env.DISPATCH_COURIER_TRACKING_STALE_MS;
    expect(trackingStaleMs()).toBe(900_000);
    process.env.DISPATCH_COURIER_TRACKING_STALE_MS = "1000";
    expect(trackingStaleMs()).toBe(30_000);
    process.env.DISPATCH_COURIER_TRACKING_STALE_MS = "999999999999";
    expect(trackingStaleMs()).toBe(86_400_000);
  });
});

describe("projectTracking (offline stored-evidence read)", () => {
  afterEach(() => delete process.env.DISPATCH_COURIER_TRACKING_STALE_MS);

  it("shows an accepted, never-observed request as admitted, with no publication", () => {
    const view = projectTracking(rowOf({ deliveryStatus: "accepted", courierRun: "run-1", updatedAt: new Date() }));
    expect(view.state).toBe("admitted");
    expect(view.publication).toBeNull();
    expect(view.stale).toBe(false);
  });

  it("shows nothing for a request Courier never accepted", () => {
    expect(projectTracking(rowOf({ deliveryStatus: "rejected", updatedAt: new Date() })).state).toBeNull();
  });

  it("surfaces publication only from recorded evidence, with cause and freshness", () => {
    const view = projectTracking(
      rowOf({
        deliveryStatus: "accepted",
        courierRun: "run-1",
        trackingState: "published",
        courierPhase: "AwaitingReview",
        courierPrUrl: "https://github.com/acme/widgets/pull/42",
        courierPrHeadSha: "ab12",
        courierObservedAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    expect(view.state).toBe("published");
    expect(view.stale).toBe(false);
    expect(view.publication).toMatchObject({ pr: "https://github.com/acme/widgets/pull/42", headSha: "ab12" });
  });

  it("marks aging non-final evidence stale, and never marks final evidence stale", () => {
    delete process.env.DISPATCH_COURIER_TRACKING_STALE_MS;
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const aging = projectTracking(rowOf({ deliveryStatus: "accepted", courierRun: "run-1", trackingState: "executing", courierObservedAt: old, updatedAt: old }));
    expect(aging.stale).toBe(true);
    const final = projectTracking(rowOf({ deliveryStatus: "accepted", courierRun: "run-1", trackingState: "completed", courierObservedAt: old, updatedAt: old }));
    expect(final.stale).toBe(false);
    const expiredView = projectTracking(rowOf({ deliveryStatus: "accepted", courierRun: "run-1", trackingState: "expired", courierObservedAt: old, updatedAt: old }));
    expect(expiredView.stale).toBe(false);
  });
});

describe("refreshExternalContributionTracking", () => {
  const ledger = createContributionLedger();
  const client = {
    externalContributionRequest: ledger.delegate,
  } as unknown as TrackingClient;

  function acceptedRow(overrides: Partial<ContributionLedgerRow> = {}): ContributionLedgerRow {
    return ledger.plantRow({
      idempotencyKey: `key-${ledger.rows.length}`,
      deliveryStatus: "accepted",
      courierRun: "run-77",
      courierNamespace: "team-alpha",
      lane: "contribution",
      baseRepo: "acme/widgets",
      workRepo: "acme/widgets-fork",
      ...overrides,
    });
  }

  beforeEach(() => {
    ledger.reset();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires a trackable (accepted + identity) row", async () => {
    const pending = ledger.plantRow({ deliveryStatus: "pending" });
    expect(isTrackable(pending as ExternalContributionRow)).toBe(false);
    await expect(refreshExternalContributionTracking(client, pending as ExternalContributionRow, config)).rejects.toThrow(/accepted/);
  });

  it("records a verified observation, stamps the check, and clears the error", async () => {
    const row = acceptedRow({ trackingError: "old failure" });
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(200, statusBody({ phase: "Verifying" })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshExternalContributionTracking(client, row as ExternalContributionRow, config);
    expect(result.outcome).toBe("observed");
    if (result.outcome === "observed") {
      expect(result.request.trackingState).toBe("executing");
      expect(result.request.courierPhase).toBe("Verifying");
      expect(result.request.courierObservedAt?.toISOString()).toBe("2026-11-20T10:00:00.000Z");
      expect(result.request.trackingCheckedAt).toBeInstanceOf(Date);
      expect(result.request.trackingError).toBeNull();
    }
    // READ-ONLY surface: one GET on the derived URL, never a POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://courier.internal/v1/contributions/run-77?namespace=team-alpha");
    expect(init.method).toBe("GET");
  });

  it("refuses the whole observation on an identity mismatch and records only a diagnostic", async () => {
    const row = acceptedRow();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(statusResponse(200, statusBody({ phase: "Done", baseRepo: "evil/corpo", ciParked: true }))),
    );

    const result = await refreshExternalContributionTracking(client, row as ExternalContributionRow, config);
    expect(result.outcome).toBe("mismatch");
    if (result.outcome === "mismatch") {
      // Nothing from the foreign response was recorded — no phase, no state.
      expect(result.request.trackingState).toBeNull();
      expect(result.request.courierPhase).toBeNull();
      expect(result.request.courierPrUrl).toBeNull();
      expect(result.request.trackingError).toMatch(/identity mismatch/);
      expect(result.request.trackingError).toContain("baseRepo");
      expect(result.request.trackingError).not.toContain("evil/corpo");
      expect(result.request.trackingError).not.toContain(READ_TOKEN);
    }
  });

  it("shows a PR only from Courier's own publication evidence, and keeps it durable", async () => {
    const row = acceptedRow();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        statusResponse(
          200,
          statusBody({ phase: "AwaitingReview", publication: { branch: "courier/x", headRepo: "bot/w", headSha: "ab12", pr: "https://github.com/acme/widgets/pull/42" } }),
        ),
      ),
    );
    const first = await refreshExternalContributionTracking(client, row as ExternalContributionRow, config);
    expect(first.outcome).toBe("observed");
    if (first.outcome === "observed") {
      expect(first.request.trackingState).toBe("published");
      expect(first.request.courierPrUrl).toBe("https://github.com/acme/widgets/pull/42");
    }

    // A later partial projection (no publication block) must not erase the
    // recorded PR, and published must not regress.
    ledger.rows[0].trackingCheckedAt = new Date(Date.now() - TRACKING_REFRESH_COOLDOWN_MS - 1);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(200, statusBody({ phase: "Done" }))));
    const second = await refreshExternalContributionTracking(client, ledger.rows[0] as ExternalContributionRow, config);
    expect(second.outcome).toBe("observed");
    if (second.outcome === "observed") {
      expect(second.request.trackingState).toBe("published");
      expect(second.request.courierPrUrl).toBe("https://github.com/acme/widgets/pull/42");
      expect(second.request.courierPhase).toBe("Done");
    }
  });

  it("keeps a recorded cause when a later observation carries none", async () => {
    const row = acceptedRow();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        statusResponse(200, statusBody({ phase: "Failed", cause: { category: "verifier-rejection", outcome: "changes" } })),
      ),
    );
    const first = await refreshExternalContributionTracking(client, row as ExternalContributionRow, config);
    expect(first.outcome).toBe("observed");
    if (first.outcome === "observed") {
      expect(first.request.trackingState).toBe("failed");
      expect(first.request.courierCauseCategory).toBe("verifier-rejection");
      expect(first.request.courierCauseOutcome).toBe("changes");
    }

    // A later projection without a `cause` block must not erase the recorded
    // terminal classification — same durability rule as publication.
    ledger.rows[0].trackingCheckedAt = new Date(Date.now() - TRACKING_REFRESH_COOLDOWN_MS - 1);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(200, statusBody({ phase: "Failed" }))));
    const second = await refreshExternalContributionTracking(client, ledger.rows[0] as ExternalContributionRow, config);
    expect(second.outcome).toBe("observed");
    if (second.outcome === "observed") {
      expect(second.request.courierCauseCategory).toBe("verifier-rejection");
      expect(second.request.courierCauseOutcome).toBe("changes");
    }
  });

  it("maps a 404 after admission to the explicit expired state — never completion", async () => {
    const row = acceptedRow({ trackingState: "executing", courierPhase: "Running" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(404, JSON.stringify({ error: "contribution run not found" }))));

    const result = await refreshExternalContributionTracking(client, row as ExternalContributionRow, config);
    expect(result.outcome).toBe("expired");
    if (result.outcome === "expired") {
      expect(result.request.trackingState).toBe("expired");
      expect(result.request.trackingError).toMatch(/expired, not completion/);
    }
  });

  it("keeps persisted final evidence when the run is later reaped", async () => {
    const row = acceptedRow({ trackingState: "published", courierPhase: "AwaitingReview", courierPrUrl: "https://github.com/acme/widgets/pull/42" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(404, JSON.stringify({ error: "contribution run not found" }))));

    const result = await refreshExternalContributionTracking(client, row as ExternalContributionRow, config);
    expect(result.outcome).toBe("expired");
    if (result.outcome === "expired") {
      // Final evidence survives; only the loss is noted.
      expect(result.request.trackingState).toBe("published");
      expect(result.request.courierPrUrl).toBe("https://github.com/acme/widgets/pull/42");
      expect(result.request.trackingError).toMatch(/reaped or lost/);
    }
  });

  it("settles against the row as claimed, not the caller's stale snapshot (404 keep-final)", async () => {
    // The caller read the row before a refresh that has since claimed +
    // settled a publication (>1 cooldown ago, so this claim legitimately
    // wins). The 404 keep-final check must see the settled `published`
    // evidence, not the snapshot's absence of it (review finding on #1685).
    const row = acceptedRow();
    const staleSnapshot = { ...row };
    ledger.rows[0].trackingState = "published";
    ledger.rows[0].courierPhase = "AwaitingReview";
    ledger.rows[0].courierPrUrl = "https://github.com/acme/widgets/pull/42";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(404, JSON.stringify({ error: "contribution run not found" }))));

    const result = await refreshExternalContributionTracking(client, staleSnapshot as ExternalContributionRow, config);
    expect(result.outcome).toBe("expired");
    if (result.outcome === "expired") {
      expect(result.request.trackingState).toBe("published");
      expect(ledger.rows[0].trackingState).toBe("published");
      expect(result.request.courierPrUrl).toBe("https://github.com/acme/widgets/pull/42");
      expect(result.request.trackingError).toMatch(/reaped or lost/);
    }
  });

  it("settles against the row as claimed, not the caller's stale snapshot (partial observation merge)", async () => {
    // Same hazard on the observation path: a partial projection with no
    // publication block must merge against the CURRENTLY recorded PR, never
    // the snapshot's null, which would erase the settled evidence.
    const row = acceptedRow();
    const staleSnapshot = { ...row };
    ledger.rows[0].trackingState = "published";
    ledger.rows[0].courierPrUrl = "https://github.com/acme/widgets/pull/42";
    ledger.rows[0].courierCauseCategory = "verifier-rejection";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(200, statusBody({ phase: "Done" }))));

    const result = await refreshExternalContributionTracking(client, staleSnapshot as ExternalContributionRow, config);
    expect(result.outcome).toBe("observed");
    if (result.outcome === "observed") {
      expect(result.request.trackingState).toBe("published");
      expect(result.request.courierPrUrl).toBe("https://github.com/acme/widgets/pull/42");
      expect(result.request.courierCauseCategory).toBe("verifier-rejection");
      expect(result.request.courierPhase).toBe("Done");
    }
  });

  it("blocks duplicate reads inside the cooldown window without touching the network", async () => {
    const row = acceptedRow();
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(200, statusBody()));
    vi.stubGlobal("fetch", fetchMock);

    const first = await refreshExternalContributionTracking(client, row as ExternalContributionRow, config);
    expect(first.outcome).toBe("observed");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Immediate second refresh: the atomic cooldown claim loses, no fetch.
    const second = await refreshExternalContributionTracking(client, ledger.rows[0] as ExternalContributionRow, config);
    expect(second.outcome).toBe("cooldown");
    if (second.outcome === "cooldown") {
      expect(second.cooldownRemainingMs).toBeGreaterThan(0);
      expect(second.cooldownRemainingMs).toBeLessThanOrEqual(TRACKING_REFRESH_COOLDOWN_MS);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records an unavailable read and says so, keeping any prior state", async () => {
    const row = acceptedRow({ trackingState: "executing", courierPhase: "Running" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(503, JSON.stringify({ error: "saturated" }), { "retry-after": "1" })));

    const result = await refreshExternalContributionTracking(client, row as ExternalContributionRow, config);
    expect(result).toMatchObject({ outcome: "unavailable", timeout: false, retryAfterMs: 1000 });
    if (result.outcome === "unavailable") {
      // Stored evidence intact; the failure is visible, not silent.
      expect(result.request.trackingState).toBe("executing");
      expect(result.request.courierPhase).toBe("Running");
      expect(result.request.trackingError).toMatch(/HTTP 503/);
      expect(result.request.trackingError).not.toContain(READ_TOKEN);
    }
  });

  it("marks a never-observed row unavailable when the read credential is refused", async () => {
    const row = acceptedRow();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(401, JSON.stringify({ error: "invalid bearer token" }))));

    const result = await refreshExternalContributionTracking(client, row as ExternalContributionRow, config);
    expect(result).toMatchObject({ outcome: "refused", httpStatus: 401 });
    if (result.outcome === "refused") {
      expect(result.request.trackingState).toBe("unavailable");
      expect(result.request.trackingError).toMatch(/HTTP 401/);
    }
  });

  it("discards a stale answer that lands after a newer refresh already settled", async () => {
    const row = acceptedRow();
    let resolveSlow: ((value: Response) => void) | undefined;
    const slow = new Promise<Response>((resolve) => {
      resolveSlow = resolve;
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(slow);
    vi.stubGlobal("fetch", fetchMock);

    // Slow read A claims at t0; its answer only arrives at the very end.
    const t0 = new Date("2026-11-20T12:00:00.000Z");
    const attemptA = refreshExternalContributionTracking(client, row as ExternalContributionRow, config, t0);

    // 16s later (past the cooldown — the claim predicate's own spacing, so
    // the two claim timestamps cannot collide) a newer refresh B claims and
    // settles quickly.
    const t1 = new Date(t0.getTime() + TRACKING_REFRESH_COOLDOWN_MS + 1_000);
    fetchMock.mockResolvedValueOnce(statusResponse(200, statusBody({ phase: "Running" })));
    const resultB = await refreshExternalContributionTracking(client, ledger.rows[0] as ExternalContributionRow, config, t1);
    expect(resultB.outcome).toBe("observed");

    // A's answer arrives LAST and must not regress the row: the settlement
    // guard (the claim timestamp) drops it as superseded.
    resolveSlow!(statusResponse(200, statusBody({ phase: "Done", observedAt: new Date(t1.getTime() + 60_000).toISOString() })));
    const resultA = await attemptA;
    expect(resultA.outcome).toBe("superseded");
    expect(ledger.rows[0].courierPhase).toBe("Running");
    expect(ledger.rows[0].trackingState).toBe("executing");
  });

  it("replaces the never-evidence `unavailable` state with the first trustworthy observation", async () => {
    const row = acceptedRow();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(401, JSON.stringify({ error: "invalid bearer token" }))));
    const refused = await refreshExternalContributionTracking(client, row as ExternalContributionRow, config);
    expect(refused.outcome).toBe("refused");
    expect(ledger.rows[0].trackingState).toBe("unavailable");

    // A later verified read whose phase the projection has not stamped yet
    // must recover the state, not inherit the failure label.
    ledger.rows[0].trackingCheckedAt = new Date(Date.now() - TRACKING_REFRESH_COOLDOWN_MS - 1);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(200, statusBody({ phase: "unknown" }))));
    const observed = await refreshExternalContributionTracking(client, ledger.rows[0] as ExternalContributionRow, config);
    expect(observed.outcome).toBe("observed");
    if (observed.outcome === "observed") {
      expect(observed.request.trackingState).toBe("admitted");
      expect(observed.request.courierPhase).toBe("unknown");
    }
  });

  it("never re-submits: every network call this state machine makes is a GET", async () => {
    const row = acceptedRow();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(503, "", { "retry-after": "1" }))
      .mockResolvedValueOnce(statusResponse(200, statusBody({ phase: "Done" })));
    vi.stubGlobal("fetch", fetchMock);

    await refreshExternalContributionTracking(client, row as ExternalContributionRow, config);
    ledger.rows[0].trackingCheckedAt = new Date(Date.now() - TRACKING_REFRESH_COOLDOWN_MS - 1);
    await refreshExternalContributionTracking(client, ledger.rows[0] as ExternalContributionRow, config);

    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).method).toBe("GET");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ledger.rows[0].trackingState).toBe("completed");
  });
});
