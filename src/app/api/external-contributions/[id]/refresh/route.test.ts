// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  TEST_AGENT_TOKEN as mockToken,
  makeDispatchEnvMockWithSafeEqual,
  authedRequest,
} from "@/test/route-helpers";
import { TRACKING_REFRESH_COOLDOWN_MS } from "@/lib/external-contribution-tracking";
import type { ContributionLedgerRow } from "@/test/external-contribution-ledger";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMockWithSafeEqual(mockToken, { "test-worker-token": "worker" }, { "bound-token": "alpha" }),
);

vi.mock("@/lib/auth-next", () => ({
  auth: vi.fn(),
}));

// #1538: POST /api/external-contributions/[id]/refresh — bounded,
// duplicate-prevented, READ-ONLY lifecycle refresh. The tracking state
// machine and the Courier read client run UNMOCKED; only Prisma (the faithful
// in-memory ledger) and global fetch are stubbed.

const READ_TOKEN = "courier-read-token";
const SURFACE = "https://courier.internal/v1/contributions";

const { harnessHolder } = vi.hoisted(() => ({ harnessHolder: { current: null as any } }));

vi.mock("@/lib/prisma", async () => {
  const { createContributionLedger } = await import("@/test/external-contribution-ledger");
  const ledger = createContributionLedger();
  const audits: any[] = [];
  harnessHolder.current = {
    prisma: {
      externalContributionRequest: ledger.delegate,
      auditLog: { create: vi.fn(async (args: { data: any }) => audits.push(args.data)) },
    },
    rows: ledger.rows,
    audits,
    plantRow(overrides: Partial<ContributionLedgerRow> = {}): ContributionLedgerRow {
      return ledger.plantRow(overrides);
    },
  };
  return { prisma: harnessHolder.current.prisma };
});

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

const harness = harnessHolder.current as NonNullable<typeof harnessHolder.current>;

let fetchMock: ReturnType<typeof vi.fn>;

function statusResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
  } as unknown as Response;
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
    // Fresh "now" freshness: Courier's own observation instant of this read.
    observedAt: new Date().toISOString(),
    ...overrides,
  });
}

function acceptedRow(overrides: Partial<ContributionLedgerRow> = {}): ContributionLedgerRow {
  return harness.plantRow({
    idempotencyKey: `key-${harness.rows.length}`,
    deliveryStatus: "accepted",
    courierRun: "run-77",
    courierNamespace: "team-alpha",
    lane: "contribution",
    baseRepo: "acme/widgets",
    workRepo: "acme/widgets-fork",
    ...overrides,
  });
}

function refresh(id: string, opts: { includeAuth?: boolean; token?: string } = {}) {
  const { includeAuth = true, token = mockToken } = opts;
  return POST(
    authedRequest(`http://localhost/api/external-contributions/${id}/refresh`, {
      method: "POST",
      includeAuth,
      token,
    }) as any,
    { params: Promise.resolve({ id }) },
  );
}

