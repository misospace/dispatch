import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findManyIssues: vi.fn().mockResolvedValue([]),
    findManyRuns: vi.fn().mockResolvedValue([]),
    findManyLogs: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.findManyIssues },
    agentRun: { findMany: mocks.findManyRuns },
    auditLog: { findMany: mocks.findManyLogs },
  },
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TableBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TableCell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TableHead: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TableRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import OverviewPage from "./page";
import { buildExcludedLabelWhere } from "@/lib/issue-filters";

describe("OverviewPage excluded-label filter (#1604)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DISPATCH_EXCLUDED_LABELS;
    mocks.findManyIssues.mockResolvedValue([]);
    mocks.findManyRuns.mockResolvedValue([]);
    mocks.findManyLogs.mockResolvedValue([]);
  });

  it("keeps labels matching DISPATCH_EXCLUDED_LABELS out of the stats query", async () => {
    process.env.DISPATCH_EXCLUDED_LABELS = "wontfix, hold";

    await OverviewPage();

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.state).toBe("open");
    expect(call.where.AND).toEqual(
      expect.arrayContaining([buildExcludedLabelWhere(["wontfix", "hold"])]),
    );
  });

  it("adds no excluded-label clause when DISPATCH_EXCLUDED_LABELS is unset", async () => {
    await OverviewPage();

    const call = mocks.findManyIssues.mock.calls[0][0];
    const andClauses: unknown[] = Array.isArray(call.where.AND)
      ? call.where.AND
      : call.where.AND
        ? [call.where.AND]
        : [];
    // The Renovate exclusion nests under NOT.OR; only the excluded-label
    // filter puts labels.hasSome inside a NOT clause.
    const labelExclusions = andClauses.filter(
      (clause) => (clause as { NOT?: { labels?: { hasSome?: unknown } } }).NOT?.labels?.hasSome,
    );
    expect(labelExclusions).toHaveLength(0);
  });
});
