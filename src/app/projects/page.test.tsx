import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findManyIssues: vi.fn().mockResolvedValue([]),
    groupedIssues: [] as unknown[],
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.findManyIssues },
  },
}));

// Capture the rows the page hands to the project grouping: the projects page
// serializes raw issue rows, so the release-signal normalization is only
// observable there.
vi.mock("@/lib/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects")>();
  return {
    ...actual,
    groupIssuesByProject: (issues: Parameters<typeof actual.groupIssuesByProject>[0]) => {
      mocks.groupedIssues = issues;
      return actual.groupIssuesByProject(issues);
    },
  };
});

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  CardContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span>{children}</span>
  ),
}));

import ProjectsPage from "./page";

function mockIssue(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: `issue-${Math.random().toString(36).slice(2)}`,
    number: 1,
    title: "Test issue",
    state: "open",
    url: "https://github.com/test/repo/issues/1",
    labels: ["status/ready"],
    closedAt: null,
    repository: { fullName: "test/repo", name: "repo" },
    ...overrides,
  };
}

function extractAllText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!React.isValidElement(node)) return "";

  const props = node.props as { children?: unknown };
  const children = props.children;

  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) {
    return children.map(extractAllText).join("");
  }

  // Recurse into React elements
  const childElements = React.Children.toArray(children as React.ReactNode | React.ReactNode[]);
  return childElements.map(extractAllText).join("");
}

describe("ProjectsPage five-column layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all five status columns in canonical order", async () => {
    mocks.findManyIssues.mockResolvedValue([mockIssue({ labels: ["status/ready"] })]);

    const page = await ProjectsPage({ searchParams: Promise.resolve({}) });

    // Collect all text content from the rendered page
    const allText = extractAllText(page);

    // BOARD_COLUMNS order: Backlog, Ready, In Progress, In Review, Done
    expect(allText.toLowerCase()).toContain("backlog");
    expect(allText.toLowerCase()).toContain("ready");
    expect(allText.toLowerCase()).toContain("in progress");
    expect(allText.toLowerCase()).toContain("in review");
    expect(allText.toLowerCase()).toContain("done");
  });

  it("wraps the status grid in an overflow-x-auto container", async () => {
    mocks.findManyIssues.mockResolvedValue([mockIssue({ labels: ["status/ready"] })]);

    const page = await ProjectsPage({ searchParams: Promise.resolve({}) });

    // The overflow-x-auto wrapper is a div with that class name
    let hasOverflowWrapper = false;

    function walk(node: React.ReactNode) {
      if (typeof node !== "object" || !React.isValidElement(node)) return;
      const props = node.props as { className?: string };
      if (typeof props.className === "string" && props.className.includes("overflow-x-auto")) {
        hasOverflowWrapper = true;
      }
      const children = React.Children.toArray((node.props as { children?: React.ReactNode }).children);
      children.forEach(walk);
    }

    walk(page);
    expect(hasOverflowWrapper).toBe(true);
  });

  it("lays the status columns out as one scrollable row, not a fixed-count grid", async () => {
    mocks.findManyIssues.mockResolvedValue([mockIssue({ labels: ["status/ready"] })]);

    const page = await ProjectsPage({ searchParams: Promise.resolve({}) });

    let hasScrollRow = false;

    function walk(node: React.ReactNode) {
      if (typeof node !== "object" || !React.isValidElement(node)) return;
      const props = node.props as { className?: string };
      if (typeof props.className === "string"
          && props.className.includes("lg:flex")
          && props.className.includes("lg:min-w-max")
          && !/lg:grid-cols-\d/.test(props.className)) {
        hasScrollRow = true;
      }
      const children = React.Children.toArray((node.props as { children?: React.ReactNode }).children);
      children.forEach(walk);
    }

    walk(page);
    expect(hasScrollRow).toBe(true);
  });

  it("no longer pins the grid with an inline minWidth", async () => {
    mocks.findManyIssues.mockResolvedValue([mockIssue({ labels: ["status/ready"] })]);

    const page = await ProjectsPage({ searchParams: Promise.resolve({}) });

    let hasFitContent = false;

    function walk(node: React.ReactNode) {
      if (typeof node !== "object" || !React.isValidElement(node)) return;
      const props = node.props as { style?: { minWidth?: string } };
      if (props.style?.minWidth === "fit-content") {
        hasFitContent = true;
      }
      const children = React.Children.toArray((node.props as { children?: React.ReactNode }).children);
      children.forEach(walk);
    }

    walk(page);
    expect(hasFitContent).toBe(false);
  });

  it("renders Done column even when no issues have status/done label", async () => {
    mocks.findManyIssues.mockResolvedValue([
      mockIssue({ labels: ["status/ready"] }),
      mockIssue({ labels: ["status/in-progress"] }),
    ]);

    const page = await ProjectsPage({ searchParams: Promise.resolve({}) });

    const allText = extractAllText(page);
    expect(allText.toLowerCase()).toContain("done");
  });
});

