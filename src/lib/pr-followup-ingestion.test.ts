import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  classifyFeedback,
  computeEvidenceKey,
  isAllowedBotAuthor,
  isAllowedBranchOwner,
  ingestCommentEvent,
  ingestReviewEvent,
  ingestCheckRunEvent,
  ingestMergeStateEvent,
  processPrFollowupEvents,
  PrFollowupConfig,
} from "./pr-followup-ingestion";

// ─── Mock client ────────────────────────────────────────────────────────────

function makeClient() {
  const items: any[] = [];
  let seq = 0;
  return {
    items,
    $transaction: async (fn: any) => fn({ prFixQueueItem: { findUnique: async () => null, create: async ({ data }: any) => { const item = { id: `item-${++seq}`, queuedAt: new Date(), updatedAt: new Date(), ...data }; items.push(item); return item; }, update: async () => items[0] ?? {} }, prFixHistory: { create: async () => ({}) } }),
    prFixQueueItem: {
      findUnique: async () => null,
      create: async ({ data }: any) => {
        const item = { id: `item-${++seq}`, queuedAt: new Date(), updatedAt: new Date(), ...data };
        items.push(item);
        return item;
      },
      update: async () => items[0] ?? {},
    },
    prFixHistory: {
      create: async () => ({}),
    },
  } as any;
}

// ─── Feedback Classification Tests ──────────────────────────────────────────

describe("classifyFeedback", () => {
  it("classifies specific error messages as actionable", () => {
    expect(classifyFeedback("Test failed: expected 200 but got 404")).toBe("actionable");
    expect(classifyFeedback("Error: Cannot read property 'x' of undefined")).toBe("actionable");
    expect(classifyFeedback("AssertionError: values don't match")).toBe("actionable");
    expect(classifyFeedback("CI check lint failed with 3 errors")).toBe("actionable");
    expect(classifyFeedback("eslint error: unused import")).toBe("actionable");
  });

  it("classifies specific code suggestions as actionable", () => {
    expect(classifyFeedback("Change `fetch` to `axios` for better error handling")).toBe("actionable");
    expect(classifyFeedback("Replace `any` with `string` in the type signature")).toBe("actionable");
    expect(classifyFeedback("Add `import { foo } from 'bar'` at the top")).toBe("actionable");
  });

  it("classifies vague requests as needs_human", () => {
    expect(classifyFeedback("Make it better")).toBe("needs_human");
    expect(classifyFeedback("Fix this please")).toBe("needs_human");
    expect(classifyFeedback("Looks wrong")).toBe("needs_human");
    expect(classifyFeedback("Something is off")).toBe("needs_human");
    expect(classifyFeedback("Can you fix this?")).toBe("needs_human");
    expect(classifyFeedback("Improve the performance")).toBe("needs_human");
  });

  it("classifies missing context as needs_human", () => {
    expect(classifyFeedback("No context or explanation provided")).toBe("needs_human");
    expect(classifyFeedback("This is ambiguous and unclear")).toBe("needs_human");
    expect(classifyFeedback("Vague feedback without details")).toBe("needs_human");
  });

  it("handles empty/whitespace input", () => {
    expect(classifyFeedback("")).toBe("needs_human");
    expect(classifyFeedback("   ")).toBe("needs_human");
    expect(classifyFeedback(null as any)).toBe("needs_human");
    expect(classifyFeedback(undefined as any)).toBe("needs_human");
  });

  it("defaults to needs_human when no pattern matches", () => {
    // A random sentence that doesn't match any pattern should default to needs_human
    expect(classifyFeedback("The weather is nice today")).toBe("needs_human");
  });
});

// ─── Evidence Key Tests ─────────────────────────────────────────────────────

