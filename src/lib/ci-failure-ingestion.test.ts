import { describe, expect, it } from "vitest";
import {
  buildCloseComment,
  buildFailureMarker,
  buildIssueDraft,
  classifyWorkflow,
  computeFailureSignature,
  decideAction,
  extractFailureMarker,
  extractFailureWorkflow,
  groupDefaultBranchRuns,
  hasOpenIssueForSignature,
  isScanFailure,
  parseScanFindings,
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

  it("separates different workflows and repos", () => {
    expect(computeFailureSignature({ ...base, workflowName: "Nightly" })).not.toBe(
      computeFailureSignature(base),
    );
    expect(computeFailureSignature({ ...base, repoFullName: "o/other" })).not.toBe(
      computeFailureSignature(base),
    );
  });

  it("merges different jobs of the same workflow with the same error (#986)", () => {
    // One root cause surfaces as several jobs — a per-arch matrix leg, a scan
    // step and a build step — and each leg used to hash to its own signature,
    // so one break filed N issues that never merged. The job name is no
    // longer part of the key; the normalised error text still separates
    // genuinely different failures.
    const scan = computeFailureSignature({
      ...base,
      jobName: "Vulnerability Scan (elixir-gate)",
      logExcerpt: "error: invalid bake override key *.provenance=false",
    });
    const buildAmd = computeFailureSignature({
      ...base,
      jobName: "Build llmkube-coder / Build (linux/amd64)",
      logExcerpt: "error: invalid bake override key *.provenance=false",
    });
    const buildArm = computeFailureSignature({
      ...base,
      jobName: "Build elixir-gate / Build (linux/arm64)",
      logExcerpt: "error: invalid bake override key *.provenance=false",
    });
    expect(scan).toBe(buildAmd);
    expect(buildAmd).toBe(buildArm);
  });

  it("separates genuinely different errors", () => {
    expect(computeFailureSignature({ ...base, logExcerpt: "permission denied" })).not.toBe(
      computeFailureSignature(base),
    );
  });

  it("ignores per-run UUIDs so a recurring failure keeps one signature (#977)", () => {
    // A GitHub Actions temp id: the <hex> rule catches the 8/12-char groups but
    // not the 4-char middle groups, so without a UUID rule these differ every run.
    const a = computeFailureSignature({
      ...base,
      logExcerpt: "run _temp/50c3e0f1-ccb3-450b-8c9a-1881217bbe76 failed",
    });
    const b = computeFailureSignature({
      ...base,
      logExcerpt: "run _temp/eace82d5-188d-40ff-b14c-e4f47a4da97e failed",
    });
    expect(a).toBe(b);
  });

  it("ignores per-run mktemp basenames under a temp root (#977)", () => {
    // grype installs into a fresh mktemp dir every run; only the basename varies.
    const a = computeFailureSignature({
      ...base,
      logExcerpt: "Downloaded to /tmp/grype-download-bgjrFs/grype via /tmp/tmp.wVcSzQXwsN",
    });
    const b = computeFailureSignature({
      ...base,
      logExcerpt: "Downloaded to /tmp/grype-download-tRNd9b/grype via /tmp/tmp.L04KwwRRIg",
    });
    expect(a).toBe(b);
  });

  it("still distinguishes failures that differ beyond ephemeral paths (#977)", () => {
    // The temp-path normalisation must not collapse two different failures: a
    // stable trailing segment and the surrounding message still separate them.
    const a = computeFailureSignature({
      ...base,
      logExcerpt: "CVE-2026-1 in openssl at /tmp/scan-XXXX/report",
    });
    const b = computeFailureSignature({
      ...base,
      logExcerpt: "CVE-2026-2 in zlib at /tmp/scan-XXXX/report",
    });
    expect(a).not.toBe(b);
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

  it("does not call a green after a red healthy — that is flapping", () => {
    // The close rule must be symmetric with the file rule: one green after a
    // red is as weak a signal as one red after a green.
    const s = classifyWorkflow({
      workflowName: "Release",
      runs: [run({ id: 3, conclusion: "success" }), run({ id: 2 })],
    });
    expect(s.kind).toBe("flapping");
  });

  it("calls two greens in a row healthy", () => {
    const s = classifyWorkflow({
      workflowName: "Release",
      runs: [
        run({ id: 3, conclusion: "success" }),
        run({ id: 2, conclusion: "success" }),
      ],
    });
    expect(s.kind).toBe("healthy");
  });

  it("does not call a green after a non-failure flapping", () => {
    // A green after a cancelled/skipped run is not a red-then-green flap; it
    // is just green.
    for (const conclusion of ["cancelled", "skipped", "neutral", "timed_out"]) {
      const s = classifyWorkflow({
        workflowName: "Release",
        runs: [run({ id: 3, conclusion: "success" }), run({ id: 2, conclusion })],
      });
      expect(s.kind).toBe("healthy");
    }
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
  const flapping = classifyWorkflow({
    workflowName: "Release",
    runs: [run({ id: 3, conclusion: "success" }), run({ id: 2 })],
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

  it("does not close on a green after a red, even with an issue open", () => {
    // The flapping case: a workflow that alternates red/green must not be
    // closed on every green, or the next red refiles it and the pair loops.
    const filed: FiledIssue[] = [{ number: 7, state: "open", signature: "sig1" }];
    expect(decideAction(flapping, null, filed)).toMatchObject({ action: "none" });
  });

  it("does nothing on a green after a red with nothing open", () => {
    expect(decideAction(flapping, null, [])).toMatchObject({ action: "none" });
  });

  it("closes an open issue when the workflow goes green", () => {
    const filed: FiledIssue[] = [
      { number: 7, state: "open", signature: "sig1", workflowName: "Release" },
    ];
    expect(decideAction(healthy, null, filed, "Release")).toEqual({
      action: "close",
      issueNumber: 7,
      signature: "sig1",
    });
  });

  it("closes an open issue even if the current signature differs", () => {
    // Green means no failure of this workflow is outstanding, whatever the
    // open issue was originally about — but it must still be THIS workflow's
    // issue (#956).
    const filed: FiledIssue[] = [
      { number: 7, state: "open", signature: "old", workflowName: "Release" },
    ];
    expect(decideAction(healthy, "new", filed, "Release")).toMatchObject({
      action: "close",
      issueNumber: 7,
    });
  });

  it("does nothing when green with nothing open", () => {
    expect(decideAction(healthy, null, [])).toMatchObject({ action: "none" });
  });

  it("does nothing without a signature", () => {
    expect(decideAction(repeated, null, [])).toMatchObject({ action: "none" });
  });
});

describe("cross-workflow closing (#956)", () => {
  const healthy = classifyWorkflow({
    workflowName: "Release",
    runs: [run({ id: 3, conclusion: "success" }), run({ id: 2, conclusion: "success" })],
  });

  it("does not close another workflow's issue when this one goes green", () => {
    // The bug: `filed` is repo-wide, so a green Release closed a still-failing
    // Vulnerability Scan issue, which refiled next pass and closed on the next
    // green — a loop at the sync interval.
    const filed: FiledIssue[] = [
      { number: 7, state: "open", signature: "sig-vuln", workflowName: "Vulnerability Scan" },
    ];
    expect(decideAction(healthy, null, filed, "Release")).toMatchObject({ action: "none" });
  });

  it("closes its own workflow's issue", () => {
    const filed: FiledIssue[] = [
      { number: 7, state: "open", signature: "sig-vuln", workflowName: "Vulnerability Scan" },
      { number: 8, state: "open", signature: "sig-rel", workflowName: "Release" },
    ];
    expect(decideAction(healthy, null, filed, "Release")).toMatchObject({
      action: "close",
      issueNumber: 8,
    });
  });

  it("never closes an issue whose marker predates the workflow field", () => {
    // Leaking a stale issue is safer than closing a live one; a human closes
    // it once.
    const filed: FiledIssue[] = [
      { number: 7, state: "open", signature: "sig1", workflowName: null },
    ];
    expect(decideAction(healthy, null, filed, "Release")).toMatchObject({ action: "none" });
  });

  it("closes nothing when the caller supplies no workflow", () => {
    const filed: FiledIssue[] = [
      { number: 7, state: "open", signature: "sig1", workflowName: "Release" },
    ];
    expect(decideAction(healthy, null, filed)).toMatchObject({ action: "none" });
  });

  it("round-trips the workflow through the marker", () => {
    const marker = buildFailureMarker("abc123", "Vulnerability Scan");
    expect(extractFailureMarker(marker)).toBe("abc123");
    expect(extractFailureWorkflow(marker)).toBe("Vulnerability Scan");
  });

  it("survives a workflow name containing marker syntax", () => {
    const nasty = "weird --> :name\nwith newline";
    const marker = buildFailureMarker("abc123", nasty);
    expect(extractFailureMarker(marker)).toBe("abc123");
    expect(extractFailureWorkflow(marker)).toBe(nasty);
  });

  it("reads a legacy marker with no workflow as null", () => {
    expect(extractFailureMarker("<!-- dispatch-ci-failure:abc123 -->")).toBe("abc123");
    expect(extractFailureWorkflow("<!-- dispatch-ci-failure:abc123 -->")).toBeNull();
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

describe("parseScanFindings", () => {
  // A real grype table as it appears in a job log (grype table output,
  // --fail-on high gate): the header row, a separator row, and data rows.
  const grypeLog = [
    "  [command]/usr/bin/grype image ghcr.io/o/elixir-gate:latest --fail-on high",
    "  [grype] ",
    "  [grype] NAME            VERSION              FIX VERSION  VULNERABILITY  SEVERITY  LOCATION",
    "  [grype] ───────────────  ───────────────────  ───────────  ─────────────  ────────  ────────",
    "  [grype] pebble          0.10.0               0.10.1       CVE-2026-1234  High      /usr/bin/pebble",
    "  [grype] node            20.11.0              20.12.0      CVE-2026-5678  High      /usr/lib/node_modules/npm/node_modules/semver",
    "  [grype] openssl         3.0.13-1~deb12u1     3.0.14-1~deb12u2  CVE-2026-9012  High  /usr/lib/x86_64-linux-gnu/libssl.so.3",
    "  [grype] ",
    "  [grype] 3 vulnerabilities found",
    "  [grype] ",
    "  [command]exit code: 1",
    "  Error: Process completed with exit code 1.",
  ].join("\n");

  it("parses a real grype table into structured findings", () => {
    const findings = parseScanFindings(grypeLog);
    expect(findings).toHaveLength(3);
    expect(findings[0]).toEqual({
      package: "pebble",
      installed: "0.10.0",
      fixedIn: "0.10.1",
      severity: "High",
      location: "/usr/bin/pebble",
    });
    expect(findings[1].location).toBe(
      "/usr/lib/node_modules/npm/node_modules/semver",
    );
    expect(findings[2]).toMatchObject({
      package: "openssl",
      fixedIn: "3.0.14-1~deb12u2",
      severity: "High",
    });
  });

  it("returns [] for a log with no findings table", () => {
    expect(parseScanFindings("error: invalid bake override key *.provenance=false")).toEqual([]);
    expect(parseScanFindings("")).toEqual([]);
  });

  it("handles a trivy-style table with a Target column", () => {
    const trivyLog = [
      "NAME          VERSION     FIXED VERSION  VULNERABILITY  SEVERITY  TARGET",
      "────────────  ─────────  ─────────────  ─────────────  ────────  ──────",
      "golang.org/x/net  v0.17.0  v0.23.0      CVE-2024-45338  High      /usr/local/bin/pebble",
    ].join("\n");
    const findings = parseScanFindings(trivyLog);
    expect(findings).toEqual([
      {
        package: "golang.org/x/net",
        installed: "v0.17.0",
        fixedIn: "v0.23.0",
        severity: "High",
        location: "/usr/local/bin/pebble",
      },
    ]);
  });
});

describe("isScanFailure", () => {
  it("is true for a scan-named workflow or job", () => {
    expect(isScanFailure("Vulnerability Scan", "Scan", "")).toBe(true);
    expect(isScanFailure("Release", "trivy image scan", "")).toBe(true);
  });

  it("is true when the log carries a findings table even if unnamed", () => {
    const log =
      "NAME  VERSION  FIX VERSION  SEVERITY\npebble  0.10.0  0.10.1  High";
    expect(isScanFailure("Release", "Build", log)).toBe(true);
  });

  it("is false for a non-scan failure", () => {
    expect(isScanFailure("Release", "Build", "error: invalid bake override key")).toBe(false);
  });
});

describe("buildIssueDraft scan enrichment (#994)", () => {
  const scanOpts = {
    repoFullName: "o/r",
    workflowName: "Vulnerability Scan",
    jobName: "Scan (elixir-gate)",
    signature: "sig1",
    latest: run({ id: 3, html_url: "https://example.test/3" }),
    previous: run({ id: 2, html_url: "https://example.test/2" }),
    logExcerpt: [
      "NAME            VERSION              FIX VERSION  VULNERABILITY  SEVERITY  LOCATION",
      "──────────────  ───────────────────  ───────────  ─────────────  ────────  ────────",
      "pebble          0.10.0               0.10.1       CVE-2026-1234  High      /usr/bin/pebble",
      "node            20.11.0              20.12.0      CVE-2026-5678  High      /usr/lib/node_modules/npm/node_modules/semver",
      "",
      "3 vulnerabilities found",
      "Error: Process completed with exit code 1.",
    ].join("\n"),
    supersedes: null,
  };

  it("renders a findings table above the raw excerpt", () => {
    const d = buildIssueDraft(scanOpts);
    expect(d.body).toContain("**Scan findings (2):**");
    expect(d.body).toContain(
      "| pebble | 0.10.0 | 0.10.1 | High | /usr/bin/pebble |",
    );
    expect(d.body).toContain(
      "| node | 20.11.0 | 20.12.0 | High | /usr/lib/node_modules/npm/node_modules/semver |",
    );
    // The findings table comes before the raw excerpt.
    expect(d.body.indexOf("**Scan findings")).toBeLessThan(d.body.indexOf("```"));
    // The raw excerpt is still embedded.
    expect(d.body).toContain("3 vulnerabilities found");
    expect(extractFailureMarker(d.body)).toBe("sig1");
  });

  it("leaves a non-scan failure unchanged (raw excerpt only)", () => {
    const d = buildIssueDraft({
      ...scanOpts,
      workflowName: "Release",
      jobName: "Build",
      logExcerpt: "error: invalid bake override key *.provenance=false",
    });
    expect(d.body).not.toContain("Scan findings");
    expect(d.body).toContain("error: invalid bake override key");
  });

  it("caps the rendered findings when a scan reports many", () => {
    const rows = Array.from({ length: 80 }, (_, i) =>
      `pkg${i}  1.0.${i}  1.0.${i + 1}  High  /bin/pkg${i}`,
    ).join("\n");
    const d = buildIssueDraft({
      ...scanOpts,
      logExcerpt: `NAME  VERSION  FIX VERSION  SEVERITY  LOCATION\n${rows}`,
    });
    expect(d.body).toContain("**Scan findings (80, showing first 50):**");
    expect(d.body).toContain("| pkg49 |");
    expect(d.body).not.toContain("| pkg50 |");
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

describe("alternating red/green workflow (#953)", () => {
  // Simulate the sync loop over a sequence of sync passes. Each pass sees the
  // workflow's recent runs (newest first), classifies, decides, and applies the
  // action to the local `filed` view exactly like the route does. The signature
  // is held constant because the workflow fails for the same reason every time.
  function simulatePasses(
    timeline: ("success" | "failure")[],
    historyWindow = 5,
  ): { filed: FiledIssue[]; actions: string[] } {
    const filed: FiledIssue[] = [];
    const actions: string[] = [];
    let nextNumber = 1;
    for (let i = 0; i < timeline.length; i++) {
      // The most recent i+1 runs, newest first, capped to the window.
      const recent = timeline
        .slice(0, i + 1)
        .reverse()
        .slice(0, historyWindow)
        .map((conclusion, idx) => run({ id: i + 1 - idx, conclusion }));
      const state = classifyWorkflow({ workflowName: "Release", runs: recent });
      const signature = state.kind === "repeated-failure" ? "sig1" : null;
      const action = decideAction(state, signature, filed, "Release");
      actions.push(
        action.action === "file" ? `file#${action.supersedes ?? "none"}` : action.action,
      );
      if (action.action === "close") {
        const target = filed.find((f) => f.number === action.issueNumber);
        if (target) target.state = "closed";
      } else if (action.action === "file") {
        filed.push({
          number: nextNumber++,
          state: "open",
          signature: action.signature,
          workflowName: "Release",
        });
      }
    }
    return { filed, actions };
  }

  it("files at most one issue over several alternating passes", () => {
    // red, red (file), green (flap), red (first), red (already filed), green
    // (flap), red (first), red (already filed), green (flap).
    const timeline: ("success" | "failure")[] = [
      "failure", "failure", "success", "failure", "failure", "success",
      "failure", "failure", "success",
    ];
    const { filed, actions } = simulatePasses(timeline);
    expect(filed).toHaveLength(1);
    expect(filed[0].state).toBe("open");
    // No pass ever closed the one issue that was filed.
    expect(actions).not.toContain("close");
  });

  it("still closes a genuinely resolved failure after two greens", () => {
    // red, red (file), green (flap), green (healthy → close).
    const timeline: ("success" | "failure")[] = [
      "failure", "failure", "success", "success",
    ];
    const { filed, actions } = simulatePasses(timeline);
    expect(filed).toHaveLength(1);
    expect(filed[0].state).toBe("closed");
    expect(actions).toContain("close");
  });

  it("refiles with the supersedes link when a fixed failure returns", () => {
    // red, red (file #1), green, green (close #1), red, red (re-file #2 → #1).
    const timeline: ("success" | "failure")[] = [
      "failure", "failure", "success", "success", "failure", "failure",
    ];
    const { filed, actions } = simulatePasses(timeline);
    expect(filed).toHaveLength(2);
    expect(filed[0]).toMatchObject({ number: 1, state: "closed", signature: "sig1" });
    expect(filed[1]).toMatchObject({ number: 2, state: "open", signature: "sig1" });
    expect(actions).toContain("close");
    expect(actions).toContain("file#1");
  });
});

describe("hasOpenIssueForSignature", () => {
  // The guard the sync applies against a fresh listing immediately before
  // creating an issue (dispatch#961). Narrow on purpose: it answers only
  // "would this be a duplicate".
  it("finds an open issue with the same signature", () => {
    const filed: FiledIssue[] = [{ number: 378, state: "open", signature: "sig1" }];
    expect(hasOpenIssueForSignature(filed, "sig1")).toBe(378);
  });

  it("ignores a closed issue with the same signature", () => {
    // A closed issue for this signature means the fix did not hold, which is a
    // refile, not a duplicate — decideAction owns that call.
    const filed: FiledIssue[] = [{ number: 378, state: "closed", signature: "sig1" }];
    expect(hasOpenIssueForSignature(filed, "sig1")).toBeNull();
  });

  it("ignores an open issue with a different signature", () => {
    const filed: FiledIssue[] = [{ number: 378, state: "open", signature: "other" }];
    expect(hasOpenIssueForSignature(filed, "sig1")).toBeNull();
  });

  it("is null on an empty listing", () => {
    expect(hasOpenIssueForSignature([], "sig1")).toBeNull();
  });

  it("does not care which workflow the open issue belongs to", () => {
    // Signature already encodes repo + workflow + normalised excerpt, so
    // an identical signature is the same failure whatever the marker says.
    const filed: FiledIssue[] = [
      { number: 378, state: "open", signature: "sig1", workflowName: "Vulnerability Scan" },
    ];
    expect(hasOpenIssueForSignature(filed, "sig1")).toBe(378);
  });
});
