/**
 * Idempotency integration test for tasks/report, against a real PostgreSQL.
 *
 * The mocked suite in route.test.ts can simulate a P2002-shaped rejection,
 * but it cannot prove that the AgentReportDedupe unique index actually
 * serializes two concurrent reports into one logical report — that guarantee
 * rests on PostgreSQL index behavior under genuine parallel inserts (#1044).
 *
 * Opt-in via RUN_DB_INTEGRATION=1 (same gating as sync-lock.integration.test.ts,
 * which explains why DATABASE_URL alone is not the gate). The database-
 * integration CI job applies the migrations and opts in explicitly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const url = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(url);
// Vitest's conditional-suite form: no explicit opt-in, no run.
const suite = enabled ? describe : describe.skip;

const AGENT = "integration-idempotency-agent";

function postRequest(body: unknown, agentName = AGENT) {
  return POST(
    authedRequest(`http://localhost/api/agents/${agentName}/tasks/report`, {
      method: "POST",
      body,
    }),
    { params: Promise.resolve({ agentName }) },
  );
}

const keyedReport = {
  taskType: "followup-pr",
  outcome: "no_changes_needed",
  repoFullName: "integration/nonexistent",
  pullRequestNumber: 1,
  idempotencyKey: "integration-key-1",
};

suite("tasks/report idempotency against a real PostgreSQL", () => {
  beforeAll(() => {
    // Resolve the lazy prisma proxy once so a bad DATABASE_URL fails loudly
    // in setup rather than mid-test.
    void prisma.$connect?.();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    await prisma.agentReportDedupe.deleteMany({ where: { agentName: AGENT } });
    await prisma.agentRun.deleteMany({ where: { agentName: AGENT } });
  });

  it("two concurrent same-key reports create exactly one logical report", async () => {
    const [first, second] = await Promise.all([
      postRequest(keyedReport),
      postRequest(keyedReport),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const bodies = [(await first.json()), (await second.json())];
    const duplicates = bodies.filter((b) => b.duplicate === true);
    expect(duplicates).toHaveLength(1);
    // Exactly one of the two carries duplicate:true — the other is a plain
    // first-time response with no duplicate field at all.
    expect(bodies.filter((b) => b.duplicate === undefined)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.agentRunId)).size).toBe(1);

    // Exactly one AgentRun and one claim row; the claim carries the result.
    const runs = await prisma.agentRun.findMany({ where: { agentName: AGENT } });
    expect(runs).toHaveLength(1);
    const claims = await prisma.agentReportDedupe.findMany({
      where: { agentName: AGENT, idempotencyKey: keyedReport.idempotencyKey },
    });
    expect(claims).toHaveLength(1);
    expect(claims[0].agentRunId).toBe(runs[0].id);
    expect(claims[0].prFixResolution).not.toBeNull();
  });

  it("a sequential retry replays the stored agentRunId and resolution", async () => {
    const first = await postRequest(keyedReport);
    const firstBody = await first.json();
    expect(firstBody.duplicate).toBeUndefined();

    const retry = await postRequest(keyedReport);
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    expect(retryBody.duplicate).toBe(true);
    expect(retryBody.agentRunId).toBe(firstBody.agentRunId);
    expect(retryBody.prFixResolution).toEqual(firstBody.prFixResolution);

    // The retry created nothing new.
    expect(await prisma.agentRun.count({ where: { agentName: AGENT } })).toBe(1);
    expect(
      await prisma.agentReportDedupe.count({ where: { agentName: AGENT } }),
    ).toBe(1);
  });

  it("the same key with a different payload is rejected as a conflict", async () => {
    const first = await postRequest(keyedReport);
    expect(first.status).toBe(200);

    const conflict = await postRequest({
      ...keyedReport,
      outcome: "pr_updated",
    });

    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toContain("different report payload");
    expect(await prisma.agentRun.count({ where: { agentName: AGENT } })).toBe(1);
  });

  it("deleting the AgentRun nulls the claim's reference but keeps the claim recognizable", async () => {
    const first = await postRequest(keyedReport);
    const { agentRunId } = await first.json();
    expect(agentRunId).toBeTruthy();

    await prisma.agentRun.delete({ where: { id: agentRunId } });

    const claims = await prisma.agentReportDedupe.findMany({
      where: { agentName: AGENT, idempotencyKey: keyedReport.idempotencyKey },
    });
    expect(claims).toHaveLength(1);
    expect(claims[0].agentRunId).toBeNull();
    // The claim stays fully recognizable without the run: key and payload
    // hash are intact.
    expect(claims[0].payloadHash).toMatch(/^[0-9a-f]{64}$/);
    // A retry after the run's deletion surfaces the defensive conflict, not a
    // silent re-run.
    const retry = await postRequest(keyedReport);
    expect(retry.status).toBe(409);
    expect((await retry.json()).error).toContain("no recorded result");
  });
});