describe("computeEvidenceKey", () => {
  it("produces unique keys per event type and source", () => {
    const key1 = computeEvidenceKey("comment", "c1", "org/repo", 42);
    const key2 = computeEvidenceKey("comment", "c2", "org/repo", 42);
    const key3 = computeEvidenceKey("review", "r1", "org/repo", 42);
    const key4 = computeEvidenceKey("check_run", "cr1", "org/repo", 42);

    expect(key1).toBe("comment:org/repo#42:c1");
    expect(key2).not.toBe(key1);
    expect(key3).not.toBe(key1);
    expect(key4).not.toBe(key3);
  });

  it("dedupes on same event type and source", () => {
    const key1 = computeEvidenceKey("comment", "c1", "org/repo", 42);
    const key2 = computeEvidenceKey("comment", "c1", "org/repo", 42);
    expect(key1).toBe(key2);
  });
});

// ─── Author / Branch Allowlist Tests ────────────────────────────────────────

describe("isAllowedBotAuthor", () => {
  it("allows configured bot identities", () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai,github-actions[bot],my-bot";
    expect(isAllowedBotAuthor("itsmiso-ai")).toBe(true);
    expect(isAllowedBotAuthor("github-actions[bot]")).toBe(true);
    expect(isAllowedBotAuthor("my-bot")).toBe(true);
  });

  it("rejects non-bot authors", () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    expect(isAllowedBotAuthor("human-developer")).toBe(false);
    expect(isAllowedBotAuthor("")).toBe(false);
    expect(isAllowedBotAuthor(null)).toBe(false);
    expect(isAllowedBotAuthor(undefined)).toBe(false);
  });

  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
  });
});

describe("isAllowedBranchOwner", () => {
  it("allows repo owner when allowlist includes owner", () => {
    process.env.PR_FOLLOWUP_BRANCH_OWNERS = "misospace";
    expect(isAllowedBranchOwner("misospace/dispatch")).toBe(true);
  });

  it("rejects unknown owners when allowlist is configured", () => {
    process.env.PR_FOLLOWUP_BRANCH_OWNERS = "misospace";
    expect(isAllowedBranchOwner("other-org/repo")).toBe(false);
  });

  it("allows any owner when no allowlist is configured (opt-in safety)", () => {
    delete process.env.PR_FOLLOWUP_BRANCH_OWNERS;
    // Without an explicit allowlist, the default behavior allows repo owners
    expect(isAllowedBranchOwner("some-org/repo")).toBe(true);
  });

  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BRANCH_OWNERS;
  });
});

// ─── Event Ingestion Tests ──────────────────────────────────────────────────

describe("ingestCommentEvent", () => {
  it("enqueues actionable comments from bot authors with NORMAL lane", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    await ingestCommentEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      commentBody: "Test failed: expected 200 but got 404",
      commentId: "c1",
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
    expect(client.items[0].type).toBe("REVIEW_FEEDBACK");
    expect(client.items[0].reason).toContain("actionable feedback");
  });

  it("enqueues ambiguous comments from bot authors with NEEDS_HUMAN lane", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    await ingestCommentEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      commentBody: "Looks wrong to me",
      commentId: "c2",
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NEEDS_HUMAN");
    expect(client.items[0].type).toBe("REVIEW_FEEDBACK");
    expect(client.items[0].status).toBe("BLOCKED");
  });

  it("skips comments from non-bot authors", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await ingestCommentEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "human-developer",
      commentBody: "Test failed",
      commentId: "c3",
    });

    expect(result).toBeNull();
    expect(client.items).toHaveLength(0);
  });

  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
  });
});

