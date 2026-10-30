import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAgentDirectory: vi.fn(),
  agentRunFindMany: vi.fn(),
  authedFetch: vi.fn(),
}));

vi.mock("@/lib/agent-directory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-directory")>();
  return {
    ...actual,
    getAgentDirectory: (...args: Parameters<typeof actual.getAgentDirectory>) =>
      mocks.getAgentDirectory(...args),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: { agentRun: { findMany: mocks.agentRunFindMany } },
}));

vi.mock("@/lib/client-auth", () => ({
  authedFetch: (...args: unknown[]) => mocks.authedFetch(...args),
}));

vi.mock("next/link", () => ({
  default: function NavLink({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: React.ReactNode }) {
    return React.createElement("a", { href, ...rest }, children);
  },
}));

import AgentsPage from "./page";
import type { AgentDirectory, AgentDirectoryEntry } from "@/lib/agent-directory";

function entry(overrides: Partial<AgentDirectoryEntry> = {}): AgentDirectoryEntry {
  return {
    agentName: "alpha",
    active: true,
    reasons: ["assigned-open"],
    lastSeenAt: new Date("2026-10-30T10:00:00.000Z"),
    assignedOpen: 1,
    ready: 0,
    inProgress: 1,
    inReview: 0,
    executing: 1,
    ...overrides,
  };
}

function directory(overrides: Partial<AgentDirectory> = {}): AgentDirectory {
  return { agents: [], inactiveHidden: 0, totalIdentities: 0, ...overrides };
}

async function renderPage(searchParams: Record<string, string> = {}) {
  const tree = await AgentsPage({ searchParams: Promise.resolve(searchParams) });
  return render(tree as React.ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentRunFindMany.mockResolvedValue([]);
  mocks.authedFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ activeWork: [], staleLeases: [], executions: [] }),
  });
});

describe("Agents page", () => {
  it("asks agents to report when no identity has ever been observed", async () => {
    mocks.getAgentDirectory.mockResolvedValue(directory());
    await renderPage();
    expect(screen.getByText(/No agents have reported yet/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Show inactive/ })).not.toBeInTheDocument();
  });

  it("passes the inactive search param through to the directory", async () => {
    mocks.getAgentDirectory.mockResolvedValue(directory());
    await renderPage({ inactive: "1" });
    expect(mocks.getAgentDirectory).toHaveBeenCalledWith({ includeInactive: true });
  });

  it("defaults to the active-only view with a Show inactive/history affordance", async () => {
    mocks.getAgentDirectory.mockResolvedValue(
      directory({
        agents: [entry()],
        inactiveHidden: 2,
        totalIdentities: 3,
      }),
    );
    await renderPage();

    expect(mocks.getAgentDirectory).toHaveBeenCalledWith({ includeInactive: false });
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    const toggle = screen.getByRole("link", { name: /Show inactive\/history \(2\)/ });
    expect(toggle).toHaveAttribute("href", "/agents?inactive=1");
  });

  it("distinguishes open assignment counts from executing work on each card", async () => {
    mocks.getAgentDirectory.mockResolvedValue(
      directory({
        agents: [entry({ assignedOpen: 4, executing: 1 })],
        totalIdentities: 1,
      }),
    );
    await renderPage();

    expect(screen.getByText("Assigned (open)")).toBeInTheDocument();
    expect(screen.getByText("Executing")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("renders inactive identities with honest last-seen provenance in the history view", async () => {
    mocks.getAgentDirectory.mockResolvedValue(
      directory({
        agents: [
          entry(),
          entry({
            agentName: "saffron-old",
            active: false,
            reasons: [],
            lastSeenAt: null,
            assignedOpen: 0,
            executing: 0,
          }),
        ],
        inactiveHidden: 1,
        totalIdentities: 2,
      }),
    );
    await renderPage({ inactive: "1" });

    expect(screen.getByText("saffron-old")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByText("No reports recorded")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Hide inactive\/history/ })).toHaveAttribute(
      "href",
      "/agents",
    );
    expect(screen.getByText(/Hiding is display-only/)).toBeInTheDocument();
  });

  it("explains the empty active view without deleting historical evidence", async () => {
    mocks.getAgentDirectory.mockResolvedValue(
      directory({ agents: [], inactiveHidden: 3, totalIdentities: 3 }),
    );
    await renderPage();

    expect(screen.getByText(/No active agents\. 3 inactive identities are hidden/)).toBeInTheDocument();
    expect(screen.getByText(/does not prove an agent is offline/)).toBeInTheDocument();
    const toggles = screen.getAllByRole("link", { name: /Show inactive\/history/ });
    for (const toggle of toggles) {
      expect(toggle).toHaveAttribute("href", "/agents?inactive=1");
    }
  });
});
