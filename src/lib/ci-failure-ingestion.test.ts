import { describe, expect, it } from "vitest";
import {
  buildCloseComment,
  buildFailureMarker,
  buildIssueDraft,
  classifyWorkflow,
  computeFailureSignature,
  decideAction,
  extractFailureMarker,
  groupDefaultBranchRuns,
  type CiRun,
  type FiledIssue,
} from "./ci-failure-ingestion";

function run(over: Partial<CiRun> = {}): CiRun {
  return {
    id: 1,
    name: "Release",
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: "deadbeefcafe",
    html_url: "https://example.test/run/1",
    updated_at: "2026-09-04T02:00:00Z",
    ...over,
  };
}

describe("computeFailureSignature", () => {
  const base = {
    repoFullName: "o/r",
    workflowName: "Release",
    jobName: "Build",
    logExcerpt: "error: openssl 3.5.5-1ubuntu3.3 is vulnerable",
  };

  it("is stable for the same failure", () => {
    expect(computeFailureSignature(base)).toBe(computeFailureSignature({ ...base }));
  });

  it("ignores run-specific noise so consecutive failures match", () => {
    // Without normalisation these differ every run and nothing is ever filed,
    // because no two failures ever look consecutive.
    const a = computeFailureSignature({
      ...base,
      logExcerpt: "2026-09-04T02:00:00Z run 33830329465 failed after 66.4s sha256:abc123def456",
    });
    const b = computeFailureSignature({
      ...base,
      logExcerpt: "2026-09-05T09:13:11Z run 33999111222 failed after 71.2s sha256:fff999eee888",
    });
    expect(a).toBe(b);
  });

  it("separates different jobs, workflows and repos", () => {
    expect(computeFailureSignature({ ...base, jobName: "Test" })).not.toBe(
      computeFailureSignature(base),
    );
    expect(computeFailureSignature({ ...base, workflowName: "Nightly" })).not.toBe(
      computeFailureSignature(base),
    );
    expect(computeFailureSignature({ ...base, repoFullName: "o/other" })).not.toBe(
      computeFailureSignature(base),
    );
  });

  it("separates genuinely different errors", () => {
    expect(computeFailureSignature({ ...base, logExcerpt: "permission denied" })).not.toBe(
      computeFailureSignature(base),
    );
  });
});

describe("failure marker", () => {
  it("round-trips", () => {
    expect(extractFailureMarker(`body\n${buildFailureMarker("abc123")}`)).toBe("abc123");
  });

  it("returns null for a body without one", () => {
    expect(extractFailureMarker("just an issue")).toBeNull();
    expect(extractFailureMarker(null)).toBeNull();
    expect(extractFailureMarker(undefined)).toBeNull();
  });
});

describe("groupDefaultBranchRuns", () => {
  it("keeps only completed runs on the default branch", () => {
    const grouped = groupDefaultBranchRuns(
      [
        run({ id: 1 }),
        run({ id: 2, head_branch: "feature" }),
        run({ id: 3, status: "in_progress", conclusion: null }),
        run({ id: 4, name: "Other" }),
      ],
      "main",
    );
    expect(grouped.map((g) => g.workflowName).sort()).toEqual(["Other", "Release"]);
    expect(grouped.find((g) => g.workflowName === "Release")!.runs).toHaveLength(1);
  });

  it("orders each workflow newest first", () => {
    const grouped = groupDefaultBranchRuns(
      [
        run({ id: 1, updated_at: "2026-09-01T00:00:00Z" }),
        run({ id: 2, updated_at: "2026-09-04T00:00:00Z" }),
        run({ id: 3, updated_at: "2026-09-02T00:00:00Z" }),
      ],
      "main",
    );
    expect(grouped[0].runs.map((r) => r.id)).toEqual([2, 3, 1]);
  });
});

describe("classifyWorkflow", () => {
  it("calls a single failure a first failure", () => {
    const s = classifyWorkflow({ workflowName: "Release", runs: [run({ id: 2 })] });
    expect(s.kind).toBe("first-failure");
  });

  it("calls two failures in a row repeated", () => {
    const s = classifyWorkflow({
      workflowName: "Release",
      runs: [run({ id: 3 }), run({ id: 2 })],
    });
    expect(s.kind).toBe("repeated-failure");
  });

  it("does not call a failure after a success repeated", () => {
    const s = classifyWorkflow({
      workflowName: "Release",
      runs: [run({ id: 3 }), run({ id: 2, conclusion: "success" })],
    });
    expect(s.kind).toBe("first-failure");
  });

  it("reports green", () => {
    const s = classifyWorkflow({
      workflowName: "Release",
      runs: [run({ id: 3, conclusion: "success" })],
    });
    expect(s.kind).toBe("healthy");
  });

  it("treats cancelled and skipped as unknown, not failure", () => {
    for (const conclusion of ["cancelled", "skipped", "neutral", "timed_out"]) {
      const s = classifyWorkflow({ workflowName: "R", runs: [run({ conclusion })] });
      expect(s.kind).toBe("unknown");
    }
  });

  it("reports unknown with no history", () => {
    expect(classifyWorkflow({ workflowName: "R", runs: [] }).kind).toBe("unknown");
  });
});

