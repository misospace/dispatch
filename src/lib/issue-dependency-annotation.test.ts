import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: { findManyIssues: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { issue: { findMany: mocks.findManyIssues } },
}));

import { withDependencyBlockReasons } from "./issue-dependency-annotation";

const issue = (repo: string, number: number, body: string | null, state = "open") => ({
  id: `${repo}#${number}`,
  number,
  state,
  body,
  repository: { fullName: repo },
});

const openRow = (repo: string, number: number) => ({ number, repository: { fullName: repo } });

describe("withDependencyBlockReasons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findManyIssues.mockResolvedValue([]);
  });

  it("reports a cross-repo blocker that a repo-filtered board does not contain", async () => {
    // Board filtered to ?repo=foo/repo: bar/repo#20 is not in the input list.
    mocks.findManyIssues.mockResolvedValue([openRow("bar/repo", 20)]);

    const [annotated] = await withDependencyBlockReasons([
      issue("foo/repo", 10, "Depends on bar/repo#20"),
    ]);

    expect(annotated.dependencyBlockReason).toBe("Blocked by open bar/repo#20");
    // The lookup is the queue's universe (open + enabled), with no board filters.
    expect(mocks.findManyIssues).toHaveBeenCalledWith({
      where: { state: "open", repository: { enabled: true }, number: { in: [20] } },
      select: { number: true, repository: { select: { fullName: true } } },
    });
  });

  it("reports a same-repo blocker hidden by a non-repo filter (lane/status/agent)", async () => {
    mocks.findManyIssues.mockResolvedValue([openRow("foo/repo", 20)]);

    const [annotated] = await withDependencyBlockReasons([issue("foo/repo", 10, "blocked by #20")]);

    expect(annotated.dependencyBlockReason).toBe("Blocked by open #20");
  });

  it("returns null once the blocker is closed (absent from the open universe)", async () => {
    const [annotated] = await withDependencyBlockReasons([issue("foo/repo", 10, "depends on #20")]);

    expect(annotated.dependencyBlockReason).toBeNull();
  });

  it("does not match a same-numbered open issue in a different repo", async () => {
    mocks.findManyIssues.mockResolvedValue([openRow("bar/repo", 20)]);

    const [annotated] = await withDependencyBlockReasons([issue("foo/repo", 10, "depends on #20")]);

    expect(annotated.dependencyBlockReason).toBeNull();
  });

  it("matches repo names case-insensitively", async () => {
    mocks.findManyIssues.mockResolvedValue([openRow("Bar/Repo", 20)]);

    const [annotated] = await withDependencyBlockReasons([
      issue("Foo/Repo", 10, "requires bar/repo#20"),
    ]);

    expect(annotated.dependencyBlockReason).toBe("Blocked by open bar/repo#20");
  });

  it("ignores self-references", async () => {
    mocks.findManyIssues.mockResolvedValue([openRow("foo/repo", 10)]);

    const [annotated] = await withDependencyBlockReasons([issue("foo/repo", 10, "depends on #10")]);

    expect(annotated.dependencyBlockReason).toBeNull();
  });

  it("skips the lookup when no issue declares a dependency", async () => {
    const annotated = await withDependencyBlockReasons([
      issue("foo/repo", 1, null),
      issue("foo/repo", 2, "plain body"),
    ]);

    expect(annotated.map((i) => i.dependencyBlockReason)).toEqual([null, null]);
    expect(mocks.findManyIssues).not.toHaveBeenCalled();
  });

  it("does not annotate closed issues", async () => {
    const [annotated] = await withDependencyBlockReasons([
      issue("foo/repo", 10, "depends on #20", "closed"),
    ]);

    expect(annotated.dependencyBlockReason).toBeNull();
    expect(mocks.findManyIssues).not.toHaveBeenCalled();
  });

  it("preserves the other issue fields and order", async () => {
    mocks.findManyIssues.mockResolvedValue([openRow("foo/repo", 20)]);
    const input = [issue("foo/repo", 11, null), issue("foo/repo", 10, "depends on #20")];

    const annotated = await withDependencyBlockReasons(input);

    expect(annotated.map((i) => i.id)).toEqual(["foo/repo#11", "foo/repo#10"]);
    expect(annotated[1]).toMatchObject({ ...input[1], dependencyBlockReason: "Blocked by open #20" });
  });
});

describe("withDependencyBlockReasons native blocked_by (issue #1086)", () => {
  const nativeIssue = (
    repo: string,
    number: number,
    body: string | null,
    nativeBlockedBy: string[],
    state = "open",
  ) => ({ id: `${repo}#${number}`, number, state, body, nativeBlockedBy, repository: { fullName: repo } });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findManyIssues.mockResolvedValue([]);
  });

  it("reports a same-repo native blocker", async () => {
    mocks.findManyIssues.mockResolvedValue([openRow("foo/repo", 20)]);

    const [annotated] = await withDependencyBlockReasons([
      nativeIssue("foo/repo", 10, null, ["foo/repo#20"]),
    ]);

    expect(annotated.dependencyBlockReason).toBe("Blocked by open #20");
  });

  it("reports a cross-repo native blocker under the same universe rule", async () => {
    mocks.findManyIssues.mockResolvedValue([openRow("bar/repo", 20)]);

    const [annotated] = await withDependencyBlockReasons([
      nativeIssue("foo/repo", 10, null, ["bar/repo#20"]),
    ]);

    expect(annotated.dependencyBlockReason).toBe("Blocked by open bar/repo#20");
  });

  it("returns null once the native blocker is closed", async () => {
    const [annotated] = await withDependencyBlockReasons([
      nativeIssue("foo/repo", 10, null, ["foo/repo#20"]),
    ]);

    expect(annotated.dependencyBlockReason).toBeNull();
  });

  it("skips the lookup when no issue declares a dependency", async () => {
    const annotated = await withDependencyBlockReasons([
      nativeIssue("foo/repo", 10, null, []),
    ]);

    expect(annotated.map((i) => i.dependencyBlockReason)).toEqual([null]);
    expect(mocks.findManyIssues).not.toHaveBeenCalled();
  });
});
