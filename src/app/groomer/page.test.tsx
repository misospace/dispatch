import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

const { mockAuthedFetch } = vi.hoisted(() => ({
  mockAuthedFetch: vi.fn(),
}));

vi.mock("@/lib/client-auth", () => ({
  authedFetch: mockAuthedFetch,
}));

import GroomerHistoryPage from "./page";

const HEAD_SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const FINGERPRINT = "c".repeat(64);

function baseRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-1",
    repoFullName: "org/repo",
    issueNumber: 42,
    issueUrl: "https://github.com/org/repo/issues/42",
    status: "completed",
    stage: "applied",
    dryRun: false,
    model: "test-model",
    labelsBefore: ["status/backlog"],
    labelsAfter: ["status/ready"],
    laneBefore: "backlog",
    laneAfter: "local",
    errorMessage: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    validatedOutput: { schemaVersion: 1, verdict: { actionability: "ready" }, readiness: { ready: true } },
    ...overrides,
  };
}

function appliedView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: "applied",
    status: "completed",
    evidence: {
      available: true,
      capturedAt: "2026-10-10T00:00:00.000Z",
      headSha: HEAD_SHA,
      pinnedRef: HEAD_SHA,
      defaultBranch: "main",
      evidenceDigest: DIGEST,
      issueFingerprint: FINGERPRINT,
      pinned: true,
      repositoryReadCount: 2,
      repositorySurfacedCount: 1,
      relatedWorkCount: 1,
      humanCommentCount: 2,
      automationCommentCount: 1,
      warnings: [],
    },
    plan: { schemaVersion: 1, format: "grooming-plan", actionability: "ready", ready: true, admission: "implementation", summary: "Ready" },
    precondition: { recorded: true, ok: true, failures: [], checks: [{ name: "issue", status: "passed", detail: "unchanged" }], stale: false, unverifiable: false },
    application: { applicationKey: "key-1", applyOutcome: "applied", replayed: false, freshApplication: true, applicationCount: 1, lastApplicationAt: "2026-10-10T00:00:00.000Z" },
    decision: { close: null, readyPromotion: null, decomposition: null },
    ...overrides,
  };
}

