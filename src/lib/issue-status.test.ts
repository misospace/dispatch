import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github", () => ({
  addIssueLabel: vi.fn(),
  removeIssueLabel: vi.fn(),
}));

import { addIssueLabel, removeIssueLabel } from "@/lib/github";

import { transitionIssueStatus } from "./issue-status";

const addIssueLabelMock = addIssueLabel as ReturnType<typeof vi.fn>;
const removeIssueLabelMock = removeIssueLabel as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  addIssueLabelMock.mockResolvedValue(undefined);
  removeIssueLabelMock.mockResolvedValue(undefined);
});

describe("transitionIssueStatus", () => {
  it("removes every existing status/* label and adds the target when the issue carries two stale status labels", async () => {
    const currentLabels = [
      "status/backlog",
      "status/in-progress",
      "type/bug",
    ];

    const result = await transitionIssueStatus(
      "octocat/hello-world",
      42,
      currentLabels,
      "status/in-review",
    );

    // Both stale status labels must be removed — not just the first.
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(2);
    expect(removeIssueLabelMock).toHaveBeenCalledWith(
      "octocat/hello-world",
      42,
      "status/backlog",
    );
    expect(removeIssueLabelMock).toHaveBeenCalledWith(
      "octocat/hello-world",
      42,
      "status/in-progress",
    );

    // Only the target status label is added.
    expect(addIssueLabelMock).toHaveBeenCalledTimes(1);
    expect(addIssueLabelMock).toHaveBeenCalledWith(
      "octocat/hello-world",
      42,
      "status/in-review",
    );

    // The returned label set is the non-status labels plus the target —
    // exactly what the helper exists to guarantee against the multi-status
    // edge case the regression check is meant to catch.
    expect(result).toEqual(["type/bug", "status/in-review"]);
    expect(result.filter((l) => l.startsWith("status/"))).toEqual([
      "status/in-review",
    ]);
  });
});
