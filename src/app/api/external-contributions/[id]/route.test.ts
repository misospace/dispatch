// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  TEST_AGENT_TOKEN as mockToken,
  makeDispatchEnvMockWithSafeEqual,
  authedRequest,
} from "@/test/route-helpers";
import type { ContributionLedgerRow } from "@/test/external-contribution-ledger";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMockWithSafeEqual(mockToken, { "test-worker-token": "worker" }, { "bound-token": "alpha" }),
);

vi.mock("@/lib/auth-next", () => ({
  auth: vi.fn(),
}));

// #1538: GET /api/external-contributions/[id] — the stored-evidence read.
// Pure ledger read: NO network, no submission, no upstream mutation.

const { harnessHolder } = vi.hoisted(() => ({ harnessHolder: { current: null as any } }));

vi.mock("@/lib/prisma", async () => {
  const { createContributionLedger } = await import("@/test/external-contribution-ledger");
  const ledger = createContributionLedger();
  harnessHolder.current = {
    prisma: {
      externalContributionRequest: ledger.delegate,
      auditLog: { create: vi.fn() },
    },
    rows: ledger.rows,
    plantRow(overrides: Partial<ContributionLedgerRow> = {}): ContributionLedgerRow {
      return ledger.plantRow(overrides);
    },
  };
  return { prisma: harnessHolder.current.prisma };
});

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

const harness = harnessHolder.current as NonNullable<typeof harnessHolder.current>;

function get(id: string, opts: { includeAuth?: boolean; token?: string } = {}) {
  const { includeAuth = true, token = mockToken } = opts;
  return GET(
    authedRequest(`http://localhost/api/external-contributions/${id}`, { includeAuth, token }) as any,
    { params: Promise.resolve({ id }) },
  );
}

describe("GET /api/external-contributions/[id]", () => {
  beforeEach(() => {
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    harness.rows.splice(0, harness.rows.length);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("the stored-evidence read must never touch the network");
      }),
    );
  });

  afterEach(() => {
    resetAuthCaches();
    resetRateLimits();
    vi.unstubAllGlobals();
  });

  it("returns 401 without credentials and 403 for a worker-tier token", async () => {
    const row = harness.plantRow();
    expect((await get(row.id, { includeAuth: false })).status).toBe(401);
    expect((await get(row.id, { token: "test-worker-token" })).status).toBe(403);
  });

  it("404s for an unknown request", async () => {
    expect((await get("missing")).status).toBe(404);
  });

  it("projects the stored lifecycle evidence offline (no network call)", async () => {
    const observedAt = new Date("2026-11-20T10:00:00.000Z");
    const row = harness.plantRow({
      deliveryStatus: "accepted",
      courierRun: "run-77",
      courierNamespace: "team-alpha",
      trackingState: "published",
      courierPhase: "AwaitingReview",
      courierPrUrl: "https://github.com/acme/widgets/pull/42",
      courierPrHeadSha: "ab12",
      courierObservedAt: observedAt,
      trackingCheckedAt: observedAt,
    });

    const res = await get(row.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: row.id, status: "accepted", run: "run-77" });
    expect(body.tracking).toMatchObject({
      state: "published",
      stale: false,
      phase: "AwaitingReview",
      publication: { pr: "https://github.com/acme/widgets/pull/42", headSha: "ab12" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