describe("ProjectsPage Done retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes open issues in the query", async () => {
    mocks.findManyIssues.mockResolvedValue([]);

    await ProjectsPage({ searchParams: Promise.resolve({}) });

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.OR).toBeDefined();
    expect(call.where.OR[0]).toEqual({ state: "open" });
  });

  it("includes closed Done issues within retention window", async () => {
    mocks.findManyIssues.mockResolvedValue([]);

    await ProjectsPage({ searchParams: Promise.resolve({}) });

    const call = mocks.findManyIssues.mock.calls[0][0];
    const doneBranch = call.where.OR[1];
    expect(doneBranch.state).toBe("closed");
    expect(doneBranch.labels.has).toBe("status/done");
    expect(doneBranch.closedAt.gte).toBeDefined();
  });

  it("excludes closed issues without status/done label", async () => {
    mocks.findManyIssues.mockResolvedValue([]);

    await ProjectsPage({ searchParams: Promise.resolve({}) });

    const call = mocks.findManyIssues.mock.calls[0][0];
    // The OR clause should only have two branches: open, and closed+done
    expect(call.where.OR.length).toBe(2);
  });

  it("respects DISPATCH_DONE_RETENTION_DAYS environment variable", async () => {
    const originalEnv = process.env.DISPATCH_DONE_RETENTION_DAYS;
    process.env.DISPATCH_DONE_RETENTION_DAYS = "30";

    // Re-import to pick up new env var (module cache cleared by beforeEach + resetCaches)
    mocks.findManyIssues.mockResolvedValue([]);

    await ProjectsPage({ searchParams: Promise.resolve({}) });

    process.env.DISPATCH_DONE_RETENTION_DAYS = originalEnv;
  });
});

describe("ProjectsPage empty state", () => {
  it("renders no-issues message when no projects exist", async () => {
    mocks.findManyIssues.mockResolvedValue([]);

    const page = await ProjectsPage({ searchParams: Promise.resolve({}) });

    const allText = extractAllText(page);
    expect(allText).toContain("No issues have been synced yet");
  });
});

describe("ProjectsPage release-signal projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.groupedIssues = [];
  });

  it("normalizes a cleared release-signal tombstone before the page payload (dispatch#1487)", async () => {
    mocks.findManyIssues.mockResolvedValue([
      mockIssue({
        releaseSignal: {
          tombstone: true,
          provenance: {
            groomingRunId: "gr-1",
            applicationKey: "an-application",
            appliedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    ]);

    await ProjectsPage({ searchParams: Promise.resolve({}) });

    expect(mocks.groupedIssues).toHaveLength(1);
    expect((mocks.groupedIssues[0] as { releaseSignal: unknown }).releaseSignal).toBeNull();
  });

  it("keeps a set release-signal projection intact", async () => {
    const signal = {
      kind: "feature",
      headline: "Adds a tenant-scoped login redirect",
      significance: "notable",
      evidenceRefs: [],
      provenance: { groomingRunId: "gr-1", applicationKey: "an-application" },
    };
    mocks.findManyIssues.mockResolvedValue([mockIssue({ releaseSignal: signal })]);

    await ProjectsPage({ searchParams: Promise.resolve({}) });

    expect((mocks.groupedIssues[0] as { releaseSignal: unknown }).releaseSignal).toEqual(signal);
  });
});