describe("Hosted Groomer history page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthedFetch.mockImplementation((url: string) => {
      if (String(url).includes("/api/groomer/runs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
  });

  it("shows the evidence column for pinned runs and no snapshot for legacy runs", async () => {
    mockAuthedFetch.mockImplementation((url: string) => {
      if (String(url).includes("/api/groomer/runs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              baseRun({ view: appliedView() }),
              baseRun({ id: "run-legacy", issueNumber: 7, validatedOutput: undefined, view: undefined }),
            ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    render(<GroomerHistoryPage />);

    expect(await screen.findByText(HEAD_SHA.slice(0, 12))).toBeInTheDocument();
    expect(screen.getByText(`digest ${DIGEST.slice(0, 12)}`)).toBeInTheDocument();
    expect(screen.getByText("2 human / 1 automation")).toBeInTheDocument();
    expect(screen.getByText("no snapshot")).toBeInTheDocument();
  });

  it("expands a run to show revision, precondition, idempotency and decision evidence", async () => {
    mockAuthedFetch.mockImplementation((url: string) => {
      if (String(url).includes("/api/groomer/runs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              baseRun({
                view: appliedView({
                  decision: {
                    close: { reason: "already_done", rationale: "verified at pinned head", evidenceRefs: ["repo:src/a.ts"] },
                    readyPromotion: null,
                    decomposition: {
                      required: true,
                      reason: "parent audit",
                      childrenCreated: [{ number: 1300, url: "https://github.com/org/repo/issues/1300" }],
                      childrenReused: [],
                    },
                  },
                }),
              }),
            ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    render(<GroomerHistoryPage />);

    const row = await screen.findByText(/org\/repo#42/);
    fireEvent.click(row);

    const panel = await screen.findByTestId("run-evidence-panel");
    expect(panel).toHaveTextContent(HEAD_SHA);
    expect(panel).toHaveTextContent("main");
    expect(panel).toHaveTextContent("evidence digest:");
    expect(panel).toHaveTextContent("2 human (authoritative)");
    expect(panel).toHaveTextContent("automation");
    expect(panel).toHaveTextContent("non-authoritative");
    expect(panel).toHaveTextContent("Close as already_done");
    expect(panel).toHaveTextContent("verified at pinned head");
    expect(panel).toHaveTextContent("evidence: repo:src/a.ts");
    expect(panel).toHaveTextContent("Decomposition: parent audit");
    const childLink = panel.querySelector('a[href="https://github.com/org/repo/issues/1300"]');
    expect(childLink).not.toBeNull();
    expect(childLink).toHaveTextContent("#1300");
    expect(screen.getByText("fresh application")).toBeInTheDocument();
  });

  it("shows staleness and what changed for a stale-aborted run", async () => {
    mockAuthedFetch.mockImplementation((url: string) => {
      if (String(url).includes("/api/groomer/runs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              baseRun({
                id: "run-stale",
                status: "stale",
                stage: "validated",
                view: appliedView({
                  status: "stale",
                  stage: "validated",
                  precondition: {
                    recorded: true,
                    ok: false,
                    failures: ["issue changed since the evidence snapshot: labels"],
                    checks: [
                      { name: "issue", status: "changed", detail: "issue changed since the evidence snapshot: labels" },
                      { name: "head", status: "passed", detail: "main head unchanged" },
                    ],
                    stale: true,
                    unverifiable: false,
                  },
                  application: { applicationKey: "key-2", applyOutcome: "stale", replayed: false, freshApplication: false, applicationCount: null, lastApplicationAt: null },
                }),
              }),
            ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    render(<GroomerHistoryPage />);

    const row = await screen.findByText(/org\/repo#42/);
    fireEvent.click(row);

    const panel = await screen.findByTestId("run-evidence-panel");
    expect(within(panel).getAllByText("stale").length).toBeGreaterThan(0);
    expect(panel).toHaveTextContent("issue — changed: issue changed since the evidence snapshot: labels");
    expect(panel).toHaveTextContent("head — passed: main head unchanged");
    expect(panel).toHaveTextContent("issue changed since the evidence snapshot: labels");
    expect(panel).toHaveTextContent("stale");
    expect(within(panel).queryAllByText("fresh application")).toHaveLength(0);
  });

  it("marks a replayed run as visibly different from a fresh application", async () => {
    mockAuthedFetch.mockImplementation((url: string) => {
      if (String(url).includes("/api/groomer/runs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              baseRun({
                view: appliedView({
                  application: {
                    applicationKey: "key-3",
                    applyOutcome: "replayed",
                    replayed: true,
                    freshApplication: false,
                    applicationCount: 2,
                    lastApplicationAt: "2026-10-09T00:00:00.000Z",
                  },
                }),
              }),
            ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    render(<GroomerHistoryPage />);

    const row = await screen.findByText(/org\/repo#42/);
    fireEvent.click(row);

    const panel = await screen.findByTestId("run-evidence-panel");
    expect(within(panel).getAllByText("replayed").length).toBeGreaterThan(0);
    expect(panel).toHaveTextContent("a previous run with the same application key already applied this plan; nothing was written");
    expect(panel).toHaveTextContent("Recorded applications: 2");
    expect(within(panel).queryAllByText("fresh application")).toHaveLength(0);
  });

  it("tells the operator a legacy run carried no evidence snapshot", async () => {
    mockAuthedFetch.mockImplementation((url: string) => {
      if (String(url).includes("/api/groomer/runs")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              baseRun({
                id: "run-legacy",
                view: appliedView({
                  evidence: {
                    available: false,
                    capturedAt: null,
                    headSha: null,
                    pinnedRef: null,
                    defaultBranch: null,
                    evidenceDigest: null,
                    issueFingerprint: null,
                    pinned: false,
                    repositoryReadCount: 0,
                    repositorySurfacedCount: 0,
                    relatedWorkCount: 0,
                    humanCommentCount: 0,
                    automationCommentCount: 0,
                    warnings: [],
                  },
                  plan: { schemaVersion: null, format: "legacy", actionability: "ready", ready: null, admission: null, summary: "legacy" },
                }),
              }),
            ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    render(<GroomerHistoryPage />);

    const row = await screen.findByText(/org\/repo#42/);
    fireEvent.click(row);

    const panel = await screen.findByTestId("run-evidence-panel");
    expect(panel).toHaveTextContent("No evidence snapshot was captured for this run (legacy run).");
  });
});
