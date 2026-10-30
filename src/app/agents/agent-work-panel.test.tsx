import { render, screen, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentWorkPanel from "./agent-work-panel";

const authedFetchMock = vi.fn();
vi.mock("@/lib/client-auth", () => ({
  authedFetch: (...args: unknown[]) => authedFetchMock(...args),
}));

const makeWork = (overrides = {}) => ({
  id: "work-1",
  agentName: "alpha",
  issueId: "issue-1",
  runId: null,
  state: "IN_PROGRESS",
  checkpoint: "step 1",
  branch: "feature/x",
  prUrl: null,
  leaseExpiresAt: null,
  lastHeartbeatAt: new Date().toISOString(),
  summary: null,
  blockerReason: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  issueNumber: 42,
  issueTitle: "Test issue",
  repoFullName: "test/repo",
  ...overrides,
});

const makeExecution = (overrides = {}) => ({
  id: "exec-1",
  agentName: "alpha",
  source: "courier",
  executionId: "exec-abc",
  workType: "implement",
  workRefUrl: "https://github.com/test/repo/issues/42",
  issueId: "issue-1",
  executionState: "RUNNING",
  startedAt: new Date().toISOString(),
  lastObservedAt: new Date().toISOString(),
  endedAt: null,
  summary: null,
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  staleness: "live",
  ...overrides,
});

function mockApi({
  activeWork = [makeWork()],
  staleLeases = [],
  executions = [makeExecution()],
  executionsStatus = 200,
} = {}) {
  authedFetchMock.mockImplementation((url: string) => {
    if (String(url).includes("/api/agent-executions")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            capability: { name: "agent-executions", protocolVersion: 1 },
            executions,
          }),
          { status: executionsStatus },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ activeWork, staleLeases }), { status: 200 }),
    );
  });
}

async function renderPanel(
  options?: Parameters<typeof mockApi>[0],
  waitText = "Legacy session",
) {
  mockApi(options);
  render(React.createElement(AgentWorkPanel));
  await screen.findByText("Source-Reported Executions");
  await screen.findByText(waitText);
}

describe("AgentWorkPanel source-reported executions (#1495)", () => {
  beforeEach(() => {
    authedFetchMock.mockReset();
  });

  it("renders legacy rows unchanged and shows a live execution row with linked legacy session", async () => {
    await renderPanel();

    // Legacy row still renders.
    expect(screen.getByText("step 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release" })).toBeInTheDocument();

    // New section renders the execution row.
    const table = screen.getByText("Legacy session").closest("table")!;
    expect(within(table).getByText("alpha")).toBeInTheDocument();
    expect(within(table).getByText("Running")).toBeInTheDocument();
    expect(within(table).getByText("courier")).toBeInTheDocument();
    expect(within(table).getByText("Implement")).toBeInTheDocument();
    // staleness "live" → no Stale badge anywhere (no stale legacy rows either).
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    // workRefUrl matches the legacy row's issue URL → Linked.
    expect(within(table).getByText(/Linked/)).toBeInTheDocument();
    const link = within(table).getByText("42").closest("a");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/test/repo/issues/42",
    );
  });

  it("shows an unlinked execution as em-dash when no legacy row matches", async () => {
    await renderPanel({
      executions: [makeExecution({ workRefUrl: "https://github.com/other/repo/issues/99" })],
    });

    const table = screen.getByText("Legacy session").closest("table")!;
    expect(within(table).getByText("—")).toBeInTheDocument();
    expect(within(table).queryByText(/Linked/)).not.toBeInTheDocument();
  });

  it("shows the Stale badge for a stale execution", async () => {
    await renderPanel({
      executions: [makeExecution({ staleness: "stale" })],
    });

    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("shows the empty state and no error when the list is empty", async () => {
    await renderPanel({ executions: [] }, "No source-reported executions");

    expect(screen.getByText("No source-reported executions")).toBeInTheDocument();
    expect(
      screen.queryByText("Failed to load source-reported executions"),
    ).not.toBeInTheDocument();
  });

  it("shows the error line on fetch failure while legacy rows still render", async () => {
    await renderPanel(
      { executionsStatus: 500 },
      "Failed to load source-reported executions",
    );

    expect(
      screen.getByText("Failed to load source-reported executions"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No source-reported executions"),
    ).not.toBeInTheDocument();
    // Legacy rows unaffected by the executions failure.
    expect(screen.getByText("step 1")).toBeInTheDocument();
  });

  it("renders no Release/Reassign controls in the executions table", async () => {
    await renderPanel();

    const table = screen.getByText("Legacy session").closest("table")!;
    expect(within(table).queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
    expect(within(table).queryByPlaceholderText("New agent")).not.toBeInTheDocument();
  });

  it("renders a terminal SUCCEEDED row with its badge", async () => {
    await renderPanel({
      executions: [makeExecution({ executionState: "SUCCEEDED", endedAt: new Date().toISOString() })],
    });

    expect(screen.getByText("Succeeded")).toBeInTheDocument();
  });
});