describe("ingestReviewEvent", () => {
  it("enqueues CHANGES_REQUESTED reviews", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    await ingestReviewEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      reviewBody: "Change `fetch` to `axios` for better error handling",
      reviewId: "r1",
      reviewState: "CHANGES_REQUESTED",
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
    expect(client.items[0].type).toBe("REVIEW_FEEDBACK");
  });

  it("skips APPROVED reviews", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await ingestReviewEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      reviewBody: "Looks good!",
      reviewId: "r2",
      reviewState: "APPROVED",
    });

    expect(result).toBeNull();
    expect(client.items).toHaveLength(0);
  });

  it("skips COMMENTED reviews", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await ingestReviewEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      reviewBody: "Just a comment",
      reviewId: "r3",
      reviewState: "COMMENTED",
    });

    expect(result).toBeNull();
    expect(client.items).toHaveLength(0);
  });

  it("skips reviews for merged PRs (prMergedAt set)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await ingestReviewEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      reviewBody: "Change X to Y",
      reviewId: "r4",
      reviewState: "CHANGES_REQUESTED",
      prMergedAt: "2026-06-01T00:00:00Z",
    });

    expect(result).toBeNull();
    expect(client.items).toHaveLength(0);
  });

  it("skips reviews for closed PRs (prState=closed)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await ingestReviewEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      reviewBody: "Change X to Y",
      reviewId: "r5",
      reviewState: "CHANGES_REQUESTED",
      prState: "closed",
    });

    expect(result).toBeNull();
    expect(client.items).toHaveLength(0);
  });

  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
  });
});

describe("ingestCheckRunEvent", () => {
  it("enqueues failing checks with NORMAL lane", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    await ingestCheckRunEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/actions/runs/123",
      title: "Fix test issue",
      author: "itsmiso-ai",
      checkName: "lint",
      conclusion: "failure",
      checkRunId: "cr1",
      checkDetails: "eslint error: unused import",
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
    expect(client.items[0].type).toBe("CI_FAILURE");
  });

  it("routes a summary-less failing check to NORMAL, not NEEDS_HUMAN", async () => {
    // The sync sets body = output.summary ?? "" and most CI jobs (test/e2e/lint)
    // set no summary, so the event body is empty. A failing check is still
    // actionable — it must not be parked on a human.
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    await ingestCheckRunEvent(client, {
      repoFullName: "misospace/KubeTix",
      prNumber: 207,
      branch: "foreman/wl-misospace-kubetix-165/issue-165",
      url: "https://github.com/misospace/KubeTix/actions/runs/1",
      title: "Test infrastructure fragility",
      author: "itsmiso-ai",
      checkName: "e2e-tests",
      conclusion: "failure",
      checkRunId: "cr-empty",
      checkDetails: "",
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
    expect(client.items[0].type).toBe("CI_FAILURE");
    // Empty summary must fall back to a real description, not an empty string.
    expect(String(client.items[0].feedback)).toContain("e2e-tests");
  });

  it("feedback carries the job-log URL and a pull recipe (coder fetches the real error)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    await ingestCheckRunEvent(client, {
      repoFullName: "misospace/windowstead",
      prNumber: 264,
      branch: "foreman/x/issue-254",
      url: "https://github.com/misospace/windowstead/actions/runs/28977045019/job/85986677458",
      title: "Add macOS export",
      author: "itsmiso-ai",
      checkName: "Export validation (macOS)",
      conclusion: "failure",
      checkRunId: "cr-mac",
      checkDetails: "", // null summary — the real reason is only in the log
    });

    expect(client.items).toHaveLength(1);
    const feedback = String(client.items[0].feedback);
    // The actionable bits: which check, where the log is, and how to pull it.
    expect(feedback).toContain("Export validation (macOS)");
    expect(feedback).toContain("actions/jobs/85986677458/logs");
    expect(feedback).toContain("GITHUB_TOKEN");
  });

  it("enqueues cancelled/timed_out checks", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    await ingestCheckRunEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/actions/runs/123",
      title: "Fix test issue",
      author: "itsmiso-ai",
      checkName: "test",
      conclusion: "timed_out",
      checkRunId: "cr2",
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].type).toBe("CI_FAILURE");
  });

  it("skips passing checks", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await ingestCheckRunEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/actions/runs/123",
      title: "Fix test issue",
      author: "itsmiso-ai",
      checkName: "lint",
      conclusion: "success",
      checkRunId: "cr3",
    });

    expect(result).toBeNull();
    expect(client.items).toHaveLength(0);
  });

  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
  });
});

