import { describe, expect, it, vi } from "vitest";

import { prMergedDedupeKey, type LifecycleEventClient } from "./issue-lifecycle";
import { backfillMergesFromRunHistory } from "./lifecycle-backfill";

/**
 * Same in-memory stand-in as the lifecycle recorder's own tests: rows are
 * keyed by `dedupeKey` the way the real unique index is, so an upsert's
 * idempotency is observable here rather than asserted by hand.
 */
function makeClient() {
  const rows: Array<Record<string, any>> = [];
  const client: LifecycleEventClient = {
    issueLifecycleEvent: {
      create: vi.fn(async ({ data }) => {
        rows.push({ ...data });
        return data;
      }),
      upsert: vi.fn(async ({ where, create }) => {
        const existing = rows.find((row) => row.dedupeKey === where.dedupeKey);
        if (existing) return existing;
        rows.push({ ...create });
        return create;
      }),
    },
  };
  return { client, rows };
}

const base = {
  issueId: "issue-1",
  repoFullName: "octocat/hello-world",
  issueNumber: 42,
};

const pr7 = "https://github.com/octocat/hello-world/pull/7";
const issueUrl = "https://github.com/octocat/hello-world/issues/42";
const mergedAt = new Date("2026-10-01T12:00:00.000Z");

const run = (...touchedIssueUrls: string[]) => ({ touchedIssueUrls });
const mergedPr7 = { number: 7, url: pr7, mergedAt };

