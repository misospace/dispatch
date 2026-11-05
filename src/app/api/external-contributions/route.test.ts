// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import {
  TEST_AGENT_TOKEN as mockToken,
  makeDispatchEnvMockWithSafeEqual,
  authedRequest,
} from "@/test/route-helpers";
import { MAX_DELIVERY_ATTEMPTS } from "@/lib/external-contribution";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMockWithSafeEqual(mockToken, { "test-worker-token": "worker" }, { "bound-token": "alpha" }),
);

vi.mock("@/lib/auth-next", () => ({
  auth: vi.fn(),
}));

// #1537: POST /api/external-contributions — persist-before-network request
// ledger + exactly-once admission through Courier. The submission state
// machine and the Courier client run UNMOCKED; only the Prisma client (an
// in-memory ledger store) and global fetch are stubbed, so the route-level
// pins exercise the production behavior.

const COURIER_TOKEN = "courier-secret-token";
const ENDPOINT = "https://courier.internal/v1/contributions";

interface LedgerRow {
  id: string;
  idempotencyKey: string;
  createdBy: string;
  namespace: string;
  lane: string;
  baseRepo: string;
  baseRef: string;
  workRepo: string;
  goal: string;
  upstreamIssue: string | null;
  payloadDigest: string;
  deliveryStatus: string;
  courierRun: string | null;
  courierNamespace: string | null;
  courierWorkItemId: string | null;
  resumed: boolean | null;
  courierHttpStatus: number | null;
  lastError: string | null;
  attemptCount: number;
  lastAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// A deterministic digest for the canonical baseline payload below, so tests
// can plant rows without recomputing the hash. The baseline body every test
// posts is exactly these canonical (trimmed) fields.
const BASE_BODY = {
  namespace: "team-alpha",
  lane: "contribution",
  baseRepo: "acme/widgets",
  baseRef: "main",
  workRepo: "acme/widgets-fork",
  goal: "Add a widget",
  upstreamIssue: "https://github.com/acme/widgets/issues/12",
};

const { harnessHolder } = vi.hoisted(() => ({ harnessHolder: { current: null as any } }));

vi.mock("@/lib/prisma", () => {
  const rows: LedgerRow[] = [];
  const audits: any[] = [];
  const calls: string[] = [];
  const issueSpies = {
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
  };
  let rowSeq = 0;
  let failNextCreateWithConflict = false;
  let findUniqueCall = 0;

  const delegate = {
    async findUnique({ where }: { where: { idempotencyKey: string } }) {
      findUniqueCall += 1;
      if (failNextCreateWithConflict && findUniqueCall === 1) return null; // simulate losing a concurrent create
      return rows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
    },
    async create({ data }: { data: Record<string, unknown> }) {
      calls.push("create");
      if (failNextCreateWithConflict) {
        failNextCreateWithConflict = false;
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        });
      }
      const now = new Date();
      const row = {
        id: `row-${++rowSeq}`,
        courierRun: null,
        courierNamespace: null,
        courierWorkItemId: null,
        resumed: null,
        courierHttpStatus: null,
        lastError: null,
        lastAttemptAt: null,
        upstreamIssue: null,
        ...data,
        createdAt: now,
        updatedAt: now,
      } as LedgerRow;
      rows.push(row);
      return row;
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error("row not found");
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    async updateMany({ where, data }: { where: any; data: Record<string, unknown> }) {
      let count = 0;
      for (const row of rows) {
        if (row.idempotencyKey !== where.idempotencyKey) continue;
        if (row.attemptCount !== where.attemptCount) continue;
        if (!where.deliveryStatus.in.includes(row.deliveryStatus)) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    },
  };

  harnessHolder.current = {
    prisma: {
      externalContributionRequest: delegate,
      auditLog: {
        create: vi.fn(async (args: { data: any }) => {
          audits.push(args.data);
        }),
      },
      // Any access pattern that would mutate a tracked upstream issue must
      // stay impossible from this route — these spies stay call-free.
      issue: issueSpies,
    },
    rows,
    audits,
    calls,
    issueSpies,
    setLoseNextCreateRace(lose: boolean) {
      failNextCreateWithConflict = lose;
      findUniqueCall = 0;
    },
    plantRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
      const now = new Date();
      const row = {
        id: `row-${++rowSeq}`,
        idempotencyKey: "planted-key",
        createdBy: "operator",
        namespace: "team-alpha",
        lane: "contribution",
        baseRepo: "acme/widgets",
        baseRef: "main",
        workRepo: "acme/widgets-fork",
        goal: "Add a widget",
        upstreamIssue: "https://github.com/acme/widgets/issues/12",
        payloadDigest: "",
        deliveryStatus: "pending",
        courierRun: null,
        courierNamespace: null,
        courierWorkItemId: null,
        resumed: null,
        courierHttpStatus: null,
        lastError: null,
        attemptCount: 0,
        lastAttemptAt: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      } as LedgerRow;
      rows.push(row);
      return row;
    },
  };
  return { prisma: harnessHolder.current.prisma };
});

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";
import { canonicalAdmissionFields, computePayloadDigest } from "@/lib/external-contribution";