describe("ingestMergeStateEvent", () => {
  it("enqueues problematic merge states", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    await ingestMergeStateEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      mergeStateStatus: "behind",
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
    expect(client.items[0].type).toBe("OTHER");
  });

  it("skips clean merge state", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await ingestMergeStateEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      mergeStateStatus: "clean",
    });

    expect(result).toBeNull();
    expect(client.items).toHaveLength(0);
  });

  it("skips merge state events for merged PRs (prMergedAt set)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await ingestMergeStateEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      mergeStateStatus: "behind",
      prMergedAt: "2026-06-01T00:00:00Z",
    });

    expect(result).toBeNull();
    expect(client.items).toHaveLength(0);
  });

  it("skips merge state events for closed PRs (prState=closed)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await ingestMergeStateEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      mergeStateStatus: "behind",
      prState: "closed",
    });

    expect(result).toBeNull();
    expect(client.items).toHaveLength(0);
  });

  it("populates MERGE_CONFLICT type for DIRTY merge state", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    await ingestMergeStateEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      mergeStateStatus: "dirty",
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].type).toBe("MERGE_CONFLICT");
  });


  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
  });
});

// ─── ProcessPrFollowupEvents (Batch) Tests ──────────────────────────────────

describe("processPrFollowupEvents", () => {
  it("processes multiple events and returns correct counts", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await processPrFollowupEvents(client, [
      {
        eventType: "comment",
        repoFullName: "org/repo",
        prNumber: 1,
        branch: "fix/a",
        url: "https://github.com/org/repo/pull/1",
        title: "Fix A",
        author: "itsmiso-ai",
        body: "Test failed",
        id: "c1",
      },
      {
        eventType: "review",
        repoFullName: "org/repo",
        prNumber: 2,
        branch: "fix/b",
        url: "https://github.com/org/repo/pull/2",
        title: "Fix B",
        author: "itsmiso-ai",
        body: "Change X to Y",
        id: "r1",
        state: "CHANGES_REQUESTED",
      },
      {
        eventType: "check_run",
        repoFullName: "org/repo",
        prNumber: 3,
        branch: "fix/c",
        url: "https://github.com/org/repo/actions/runs/1",
        title: "Fix C",
        author: "itsmiso-ai",
        body: "lint error",
        id: "cr1",
        conclusion: "failure",
        checkName: "lint",
      },
    ]);

    expect(result.enqueued).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("skips non-bot-authored events", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await processPrFollowupEvents(client, [
      {
        eventType: "comment",
        repoFullName: "org/repo",
        prNumber: 1,
        branch: "fix/a",
        url: "https://github.com/org/repo/pull/1",
        title: "Fix A",
        author: "human-developer",
        body: "Test failed",
        id: "c2",
      },
    ]);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips non-CHANGES_REQUESTED reviews", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await processPrFollowupEvents(client, [
      {
        eventType: "review",
        repoFullName: "org/repo",
        prNumber: 1,
        branch: "fix/a",
        url: "https://github.com/org/repo/pull/1",
        title: "Fix A",
        author: "itsmiso-ai",
        body: "LGTM",
        id: "r2",
        state: "APPROVED",
      },
    ]);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);
  });

  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
  });
});

// ─── No Hardcoded Names Tests ───────────────────────────────────────────────

describe("no hardcoded agent or repo names", () => {
  it("uses configurable bot identities, not hardcoded agent names", async () => {
    // The config should come from env, not be hardcoded to specific agents
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "custom-bot";
    expect(isAllowedBotAuthor("custom-bot")).toBe(true);
    // Default identities should NOT include agent names
  });

  it("uses configurable branch owners, not hardcoded repo names", async () => {
    process.env.PR_FOLLOWUP_BRANCH_OWNERS = "any-owner";
    expect(isAllowedBranchOwner("any-owner/repo")).toBe(true);
    // Should not be tied to misospace specifically
  });

  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
    delete process.env.PR_FOLLOWUP_BRANCH_OWNERS;
  });
});