describe("backfillMergesFromRunHistory", () => {
  it("records a pr_merged event for a run-touched merged PR with the GitHub merge time", async () => {
    const { client, rows } = makeClient();

    const result = await backfillMergesFromRunHistory(client, {
      ...base,
      agentRuns: [run(pr7)],
      pullRequests: [mergedPr7],
    });

    expect(result).toEqual({ recorded: 1, skippedUnmerged: 0, skippedNoLink: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      issueId: "issue-1",
      repoFullName: "octocat/hello-world",
      issueNumber: 42,
      kind: "pr_merged",
      source: "backfill",
      actor: "lifecycle-backfill",
      dedupeKey: prMergedDedupeKey("octocat/hello-world", 42, 7, mergedAt),
    });
    expect(rows[0].occurredAt.getTime()).toBe(mergedAt.getTime());
    expect(rows[0].metadata).toEqual({
      pullRequestNumber: 7,
      pullRequestUrl: pr7,
      mergedAt: "2026-10-01T12:00:00.000Z",
      linkSource: "agent-run-touch",
      backfilled: true,
      mergeTimeSource: "github-pull-request-sync",
    });
  });

  it("never fabricates claim events or first-claim times", async () => {
    const { client, rows } = makeClient();

    await backfillMergesFromRunHistory(client, {
      ...base,
      agentRuns: [run(pr7)],
      pullRequests: [mergedPr7],
    });

    expect(rows.filter((row) => row.kind === "claim")).toHaveLength(0);
    expect(rows.every((row) => row.kind === "pr_merged")).toBe(true);
  });

  it("skips a run-touched PR with no authoritative mergedAt", async () => {
    const { client, rows } = makeClient();

    const result = await backfillMergesFromRunHistory(client, {
      ...base,
      agentRuns: [run(pr7)],
      pullRequests: [{ number: 7, url: pr7, mergedAt: null }],
    });

    expect(result).toEqual({ recorded: 0, skippedUnmerged: 1, skippedNoLink: 0 });
    expect(rows).toHaveLength(0);
  });

  it("skips a run-touched PR whose mergedAt string does not parse", async () => {
    const { client, rows } = makeClient();

    const result = await backfillMergesFromRunHistory(client, {
      ...base,
      agentRuns: [run(pr7)],
      pullRequests: [{ number: 7, url: pr7, mergedAt: "not-a-timestamp" }],
    });

    expect(result).toEqual({ recorded: 0, skippedUnmerged: 1, skippedNoLink: 0 });
    expect(rows).toHaveLength(0);
  });

  it("skips a merged PR that no run of the issue ever touched", async () => {
    const { client, rows } = makeClient();

    const result = await backfillMergesFromRunHistory(client, {
      ...base,
      agentRuns: [run(issueUrl)],
      pullRequests: [mergedPr7],
    });

    expect(result).toEqual({ recorded: 0, skippedUnmerged: 0, skippedNoLink: 1 });
    expect(rows).toHaveLength(0);
  });

  it("counts an unmerged PR no run touched in neither skip bucket", async () => {
    const { client, rows } = makeClient();

    const result = await backfillMergesFromRunHistory(client, {
      ...base,
      agentRuns: [run(issueUrl)],
      pullRequests: [{ number: 7, url: pr7, mergedAt: null }],
    });

    expect(result).toEqual({ recorded: 0, skippedUnmerged: 0, skippedNoLink: 0 });
    expect(rows).toHaveLength(0);
  });

  it("matches PR URLs up to whitespace and a trailing slash", async () => {
    const { client, rows } = makeClient();

    const result = await backfillMergesFromRunHistory(client, {
      ...base,
      agentRuns: [run(`  ${pr7}/ `)],
      pullRequests: [{ number: 7, url: `${pr7}/`, mergedAt }],
    });

    expect(result).toEqual({ recorded: 1, skippedUnmerged: 0, skippedNoLink: 0 });
    expect(rows).toHaveLength(1);
    // The recorded URL is the canonical html form, trailing slash gone.
    expect(rows[0].metadata.pullRequestUrl).toBe(pr7);
  });

  it("matches a worker-reported html URL against the API-form URL the sync persists", async () => {
    const { client, rows } = makeClient();

    const result = await backfillMergesFromRunHistory(client, {
      ...base,
      agentRuns: [run(pr7)],
      pullRequests: [
        { number: 7, url: "https://api.github.com/repos/octocat/hello-world/pulls/7", mergedAt },
      ],
    });

    expect(result).toEqual({ recorded: 1, skippedUnmerged: 0, skippedNoLink: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.pullRequestUrl).toBe(pr7);
  });

  it("does not match a same-number PR from a different repository", async () => {
    const { client, rows } = makeClient();

    const result = await backfillMergesFromRunHistory(client, {
      ...base,
      agentRuns: [run("https://github.com/other-owner/hello-world/pull/7")],
      pullRequests: [mergedPr7],
    });

    expect(result).toEqual({ recorded: 0, skippedUnmerged: 0, skippedNoLink: 1 });
    expect(rows).toHaveLength(0);
  });

  it("records one event when several runs of the issue touch the same PR", async () => {
    const { client, rows } = makeClient();

    const result = await backfillMergesFromRunHistory(client, {
      ...base,
      agentRuns: [run(pr7), run(pr7, issueUrl)],
      pullRequests: [mergedPr7],
    });

    expect(result).toEqual({ recorded: 1, skippedUnmerged: 0, skippedNoLink: 0 });
    expect(rows).toHaveLength(1);
  });

  it("collapses a repeated backfill onto one row without rewriting its provenance", async () => {
    const { client, rows } = makeClient();
    const input = {
      ...base,
      agentRuns: [run(pr7)],
      pullRequests: [mergedPr7],
    };

    await backfillMergesFromRunHistory(client, input);
    await backfillMergesFromRunHistory(client, input);

    expect(rows).toHaveLength(1);
    expect(client.issueLifecycleEvent.upsert).toHaveBeenCalledTimes(2);
    expect(rows[0].dedupeKey).toBe(prMergedDedupeKey("octocat/hello-world", 42, 7, mergedAt));
    expect(rows[0].actor).toBe("lifecycle-backfill");
    expect(rows[0].occurredAt.getTime()).toBe(mergedAt.getTime());
  });

  it("propagates a client failure without catching it per PR", async () => {
    const { client } = makeClient();
    vi.mocked(client.issueLifecycleEvent.upsert).mockRejectedValue(new Error("db down"));

    await expect(
      backfillMergesFromRunHistory(client, {
        ...base,
        agentRuns: [run(pr7)],
        pullRequests: [mergedPr7],
      }),
    ).rejects.toThrow("db down");
  });
});