describe("POST /api/external-contributions/[id]/refresh", () => {
  beforeEach(() => {
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    harness.rows.splice(0, harness.rows.length);
    harness.audits.splice(0, harness.audits.length);
    process.env.DISPATCH_COURIER_ADMISSION_URL = SURFACE;
    process.env.DISPATCH_COURIER_READ_TOKEN = READ_TOKEN;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    resetAuthCaches();
    resetRateLimits();
    delete process.env.DISPATCH_COURIER_ADMISSION_URL;
    delete process.env.DISPATCH_COURIER_READ_TOKEN;
    vi.unstubAllGlobals();
  });

  it("returns 401 without credentials and 403 for a worker-tier token", async () => {
    const row = acceptedRow();
    expect((await refresh(row.id, { includeAuth: false })).status).toBe(401);
    expect((await refresh(row.id, { token: "test-worker-token" })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s for an unknown request and 409s for one Courier never accepted — no network call", async () => {
    expect((await refresh("missing-id")).status).toBe(404);

    const pending = harness.plantRow({ idempotencyKey: "key-pending", deliveryStatus: "pending" });
    const res = await refresh(pending.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no Courier run identity/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 naming the missing capability when the read token is not configured — submission untouched, nothing recorded", async () => {
    delete process.env.DISPATCH_COURIER_READ_TOKEN;
    const row = acceptedRow();

    const res = await refresh(row.id);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/tracking is unavailable/i);
    expect(body.error).toMatch(/DISPATCH_COURIER_READ_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
    // No cooldown was burned and no state was written for a read that never ran.
    expect(harness.rows[0].trackingCheckedAt).toBeNull();
    expect(harness.rows[0].trackingState).toBeNull();
  });

  it("records a verified observation and projects it (200, refreshed=true)", async () => {
    const row = acceptedRow();
    fetchMock.mockResolvedValue(statusResponse(200, statusBody({ phase: "Verifying", ciParked: true })));

    const res = await refresh(row.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshed).toBe(true);
    expect(body.tracking).toMatchObject({ state: "executing", phase: "Verifying", ciParked: true, stale: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${SURFACE}/run-77?namespace=team-alpha`);
    expect(init.method).toBe("GET");
    // Successful observations are ledger evidence, not audit spam.
    expect(harness.audits).toHaveLength(0);
    // Credential never leaks into the response or the row.
    expect(JSON.stringify(body)).not.toContain(READ_TOKEN);
    expect(JSON.stringify(harness.rows)).not.toContain(READ_TOKEN);
  });

  it("duplicate-prevents inside the cooldown window: 200 refreshed=false, zero network calls", async () => {
    const row = acceptedRow({ trackingCheckedAt: new Date(Date.now() - 2_000) });
    const res = await refresh(row.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshed).toBe(false);
    expect(body.cooldownRemainingMs).toBeGreaterThan(0);
    expect(body.cooldownRemainingMs).toBeLessThanOrEqual(TRACKING_REFRESH_COOLDOWN_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 on an identity mismatch and records nothing but the diagnostic", async () => {
    const row = acceptedRow();
    fetchMock.mockResolvedValue(statusResponse(200, statusBody({ phase: "Done", workRepo: "evil/corpo" })));

    const res = await refresh(row.id);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/identity mismatch/);
    expect(body.error).not.toContain("evil/corpo");
    expect(body.error).not.toContain(READ_TOKEN);
    expect(harness.rows[0].trackingState).toBeNull();
    expect(harness.rows[0].courierPhase).toBeNull();
    expect(harness.audits).toHaveLength(1);
    expect(harness.audits[0].success).toBe(false);
    expect(harness.audits[0].action).toBe("external_contribution_track");
  });

  it("records a reaped/lost run as expired (200) — explicitly not completion", async () => {
    const row = acceptedRow({ trackingState: "executing", courierPhase: "Running" });
    fetchMock.mockResolvedValue(statusResponse(404, JSON.stringify({ error: "contribution run not found" })));

    const res = await refresh(row.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expired).toBe(true);
    expect(body.tracking.state).toBe("expired");
    expect(harness.rows[0].trackingError).toMatch(/not completion/);
  });

  it("keeps final evidence when a published run is later reaped", async () => {
    const row = acceptedRow({ trackingState: "published", courierPrUrl: "https://github.com/acme/widgets/pull/42" });
    fetchMock.mockResolvedValue(statusResponse(404, JSON.stringify({ error: "contribution run not found" })));

    const res = await refresh(row.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tracking.state).toBe("published");
    expect(body.tracking.publication.pr).toBe("https://github.com/acme/widgets/pull/42");
  });

  it("maps a Courier refusal to 503 and a timeout to 504, keeping stored evidence and auditing failures", async () => {
    const rowA = acceptedRow({ trackingState: "executing", courierPhase: "Running" });
    fetchMock.mockResolvedValue(statusResponse(403, JSON.stringify({ error: "namespace not owned" })));
    const refused = await refresh(rowA.id);
    expect(refused.status).toBe(503);
    expect(harness.rows[0].trackingState).toBe("executing"); // stored evidence intact
    expect(harness.rows[0].trackingError).toMatch(/HTTP 403/);

    const rowB = acceptedRow({ id: "row-timeout" });
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);
    const timedOut = await refresh(rowB.id);
    expect(timedOut.status).toBe(504);
    expect((await timedOut.json()).error).toMatch(/timed out/i);

    expect(harness.audits.map((a: { success: boolean }) => a.success)).toEqual([false, false]);
    expect(JSON.stringify(harness.audits)).not.toContain(READ_TOKEN);
  });

  it("refuses to read outside the configured surface: the URL comes only from operator config", async () => {
    const row = acceptedRow();
    fetchMock.mockResolvedValue(statusResponse(200, statusBody()));
    await refresh(row.id);
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.origin).toBe("https://courier.internal");
    expect(url.pathname).toBe("/v1/contributions/run-77");
  });

  it("rate-limits hammering the refresh surface (429) without any Courier call", async () => {
    // Fresh cooldown anchor: every call short-circuits on the stored row,
    // so the only thing that can answer 429 is the per-actor rate limit.
    const row = acceptedRow({ trackingCheckedAt: new Date() });
    let last: Awaited<ReturnType<typeof refresh>> | undefined;
    for (let i = 0; i < 31; i += 1) last = await refresh(row.id);
    expect(last!.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