const harness = harnessHolder.current as NonNullable<typeof harnessHolder.current>;

let fetchMock: ReturnType<typeof vi.fn>;

function digestOfBody(body: Record<string, unknown>): string {
  return computePayloadDigest(
    canonicalAdmissionFields({
      namespace: String(body.namespace),
      lane: String(body.lane),
      baseRepo: String(body.baseRepo),
      baseRef: String(body.baseRef),
      workRepo: String(body.workRepo),
      goal: String(body.goal),
      upstreamIssue: typeof body.upstreamIssue === "string" && body.upstreamIssue.trim() ? body.upstreamIssue.trim() : null,
      idempotencyKey: typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : "generated",
    }),
  );
}

function courierBody(status: number, payload: unknown, body?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body ?? JSON.stringify(payload)),
  } as unknown as Response;
}

function post(body: unknown, opts: { includeAuth?: boolean; token?: string } = {}) {
  const { includeAuth = true, token = mockToken } = opts;
  return POST(
    authedRequest("http://localhost/api/external-contributions", {
      method: "POST",
      body,
      includeAuth,
      token,
    }) as any,
  );
}

describe("POST /api/external-contributions", () => {
  beforeEach(() => {
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    harness.rows.splice(0, harness.rows.length);
    harness.audits.splice(0, harness.audits.length);
    harness.calls.splice(0, harness.calls.length);
    harness.setLoseNextCreateRace(false);
    process.env.DISPATCH_COURIER_ADMISSION_URL = ENDPOINT;
    process.env.DISPATCH_COURIER_ADMISSION_TOKEN = COURIER_TOKEN;
    process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES = "team-alpha";
    delete process.env.DISPATCH_COURIER_ADMISSION_TIMEOUT_MS;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    resetAuthCaches();
    resetRateLimits();
    delete process.env.DISPATCH_COURIER_ADMISSION_URL;
    delete process.env.DISPATCH_COURIER_ADMISSION_TOKEN;
    delete process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES;
    vi.unstubAllGlobals();
  });

  it("returns 401 without credentials and 403 for a worker-tier token (maintainer-only submission)", async () => {
    const unauthed = await post(BASE_BODY, { includeAuth: false });
    expect(unauthed.status).toBe(401);

    const worker = await post(BASE_BODY, { token: "test-worker-token" });
    expect(worker.status).toBe(403);
    expect(harness.rows).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 and persists nothing when Courier admission is not configured", async () => {
    delete process.env.DISPATCH_COURIER_ADMISSION_TOKEN;
    const res = await post(BASE_BODY);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured|disabled/i);
    expect(harness.rows).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 when no namespace is approved", async () => {
    delete process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES;
    const res = await post(BASE_BODY);
    expect(res.status).toBe(503);
    expect(harness.rows).toHaveLength(0);
  });

  it("answers 400 on validation failures and on a namespace outside the approved list", async () => {
    for (const body of [
      { ...BASE_BODY, goal: "" },
      { ...BASE_BODY, baseRepo: "not-a-repo" },
      { ...BASE_BODY, workRepo: "also/not/a/repo" },
      { ...BASE_BODY, lane: "has\nnewline" },
      { ...BASE_BODY, idempotencyKey: "k".repeat(300) },
      { namespace: "team-other", lane: "contribution", baseRepo: "acme/widgets", baseRef: "main", workRepo: "acme/widgets-fork", goal: "x" },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    expect(harness.rows).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists the request BEFORE the first network call and records a 201 identity from Courier", async () => {
    fetchMock.mockResolvedValue(
      courierBody(201, { run: "run-77", namespace: "team-alpha", workItemId: "wi-9", resumed: false }),
    );
    const res = await post({ ...BASE_BODY, idempotencyKey: "key-abc" });
    expect(res.status).toBe(201);

    // Ordering: the ledger row exists before the credential leaves the process.
    expect(harness.calls).toEqual(["create"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.rows).toHaveLength(1);

    const row = harness.rows[0];
    expect(row.idempotencyKey).toBe("key-abc");
    expect(row.deliveryStatus).toBe("accepted");
    expect(row.courierRun).toBe("run-77");
    expect(row.courierWorkItemId).toBe("wi-9");
    expect(row.resumed).toBe(false);
    expect(row.payloadDigest).toBe(computePayloadDigest(canonicalAdmissionFields(row as any)));

    const body = await res.json();
    expect(body).toMatchObject({ run: "run-77", namespace: "team-alpha", workItemId: "wi-9", resumed: false, status: "accepted" });
    // The response carries the Dispatch-side identity too.
    expect(body.idempotencyKey).toBe("key-abc");

    // Credential boundary: the token never appears in the response, the
    // ledger row, or the audit row.
    expect(JSON.stringify(body)).not.toContain(COURIER_TOKEN);
    expect(JSON.stringify(harness.rows)).not.toContain(COURIER_TOKEN);
    expect(JSON.stringify(harness.audits)).not.toContain(COURIER_TOKEN);
    // ...and the upstream issue was never mutated.
    expect(harness.issueSpies.update).not.toHaveBeenCalled();
    expect(harness.issueSpies.updateMany).not.toHaveBeenCalled();
    expect(harness.issueSpies.create).not.toHaveBeenCalled();
    expect(harness.issueSpies.upsert).not.toHaveBeenCalled();
  });

  it("generates a fresh idempotency key when the caller supplies none", async () => {
    fetchMock.mockResolvedValue(courierBody(201, { run: "run-1", namespace: "team-alpha", workItemId: "wi-1", resumed: false }));
    const res = await post(BASE_BODY);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.idempotencyKey).toBeTruthy();
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent.idempotencyKey).toBe(body.idempotencyKey);
  });

  it("records a 200 resume from Courier as accepted with resumed=true", async () => {
    fetchMock.mockResolvedValue(courierBody(200, { run: "run-1", namespace: "team-alpha", workItemId: "wi-1", resumed: true }));
    const res = await post({ ...BASE_BODY, idempotencyKey: "key-resume" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ run: "run-1", resumed: true, status: "accepted" });
    expect(harness.rows[0].deliveryStatus).toBe("accepted");
  });

  it("replays an accepted request on repeated clicks without another Courier call", async () => {
    fetchMock.mockResolvedValue(courierBody(201, { run: "run-1", namespace: "team-alpha", workItemId: "wi-1", resumed: false }));
    const first = await post({ ...BASE_BODY, idempotencyKey: "key-once" });
    expect(first.status).toBe(201);

    fetchMock.mockClear();
    const second = await post({ ...BASE_BODY, idempotencyKey: "key-once" });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.run).toBe("run-1");
    expect(body.idempotencyKey).toBe("key-once");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.rows).toHaveLength(1);
  });

  it("rejects a changed payload under an existing request identity (409, no network call)", async () => {
    fetchMock.mockResolvedValue(courierBody(201, { run: "run-1", namespace: "team-alpha", workItemId: "wi-1", resumed: false }));
    await post({ ...BASE_BODY, idempotencyKey: "key-same" });

    fetchMock.mockClear();
    const changed = await post({ ...BASE_BODY, idempotencyKey: "key-same", goal: "A DIFFERENT goal" });
    expect(changed.status).toBe(409);
    expect((await changed.json()).error).toMatch(/does not match/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.rows).toHaveLength(1);
  });

  it("keeps one identity when a concurrent create loses the unique race", async () => {
    // Simulate the interleaving: findUnique sees nothing, the concurrent
    // winner's row lands, our create hits P2002, re-read finds the winner.
    const winner = harness.plantRow({
      idempotencyKey: "key-race",
      payloadDigest: digestOfBody({ ...BASE_BODY, idempotencyKey: "key-race" }),
      deliveryStatus: "accepted",
      attemptCount: 1,
      courierRun: "run-winner",
      courierWorkItemId: "wi-winner",
      resumed: false,
    });
    harness.setLoseNextCreateRace(true);

    const res = await post({ ...BASE_BODY, idempotencyKey: "key-race" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(winner.id);
    expect(body.run).toBe("run-winner");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.rows).toHaveLength(1);
  });

  it("maps an explicit Courier validation rejection to 400 and replays it without re-submitting", async () => {
    fetchMock.mockResolvedValue(courierBody(400, { error: "lane unknown" }));
    const first = await post({ ...BASE_BODY, idempotencyKey: "key-rej" });
    expect(first.status).toBe(400);
    expect((await first.json()).error).toContain("lane unknown");
    expect(harness.rows[0].deliveryStatus).toBe("rejected");

    fetchMock.mockClear();
    const replay = await post({ ...BASE_BODY, idempotencyKey: "key-rej" });
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toMatch(/already rejected/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.rows).toHaveLength(1);
  });

  it("maps a Courier authentication failure to the mirrored 401 without leaking the credential", async () => {
    fetchMock.mockResolvedValue(courierBody(401, { error: `invalid token ${COURIER_TOKEN}` }));
    const res = await post({ ...BASE_BODY, idempotencyKey: "key-auth" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.status).toBe("rejected");
    expect(JSON.stringify(body)).not.toContain(COURIER_TOKEN);
    expect(harness.rows[0].deliveryStatus).toBe("rejected");
    expect(harness.rows[0].lastError).not.toContain(COURIER_TOKEN);
  });

  it("maps a timeout to 504 and retries with the ORIGINAL key on the next submission", async () => {
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout).mockResolvedValueOnce(
      courierBody(201, { run: "run-2", namespace: "team-alpha", workItemId: "wi-2", resumed: false }),
    );

    const first = await post({ ...BASE_BODY, idempotencyKey: "key-timeout" });
    expect(first.status).toBe(504);
    expect(harness.rows[0].deliveryStatus).toBe("uncertain");
    expect(harness.rows[0].attemptCount).toBe(1);

    const second = await post({ ...BASE_BODY, idempotencyKey: "key-timeout" });
    expect(second.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    const secondSent = JSON.parse((fetchMock.mock.calls[1] as any)[1].body);
    expect(secondSent.idempotencyKey).toBe(firstSent.idempotencyKey);
    expect(secondSent.idempotencyKey).toBe("key-timeout");
    expect(harness.rows[0].deliveryStatus).toBe("accepted");
    expect(harness.rows[0].attemptCount).toBe(2);
  });

  it("maps an unreachable endpoint to 502 (uncertain delivery)", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await post({ ...BASE_BODY, idempotencyKey: "key-down" });
    expect(res.status).toBe(502);
    expect(harness.rows[0].deliveryStatus).toBe("uncertain");
  });

  it("maps a malformed Courier success body to 502 uncertain, not a fake identity", async () => {
    fetchMock.mockResolvedValue(courierBody(201, undefined, "not-json"));
    const res = await post({ ...BASE_BODY, idempotencyKey: "key-malformed" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.status).toBe("uncertain");
    expect(body.run).toBeNull();
    expect(harness.rows[0].deliveryStatus).toBe("uncertain");
    expect(harness.rows[0].courierRun).toBeNull();
  });

  it("stops retrying after the bounded attempts and says a new request is required", async () => {
    harness.plantRow({
      idempotencyKey: "key-exhausted",
      payloadDigest: digestOfBody({ ...BASE_BODY, idempotencyKey: "key-exhausted" }),
      deliveryStatus: "uncertain",
      attemptCount: MAX_DELIVERY_ATTEMPTS,
      lastError: "courier admission timed out after 30000ms; delivery outcome unknown",
    });
    const res = await post({ ...BASE_BODY, idempotencyKey: "key-exhausted" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/bounded retries/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never follows a redirect with credentials (fetch is told to error on redirect)", async () => {
    fetchMock.mockResolvedValue(courierBody(201, { run: "run-3", namespace: "team-alpha", workItemId: "wi-3", resumed: false }));
    await post({ ...BASE_BODY, idempotencyKey: "key-redirect" });
    const init = (fetchMock.mock.calls[0] as any)[1];
    expect(init.redirect).toBe("error");
  });

  it("leaves ordinary scheduling state untouched: no issue writes and no upstream labels touched", async () => {
    fetchMock.mockResolvedValue(courierBody(201, { run: "run-4", namespace: "team-alpha", workItemId: "wi-4", resumed: false }));
    await post({ ...BASE_BODY, idempotencyKey: "key-schedule" });
    for (const spy of Object.values(harness.issueSpies)) {
      expect(spy).not.toHaveBeenCalled();
    }
    // The audit trail records the submission against the BASE repo only.
    expect(harness.audits[0].action).toBe("external_contribution_submit");
    expect(harness.audits[0].repoFullName).toBe("acme/widgets");
    expect(harness.audits[0].success).toBe(true);
  });
});