describe("decideAction", () => {
  const repeated = classifyWorkflow({
    workflowName: "Release",
    runs: [run({ id: 3 }), run({ id: 2 })],
  });
  const healthy = classifyWorkflow({
    workflowName: "Release",
    runs: [run({ id: 3, conclusion: "success" })],
  });

  it("files on a repeated failure with nothing open", () => {
    expect(decideAction(repeated, "sig1", [])).toEqual({
      action: "file",
      signature: "sig1",
      supersedes: null,
    });
  });

  it("does not file twice for the same signature", () => {
    const filed: FiledIssue[] = [{ number: 7, state: "open", signature: "sig1" }];
    expect(decideAction(repeated, "sig1", filed)).toEqual({
      action: "none",
      reason: "already filed as #7",
    });
  });

  it("files fresh and links the old one when a closed failure returns", () => {
    const filed: FiledIssue[] = [{ number: 7, state: "closed", signature: "sig1" }];
    expect(decideAction(repeated, "sig1", filed)).toEqual({
      action: "file",
      signature: "sig1",
      supersedes: 7,
    });
  });

  it("files when an open issue exists for a different failure of the same workflow", () => {
    const filed: FiledIssue[] = [{ number: 7, state: "open", signature: "other" }];
    expect(decideAction(repeated, "sig1", filed)).toMatchObject({ action: "file" });
  });

  it("never files on a first failure", () => {
    const first = classifyWorkflow({ workflowName: "Release", runs: [run({ id: 3 })] });
    expect(decideAction(first, "sig1", [])).toMatchObject({ action: "none" });
  });

  it("closes an open issue when the workflow goes green", () => {
    const filed: FiledIssue[] = [{ number: 7, state: "open", signature: "sig1" }];
    expect(decideAction(healthy, null, filed)).toEqual({
      action: "close",
      issueNumber: 7,
      signature: "sig1",
    });
  });

  it("closes an open issue even if the current signature differs", () => {
    // Green means no failure of this workflow is outstanding, whatever the
    // open issue was originally about.
    const filed: FiledIssue[] = [{ number: 7, state: "open", signature: "old" }];
    expect(decideAction(healthy, "new", filed)).toMatchObject({ action: "close", issueNumber: 7 });
  });

  it("does nothing when green with nothing open", () => {
    expect(decideAction(healthy, null, [])).toMatchObject({ action: "none" });
  });

  it("does nothing without a signature", () => {
    expect(decideAction(repeated, null, [])).toMatchObject({ action: "none" });
  });
});

describe("buildIssueDraft", () => {
  const opts = {
    repoFullName: "o/r",
    workflowName: "Release",
    jobName: "Vulnerability Scan",
    signature: "sig1",
    latest: run({ id: 3, html_url: "https://example.test/3" }),
    previous: run({ id: 2, html_url: "https://example.test/2" }),
    logExcerpt: "openssl 3.5.5-1ubuntu3.3 fixed in 3.5.5-1ubuntu3.4",
    supersedes: null,
  };

  it("names both runs, the job, and carries the marker", () => {
    const d = buildIssueDraft(opts);
    expect(d.title).toContain("Release");
    expect(d.title).toContain("Vulnerability Scan");
    expect(d.body).toContain("https://example.test/3");
    expect(d.body).toContain("https://example.test/2");
    expect(d.body).toContain("openssl 3.5.5-1ubuntu3.3");
    expect(extractFailureMarker(d.body)).toBe("sig1");
  });

  it("says why a single red run was not filed", () => {
    expect(buildIssueDraft(opts).body).toContain("A single red run is not filed");
  });

  it("links the superseded issue when the failure returned", () => {
    const d = buildIssueDraft({ ...opts, supersedes: 7 });
    expect(d.body).toContain("#7");
    expect(d.body).toContain("did not hold");
  });

  it("tolerates a missing log excerpt", () => {
    const d = buildIssueDraft({ ...opts, logExcerpt: "" });
    expect(d.body).toContain("(no log excerpt available)");
  });

  it("caps a huge excerpt", () => {
    const d = buildIssueDraft({ ...opts, logExcerpt: "x".repeat(50_000) });
    expect(d.body.length).toBeLessThan(6_000);
  });
});

describe("buildCloseComment", () => {
  it("names the run that cleared it", () => {
    const c = buildCloseComment(run({ conclusion: "success", html_url: "https://example.test/9" }));
    expect(c).toContain("https://example.test/9");
    expect(c).toContain("green again");
    expect(c).toContain("a fresh issue is filed");
  });
});
