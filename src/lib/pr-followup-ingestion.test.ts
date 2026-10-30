import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { buildFailureMarker } from "./ci-failure-ingestion";
import { resetLaneConfig, setLaneConfig } from "./lane-config";
import {
  extractLinkedIssue,
  classifyFeedback,
  parseAiReviewerFindings,
  isInformationalComment,
  computeEvidenceKey,
  isAllowedBotAuthor,
  isAllowedBranchOwner,
  ingestCommentEvent,
  ingestReviewEvent,
  ingestReviewCommentEvent,
  ingestCheckRunEvent,
  ingestMergeStateEvent,
  ingestMergeConflict,
  clearResolvedConflictItems,
  processPrFollowupEvents,
  PrFollowupConfig,
} from "./pr-followup-ingestion";

// ─── Durable evidence-field capture (#1249) ──────────────────────────────────
//
// The follow-up ingestion path projects each event onto the ledger's
// evidence* block and hands it to enqueuePrFixItem. The new describe block
// below captures that hand-off payload. We mock ONLY the enqueuePrFixItem
// binding from pr-fix-queue, delegating to the real implementation so every
// pre-existing test in this file keeps its exact behavior; the mock just
// records the EnqueuePrFixInput each enqueue receives.
const evidenceEnqueueInputs = vi.hoisted(() => [] as any[]);

vi.mock("./pr-fix-queue", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pr-fix-queue")>();
  return {
    ...original,
    enqueuePrFixItem: async (client: any, input: any) => {
      evidenceEnqueueInputs.push(input);
      return (original.enqueuePrFixItem as any)(client, input);
    },
  };
});


// ─── Mock client ────────────────────────────────────────────────────────────

function makeClient(issue?: { body: string | null; currentLane: string | null } | null) {
  const items: any[] = [];
  let seq = 0;
  return {
    items,
    issue: {
      // The escalation-provenance lookup (#1503) must scope by repo AND
      // issue number; a regression that drops either predicate gets null
      // here instead of the fixture.
      findFirst: async ({ where }: any) =>
        where?.number != null && where?.repository?.fullName != null ? (issue ?? null) : null,
    },
    $transaction: async (fn: any) => fn({ issue: { findFirst: async () => issue }, prFixQueueItem: { findUnique: async () => null, create: async ({ data }: any) => { const item = { id: `item-${++seq}`, queuedAt: new Date(), updatedAt: new Date(), ...data }; items.push(item); return item; }, update: async () => items[0] ?? {} }, prFixHistory: { create: async () => ({}) } }),
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

// ─── AI-reviewer structured findings ────────────────────────────────────────

describe("parseAiReviewerFindings", () => {
  it("extracts the ai-pr-reviewer JSON payload from a review body", () => {
    const body = [
      "<!-- ai-pr-reviewer -->",
      `<!-- ai-pr-reviewer:${JSON.stringify({
        review_result: "issues",
        open_findings: [{ severity: "blocker", message: "no upgrade performed" }],
      })} -->`,
      "<!-- ai-pr-review-sha:deadbeef -->",
      "# AI Automated Review",
    ].join("\n");
    const parsed = parseAiReviewerFindings(body);
    expect(parsed?.review_result).toBe("issues");
    expect(parsed?.open_findings).toHaveLength(1);
    expect(parsed?.open_findings?.[0].message).toBe("no upgrade performed");
  });

  it("ignores the bare marker and sibling sha/fingerprint comments", () => {
    const body = [
      "<!-- ai-pr-reviewer -->",
      "<!-- ai-pr-review-sha:deadbeef -->",
      "<!-- ai-pr-review-fingerprint:abc123 -->",
    ].join("\n");
    expect(parseAiReviewerFindings(body)).toBeNull();
  });

  it("returns null for absent, empty, or malformed payloads", () => {
    expect(parseAiReviewerFindings(null)).toBeNull();
    expect(parseAiReviewerFindings("")).toBeNull();
    expect(parseAiReviewerFindings("no comment here")).toBeNull();
    expect(parseAiReviewerFindings("<!-- ai-pr-reviewer:{not json} -->")).toBeNull();
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

  it("rejects a missing repo name without throwing, with or without an allowlist", () => {
    delete process.env.PR_FOLLOWUP_BRANCH_OWNERS;
    expect(isAllowedBranchOwner(null)).toBe(false);
    expect(isAllowedBranchOwner(undefined)).toBe(false);
    expect(isAllowedBranchOwner("")).toBe(false);
    process.env.PR_FOLLOWUP_BRANCH_OWNERS = "misospace";
    expect(isAllowedBranchOwner(null)).toBe(false);
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
  });

  // #1503 (production regression: misospace/pr-reviewer-action#737 / PR 1359):
  // a CHANGES_REQUESTED review on a PR linked to a frontier-classified issue
  // must enqueue ESCALATED work, never NORMAL — the frontier lane is
  // exclusive, and the shared local/MiniMax queue must never receive it.
  it("enqueues a CHANGES_REQUESTED review on a frontier-linked issue as ESCALATED (#1503)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient({ body: "Concrete follow-up work.", currentLane: "frontier" });

    await ingestReviewEvent(client, {
      repoFullName: "misospace/pr-reviewer-action",
      prNumber: 1359,
      branch: "courier/x/issue-737",
      url: "https://github.com/misospace/pr-reviewer-action/pull/1359",
      title: "Fix test issue",
      author: "itsmiso-ai",
      reviewBody: "Restore the validate job; ci.yaml:20 does not catch duplicate keys.",
      reviewId: "r-5713818652",
      reviewState: "CHANGES_REQUESTED",
      linkedIssue: 737,
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("ESCALATED");
    expect(client.items[0].type).toBe("REVIEW_FEEDBACK");
    expect(client.items[0].issue).toBe(737);
  });

  it("keeps a CHANGES_REQUESTED review on a normal-lane issue in NORMAL (#1503)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient({ body: "Concrete follow-up work.", currentLane: "local" });

    await ingestReviewEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/pull/42",
      title: "Fix test issue",
      author: "itsmiso-ai",
      reviewBody: "Restore the validate job.",
      reviewId: "r-local",
      reviewState: "CHANGES_REQUESTED",
      linkedIssue: 100,
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
  });

  it("keeps the supplied lane when the parent classification is unverifiable (lookup fails, #1503)", async () => {
    // UNKNOWN parent (#1503 review): enqueue is an ingestion-side
    // convenience and may conservatively keep the supplied lane on an
    // unavailable lookup — the hand-out gate re-reads the parent at issuance
    // and fails closed there.
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient({ body: "Concrete follow-up work.", currentLane: "frontier" });
    client.issue.findFirst = async () => {
      throw new Error("db down");
    };
    await ingestReviewEvent(client, {
      repoFullName: "misospace/pr-reviewer-action",
      prNumber: 1360,
      branch: "courier/x/issue-737",
      url: "https://github.com/misospace/pr-reviewer-action/pull/1360",
      title: "Fix test issue",
      author: "itsmiso-ai",
      reviewBody: "Restore the validate job.",
      reviewId: "r-unknown-parent",
      reviewState: "CHANGES_REQUESTED",
      linkedIssue: 737,
    });
    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
  });

  it("does NOT enqueue an ambiguous comment (it no longer blocks the PR)", async () => {
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

    // Previously this enqueued as NEEDS_HUMAN/BLOCKED, so any unclassifiable
    // comment stopped the PR until a human intervened.
    expect(client.items).toHaveLength(0);
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

  it("routes an ai-pr-reviewer review with findings to NORMAL, not needs_human", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();
    // Narrative prose that matches no classifyFeedback pattern (as the
    // ai-pr-reviewer writes them), plus the structured findings it embeds.
    const body = [
      `<!-- ai-pr-reviewer:${JSON.stringify({
        review_result: "issues",
        open_findings: [
          { severity: "blocker", category: "bug", message: "PR does not satisfy the issue acceptance criteria: no package upgrade performed." },
          { severity: "major", category: "bug", file: "package.json", line: 38, message: "package.json still shows '^0.1.2' — no upgrade performed." },
        ],
      })} -->`,
      "# AI Automated Review",
      "## Review: Request Changes",
      "This PR only partially addresses the linked issue. It updates documentation but does not perform the actual package upgrade.",
    ].join("\n");

    // Guard: the prose (payload included) would otherwise dead-end at needs_human.
    expect(classifyFeedback(body)).toBe("needs_human");

    await ingestReviewEvent(client, {
      repoFullName: "misospace/miso-chat",
      prNumber: 691,
      branch: "foreman/wl-misospace-miso-chat-687/issue-687",
      url: "https://github.com/misospace/miso-chat/pull/691",
      title: "Verify passport-openidconnect is current",
      author: "itsmiso-ai",
      reviewBody: body,
      reviewId: "r-saffron",
      reviewState: "CHANGES_REQUESTED",
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
  });

  it("keeps the REBASE mechanical lane NORMAL even on a frontier-linked issue (#1503 exception)", async () => {
    // #1503 declares the mechanical rebase lane as the legitimate exception:
    // its exclusivity is the DISPATCH_REBASE_AGENTS local-only pool (#1327),
    // and raising a conflicted branch's lane would strand it with no worker
    // able to take it (escalation consumers do not run the rebase pool).
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient({ body: "Concrete work.", currentLane: "frontier" });

    await ingestMergeConflict(client, {
      repoFullName: "misospace/pr-reviewer-action",
      prNumber: 1359,
      branch: "courier/x/issue-737",
      url: "https://github.com/misospace/pr-reviewer-action/pull/1359",
      title: "Fix test issue",
      author: "itsmiso-ai",
      mergeable: "CONFLICTING",
      linkedIssue: 737,
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
    expect(client.items[0].type).toBe("REBASE");
  });
  // review and reports back; if it genuinely cannot act, PR_FIX_MAX_ATTEMPTS
  // escalates to NEEDS_HUMAN on evidence. Predicting unactionability with a
  // keyword list cost more than it saved — it dead-ended a detailed review with
  // file:line references (pr-reviewer-action#467) for 13 hours, while vague
  // reviews are cheap to attempt and the attempt itself is useful signal.
  it("routes a CHANGES_REQUESTED review with vague prose to the fix lane anyway", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();
    await ingestReviewEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 43,
      branch: "fix/x",
      url: "https://github.com/misospace/dispatch/pull/43",
      title: "Fix",
      author: "itsmiso-ai",
      reviewBody: "This looks wrong, please take another look.",
      reviewId: "r-human",
      reviewState: "CHANGES_REQUESTED",
    });
    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
  });

  it("routes an empty CHANGES_REQUESTED review to NEEDS_HUMAN", async () => {
    // Nothing to read means nothing to act on — the one case still worth routing
    // straight to a human rather than spending attempts on it.
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();
    await ingestReviewEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 44,
      branch: "fix/x",
      url: "https://github.com/misospace/dispatch/pull/44",
      title: "Fix",
      author: "itsmiso-ai",
      reviewBody: "   ",
      reviewId: "r-empty",
      reviewState: "CHANGES_REQUESTED",
    });
    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NEEDS_HUMAN");
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
  it("escalates a recurring scan failure linked to an escalated issue", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    setLaneConfig({
      lanes: [
        { id: "normal", title: "Normal", claimable: true, role: "default" },
        { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
      ],
    });
    const client = makeClient({
      body: buildFailureMarker("abc123", "Vulnerability Scan"),
      currentLane: "frontier",
    });

    await ingestCheckRunEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/actions/runs/123",
      title: "Fix test issue",
      author: "itsmiso-ai",
      checkName: "Vulnerability Scan",
      conclusion: "failure",
      checkRunId: "cr-scan",
      checkDetails: "found CVE-2026-1234",
      linkedIssue: 123,
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("ESCALATED");
    expect(client.items[0].type).toBe("CI_FAILURE");
    expect(client.items[0].issue).toBe(123);
    expect(client.items[0].feedback[0]).toBe(
      'Recurrence of scan failure filed as #123 (workflow Vulnerability Scan, signature abc123).\nCI check "Vulnerability Scan" failed (failure) on this PR.\n\nError from the job log:\nfound CVE-2026-1234\n\nFull log: https://github.com/misospace/dispatch/actions/runs/123\n\nFix the root cause the log shows.',
    );
  });

  it("keeps a marked issue on a non-escalation lane in NORMAL", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    setLaneConfig({
      lanes: [
        { id: "normal", title: "Normal", claimable: true, role: "default" },
        { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
      ],
    });
    const client = makeClient({ body: buildFailureMarker("abc123", "Vulnerability Scan"), currentLane: "normal" });

    await ingestCheckRunEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/actions/runs/123",
      title: "Fix test issue",
      author: "itsmiso-ai",
      checkName: "Vulnerability Scan",
      conclusion: "failure",
      checkRunId: "cr-non-escalated",
      checkDetails: "found CVE-2026-1234",
      linkedIssue: 123,
    });

    expect(client.items[0].lane).toBe("NORMAL");
    expect(client.items[0].feedback[0]).not.toContain("Recurrence of scan failure");
  });

  it("keeps a marked scan issue in NORMAL without an explicit escalation role", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    setLaneConfig({
      lanes: [{ id: "normal", title: "Normal", claimable: true, role: "default" }],
    });
    const client = makeClient({ body: buildFailureMarker("abc123", "Vulnerability Scan"), currentLane: "normal" });

    await ingestCheckRunEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/actions/runs/123",
      title: "Fix test issue",
      author: "itsmiso-ai",
      checkName: "Vulnerability Scan",
      conclusion: "failure",
      checkRunId: "cr-no-escalation-role",
      checkDetails: "found CVE-2026-1234",
      linkedIssue: 123,
    });

    expect(client.items[0].lane).toBe("NORMAL");
    expect(client.items[0].feedback[0]).not.toContain("Recurrence of scan failure");
  });

  it("falls back to the check name for a legacy marker without workflow", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    setLaneConfig({
      lanes: [
        { id: "normal", title: "Normal", claimable: true, role: "default" },
        { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
      ],
    });
    const client = makeClient({ body: buildFailureMarker("abc123"), currentLane: "frontier" });

    await ingestCheckRunEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/actions/runs/123",
      title: "Fix test issue",
      author: "itsmiso-ai",
      checkName: "Vulnerability Scan",
      conclusion: "failure",
      checkRunId: "cr-legacy-marker",
      checkDetails: "found CVE-2026-1234",
      linkedIssue: 123,
    });

    expect(client.items[0].feedback[0]).toContain("workflow Vulnerability Scan");
  });

  it("raises a frontier-linked issue's non-scan check to ESCALATED (#1503)", async () => {
    // #1503: exclusivity comes from the LINKED ISSUE's classification, not
    // the evidence kind. A frontier parent's fixes must never fall into the
    // shared normal queue, so every ingestion event type inherits the
    // authoritative escalation lane (the scan-recurrence branch above stays
    // as its annotation layer).
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    setLaneConfig({
      lanes: [
        { id: "normal", title: "Normal", claimable: true, role: "default" },
        { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
      ],
    });
    const client = makeClient({ body: buildFailureMarker("abc123", "Vulnerability Scan"), currentLane: "frontier" });

    await ingestCheckRunEvent(client, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/actions/runs/123",
      title: "Fix test issue",
      author: "itsmiso-ai",
      checkName: "lint",
      conclusion: "failure",
      checkRunId: "cr-lint",
      checkDetails: "eslint error: unused import",
      linkedIssue: 123,
    });

    expect(client.items[0].lane).toBe("ESCALATED");
    expect(client.items[0].feedback[0]).not.toContain("Recurrence of scan failure");
  });

  it("keeps a scan check in NORMAL without a linked issue; raises an unmarked check on a frontier issue (#1503)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    setLaneConfig({
      lanes: [
        { id: "normal", title: "Normal", claimable: true, role: "default" },
        { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
      ],
    });
    const noIssueClient = makeClient();
    await ingestCheckRunEvent(noIssueClient, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/actions/runs/123",
      title: "Fix test issue",
      author: "itsmiso-ai",
      checkName: "Vulnerability Scan",
      conclusion: "failure",
      checkRunId: "cr-no-issue",
      linkedIssue: null,
    });

    const unmarkedClient = makeClient({ body: "ordinary issue", currentLane: "frontier" });
    await ingestCheckRunEvent(unmarkedClient, {
      repoFullName: "misospace/dispatch",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/misospace/dispatch/actions/runs/123",
      title: "Fix test issue",
      author: "itsmiso-ai",
      checkName: "Vulnerability Scan",
      conclusion: "failure",
      checkRunId: "cr-unmarked",
      linkedIssue: 123,
    });

    // No linked issue means no escalation provenance → shared queue.
    expect(noIssueClient.items[0].lane).toBe("NORMAL");
    // #1503: an unmarked failure still inherits the frontier parent's lane.
    expect(unmarkedClient.items[0].lane).toBe("ESCALATED");
    expect(unmarkedClient.items[0].feedback[0]).not.toContain("Recurrence of scan failure");
  });

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

  it("feedback carries the server-fetched log excerpt + the log URL", async () => {
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
      // The sync sets body to the bounded log excerpt it fetched server-side.
      checkDetails: "##[error]No export template found for preset 'macOS'",
    });

    expect(client.items).toHaveLength(1);
    const feedback = String(client.items[0].feedback);
    expect(feedback).toContain("Export validation (macOS)");
    expect(feedback).toContain("No export template found for preset 'macOS'"); // the real error
    expect(feedback).toContain("actions/runs/28977045019/job/85986677458"); // log URL for reference
  });

  it("degrades to reason + log URL when no excerpt could be fetched", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    await ingestCheckRunEvent(client, {
      repoFullName: "misospace/windowstead",
      prNumber: 266,
      branch: "foreman/x/issue-237",
      url: "https://github.com/misospace/windowstead/actions/runs/1/job/2",
      title: "smoke",
      author: "itsmiso-ai",
      checkName: "Headless smoke test",
      conclusion: "failure",
      checkRunId: "cr-smoke",
      checkDetails: "", // no excerpt (e.g. dispatch token lacks Actions:read)
    });

    const feedback = String(client.items[0].feedback);
    expect(feedback).toContain("Headless smoke test");
    expect(feedback).toContain("Full log: https://github.com/misospace/windowstead/actions/runs/1/job/2");
    expect(feedback).toContain("Read the full log");
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
    resetLaneConfig();
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

  it("populates REBASE type for DIRTY merge state (mechanical rebase lane, #1327)", async () => {
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
    expect(client.items[0].type).toBe("REBASE");
    // The item's reasons ARE the worker's contract wall for a rebase hand-off.
    expect(client.items[0].feedback[0]).toContain("Mechanical rebase required");
    expect(client.items[0].feedback[0]).toContain("MECHANICALLY ONLY");
    expect(client.items[0].feedback[0]).toContain("--force-with-lease");
    expect(client.items[0].feedback[0]).toContain("human_decision");
  });

  it("keeps non-conflict merge states as OTHER fix work", async () => {
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
    expect(client.items[0].type).toBe("OTHER");
    expect(client.items[0].feedback[0]).toBe("PR merge state is now behind");
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
        body: "Test failed: expected 200 but got 500",
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

  it("skips an event with no repository before ingesting, instead of throwing", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await processPrFollowupEvents(client, [
      {
        eventType: "comment",
        repoFullName: null as unknown as string,
        prNumber: 1,
        branch: null,
        url: "https://github.com/org/repo/pull/1",
        title: "Fix A",
        author: "itsmiso-ai",
        body: "Test failed: expected 200 but got 500",
        id: "c3",
      },
    ]);

    expect(result).toEqual({ enqueued: 0, skipped: 1 });
    expect(client.items).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no repository full name"));
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it("enqueues a check_run with the PR URL as the item URL and the job URL in feedback (#1098)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await processPrFollowupEvents(client, [
      {
        eventType: "check_run",
        repoFullName: "org/repo",
        prNumber: 7,
        branch: "fix/c",
        url: "https://api.github.com/repos/org/repo/pulls/7",
        checkRunUrl: "https://github.com/org/repo/actions/runs/9/job/1",
        title: "Fix C",
        author: "itsmiso-ai",
        body: "Error: Cannot read property 'x' of undefined",
        id: "cr1098",
        conclusion: "failure",
        checkName: "lint",
      },
    ]);

    expect(result.enqueued).toBe(1);
    expect(client.items).toHaveLength(1);
    // The item URL is the PR URL, not the CI job URL.
    expect(client.items[0].url).toBe("https://api.github.com/repos/org/repo/pulls/7");
    // The job URL is evidence in the feedback text ("Full log:" line).
    const feedback = String(client.items[0].feedback);
    expect(feedback).toContain("Full log: https://github.com/org/repo/actions/runs/9/job/1");
    expect(feedback).not.toContain("pulls/7");
  });

  it("keeps the job URL in feedback when checkRunUrl is absent (legacy shape)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const result = await processPrFollowupEvents(client, [
      {
        eventType: "check_run",
        repoFullName: "org/repo",
        prNumber: 7,
        branch: "fix/c",
        url: "https://github.com/org/repo/actions/runs/9/job/1",
        title: "Fix C",
        author: "itsmiso-ai",
        body: "Error: Cannot read property 'x' of undefined",
        id: "cr1098-legacy",
        conclusion: "failure",
        checkName: "lint",
      },
    ]);

    expect(result.enqueued).toBe(1);
    expect(client.items).toHaveLength(1);
    const feedback = String(client.items[0].feedback);
    expect(feedback).toContain("Full log: https://github.com/org/repo/actions/runs/9/job/1");
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

// ─── Informational bot comments ─────────────────────────────────────────────

// The real body shape from misospace/llmkube-images#114: a size-diff table
// reporting no change at all, which blocked a mergeable PR in NEEDS_HUMAN.
const SIZE_DIFF_COMMENT = `## 📦 App Size Analysis

| OS/Platform |  Previous |  Current  |   Change   | Trend |
| :---------- | :-------: | :-------: | :--------: | :---: |
| linux/amd64 | 191.12 MB | 191.12 MB | +0 B (+0%) |   🔄  |
<!-- Sticky Pull Request Commentapp-size-diff-llmkube-coder-node -->`;

describe("isInformationalComment", () => {
  it("flags sticky CI comments", () => {
    expect(isInformationalComment(SIZE_DIFF_COMMENT)).toBe(true);
  });

  it("flags dispatch's own BLOCKED notice", () => {
    expect(isInformationalComment("<!-- dispatch-pr-fix-blocked -->\n> ⚠️ needs human")).toBe(true);
  });

  it("flags dispatch's own PARKED notice (#1218)", () => {
    expect(isInformationalComment("<!-- dispatch-pr-fix-parked -->\n> ⏸️ parked after repeated attempts")).toBe(true);
  });

  it("does NOT flag an ai-pr-reviewer comment even with a marker", () => {
    const body = `<!-- Sticky Pull Request Comment -->
<!-- ai-pr-reviewer:${JSON.stringify({ review_result: "issues", open_findings: [{ severity: "blocker", message: "no upgrade performed" }] })} -->
## Review: Request Changes`;
    expect(isInformationalComment(body)).toBe(false);
  });

  it("does NOT flag ordinary review prose", () => {
    expect(isInformationalComment("Please change `fetch` to `axios` here.")).toBe(false);
    expect(isInformationalComment("")).toBe(false);
    expect(isInformationalComment(null)).toBe(false);
  });
});

describe("ingestCommentEvent — informational comments", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("does not enqueue a size-diff CI comment (llmkube-images#114 regression)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const key = await ingestCommentEvent(client, {
      repoFullName: "misospace/llmkube-images",
      prNumber: 114,
      branch: "foreman/wl-misospace-llmkube-images-89/issue-89",
      url: "https://github.com/misospace/llmkube-images/pull/114",
      title: "Add .dockerignore files to all app directories",
      author: "itsmiso-ai",
      commentBody: SIZE_DIFF_COMMENT,
      commentId: "c-size-diff",
    });

    expect(key).toBeNull();
    expect(client.items).toHaveLength(0);
  });

  it("still enqueues a genuine prose comment", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    await ingestCommentEvent(client, {
      repoFullName: "misospace/llmkube-images",
      prNumber: 115,
      branch: "foreman/x",
      url: "https://github.com/misospace/llmkube-images/pull/115",
      title: "Something",
      author: "itsmiso-ai",
      commentBody: "Change `fetch` to `axios` for better error handling",
      commentId: "c-real",
    });

    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
  });

  it("does not enqueue dispatch's own PARKED marker comment (#1218)", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();

    const key = await ingestCommentEvent(client, {
      repoFullName: "misospace/llmkube-images",
      prNumber: 116,
      branch: "foreman/x",
      url: "https://github.com/misospace/llmkube-images/pull/116",
      title: "Something",
      author: "itsmiso-ai",
      commentBody: "<!-- dispatch-pr-fix-parked -->\n> ⏸️ This PR fix item is PARKED after repeated attempts. An operator can requeue it.",
      commentId: "c-parked",
    });

    expect(key).toBeNull();
    expect(client.items).toHaveLength(0);
  });
});

// pr-reviewer-action#467: a detailed human review — file:line references, explicit
// asks — matched no actionable keyword and no ambiguous keyword, fell through
// classifyFeedback's needs_human default, and sat BLOCKED in NEEDS_HUMAN for 13
// hours. CHANGES_REQUESTED is itself the signal that a reviewer decided what must
// change; "matched no keyword" is not evidence that a human is needed.
describe("reviewLane via ingestReviewEvent", () => {
  it("routes a detailed prose review to the fix lane, not NEEDS_HUMAN", () => {
    // pr-reviewer-action#467: matched no actionable keyword and no ambiguous
    // keyword, so the old classifier defaulted it to needs_human and it sat
    // BLOCKED for 13 hours. The coder reads the review body directly.
    const body = [
      "**Request changes.** The PR deletes the entire test suite.",
      "**Important — `ci.yaml:20`:** The replacement YAML validation does not catch duplicate keys.",
    ].join("\n\n");
    // classifyFeedback still says needs_human — that default is precisely what
    // the review path no longer consults.
    expect(classifyFeedback(body)).toBe("needs_human");
  });
});

// foreman-dispatch-bridge#111: an APPROVED review carrying four "Minor (bug)" nits
// — two of them about silently swallowed errors — was dropped entirely. The review
// path only acts on CHANGES_REQUESTED, and the findings live on pulls/N/comments,
// an endpoint the sync never fetched. Ingesting the inline comments directly makes
// the feedback reachable regardless of the review's verdict.
describe("ingestReviewCommentEvent", () => {
  beforeEach(() => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
  });

  const base = {
    repoFullName: "misospace/foreman-dispatch-bridge",
    prNumber: 111,
    branch: "foreman/wl-x/issue-1",
    url: "https://github.com/misospace/foreman-dispatch-bridge/pull/111",
    title: "Parallelize lane queue GETs",
    author: "itsmiso-ai",
  };

  it("enqueues an inline finding as NORMAL review feedback", async () => {
    const client = makeClient();
    await ingestReviewCommentEvent(client, {
      ...base,
      commentBody: "**Minor (bug):** `queues()` propagates transport exceptions on the single-lane path but degrades to [] on the multi-lane path.",
      commentId: "rc-1",
      path: "bridge/claim.py",
      line: 99,
    });
    expect(client.items).toHaveLength(1);
    expect(client.items[0].lane).toBe("NORMAL");
    expect(client.items[0].type).toBe("REVIEW_FEEDBACK");
  });

  it("carries the file and line so the coder knows where the nit points", async () => {
    const client = makeClient();
    await ingestReviewCommentEvent(client, {
      ...base,
      commentBody: "swallowed with no log line",
      commentId: "rc-2",
      path: "bridge/claim.py",
      line: 109,
    });
    expect(client.items[0].reason).toContain("bridge/claim.py:109");
    expect(client.items[0].feedback[0]).toContain("bridge/claim.py:109");
  });

  it("does not depend on the review verdict — no state is consulted", async () => {
    // The whole point: these arrive from an APPROVED review and still enqueue.
    const client = makeClient();
    const key = await ingestReviewCommentEvent(client, {
      ...base,
      commentBody: "prefer a structured log line here",
      commentId: "rc-3",
      path: "bridge/claim.py",
      line: 211,
    });
    expect(key).toBeTruthy();
    expect(client.items).toHaveLength(1);
  });

  it("skips a nit on an already-merged PR", async () => {
    const client = makeClient();
    await ingestReviewCommentEvent(client, {
      ...base,
      commentBody: "minor style point",
      commentId: "rc-4",
      path: "bridge/claim.py",
      line: 1,
      prState: "closed",
      prMergedAt: "2026-08-06T09:00:00Z",
    });
    expect(client.items).toHaveLength(0);
  });

  it("skips informational bot comments", async () => {
    const client = makeClient();
    await ingestReviewCommentEvent(client, {
      ...base,
      commentBody: "<!-- Sticky Pull Request Comment -->\nCoverage: 85%",
      commentId: "rc-5",
      path: "bridge/claim.py",
      line: 2,
    });
    expect(client.items).toHaveLength(0);
  });

  it("falls back to original_line semantics when line is absent", async () => {
    const client = makeClient();
    await ingestReviewCommentEvent(client, {
      ...base,
      commentBody: "stale anchor but still a finding",
      commentId: "rc-6",
      path: "bridge/claim.py",
      line: null,
    });
    expect(client.items).toHaveLength(1);
    expect(client.items[0].reason).toContain("bridge/claim.py");
  });
});

// ─── Comment gate: actionable-only ──────────────────────────────────────────

describe("comment ingestion requires actionable signal", () => {
  function commentEvent(body: string, id = "c-gate") {
    return {
      eventType: "comment" as const,
      repoFullName: "org/repo",
      prNumber: 1,
      branch: "fix/a",
      url: "https://github.com/org/repo/pull/1",
      title: "Fix A",
      author: "itsmiso-ai",
      body,
      id,
    };
  }

  it("skips the CI image-publish comment that re-queued pinchflat#25 every sweep", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();
    const result = await processPrFollowupEvents(client, [
      commentEvent("🐳 Image for commit 933847b published: `ghcr.io/misospace/pinchflat-dev:pr-25-933847b`"),
    ]);
    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it.each([
    ["status chatter", "Looks good to me, nice work"],
    ["a question", "Why did we go with SQLite here?"],
    ["an empty body", "   "],
  ])("does not enqueue %s", async (_label, body) => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();
    const result = await processPrFollowupEvents(client, [commentEvent(body)]);
    expect(result.enqueued).toBe(0);
  });

  it("still enqueues a comment with actionable signal", async () => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();
    const result = await processPrFollowupEvents(client, [
      commentEvent("Error: Cannot read property 'id' of undefined in worker.ts"),
    ]);
    expect(result.enqueued).toBe(1);
  });

  it("enqueues an @-mention even when the prose is not classifiable", async () => {
    // The explicit opt-in: a human directing the loop should not have to phrase
    // the request so that a regex recognises it.
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();
    const result = await processPrFollowupEvents(client, [
      commentEvent("@itsmiso-ai please take another pass at this one"),
    ]);
    expect(result.enqueued).toBe(1);
  });

  it("enqueued comments are NORMAL, never NEEDS_HUMAN", async () => {
    // Ambiguous comments no longer reach workItem at all, so the lane that used
    // to strand mergeable PRs cannot be produced by this path.
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    const client = makeClient();
    await processPrFollowupEvents(client, [commentEvent("lint error: unused import")]);
    expect(client.items.length).toBeGreaterThan(0);
    for (const item of client.items) expect(item.lane).toBe("NORMAL");
  });
});

describe("extractLinkedIssue commit fallback", () => {
  it("still prefers the body when it carries a reference", () => {
    expect(
      extractLinkedIssue({
        title: "fix: thing",
        body: "Fixes #42",
        commitMessages: ["chore: x\n\nFixes #99"],
      }),
    ).toBe(42);
  });

  it("falls back to a commit message when title and body have none", () => {
    expect(
      extractLinkedIssue({
        title: "fix(carry_forward): let a maintainer dismiss a finding",
        body: "## Summary\n- does the thing\n",
        commitMessages: ["fix(carry_forward): dismiss\n\nFixes #534\n"],
      }),
    ).toBe(534);
  });

  it("requires a closing keyword in a commit, ignoring a bare reference", () => {
    expect(
      extractLinkedIssue({
        title: "t",
        body: "b",
        commitMessages: ["revert of #101, see discussion"],
      }),
    ).toBeNull();
  });

  it("accepts the closing-keyword variants", () => {
    for (const [msg, want] of [
      ["Fixes #1", 1],
      ["fixed #2", 2],
      ["Closes #3", 3],
      ["closed #4", 4],
      ["Resolves #5", 5],
      ["resolve #6", 6],
    ] as const) {
      expect(extractLinkedIssue({ title: "t", body: "b", commitMessages: [msg] })).toBe(want);
    }
  });

  it("takes the first commit that names an issue", () => {
    expect(
      extractLinkedIssue({
        title: "t",
        body: "b",
        commitMessages: ["no reference here", "Fixes #77", "Fixes #88"],
      }),
    ).toBe(77);
  });

  it("tolerates absent, empty and null commit messages", () => {
    expect(extractLinkedIssue({ title: "t", body: "b" })).toBeNull();
    expect(extractLinkedIssue({ title: "t", body: "b", commitMessages: [] })).toBeNull();
    expect(
      extractLinkedIssue({ title: "t", body: "b", commitMessages: [null, undefined, ""] }),
    ).toBeNull();
  });
});

// ─── Durable Evidence Fields (#1249) ─────────────────────────────────────────
//
// Captures the EnqueuePrFixInput the ingestion path hands to enqueuePrFixItem
// (recorded by the module mock above) and asserts on the durable evidence*
// block: kind, stable key, state-bearing version, actionability, content
// signature, observed timestamp, head SHA, and source.

describe("durable evidence fields (#1249)", () => {
  beforeEach(() => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    evidenceEnqueueInputs.length = 0;
  });

  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
  });

  it("ingestReviewEvent → review evidence block on the enqueue payload", async () => {
    const client = makeClient();
    await ingestReviewEvent(client, {
      repoFullName: "org/repo",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/org/repo/pull/42",
      title: "Fix test",
      author: "itsmiso-ai",
      reviewBody: "Test failed: expected 200 but got 404",
      reviewId: "r1",
      reviewState: "CHANGES_REQUESTED",
      actorLogin: "octocat",
      commitId: "abc123",
      submittedAt: "2026-10-01T10:00:00Z",
      headSha: "head-review",
      source: "webhook",
    });

    expect(evidenceEnqueueInputs).toHaveLength(1);
    const input = evidenceEnqueueInputs[0];
    expect(input.evidenceKind).toBe("review");
    expect(input.evidenceKey).toBe("review:org/repo#42:r1");
    expect(input.evidenceVersion).toBe("state=changes_requested|commit=abc123");
    expect(input.evidenceContentSignature).toMatch(/^[0-9a-f]{32}$/);
    expect(input.evidenceObservedAt).toBe("2026-10-01T10:00:00Z");
    expect(input.evidenceActionable).toBe(true);
    expect(input.evidenceHeadSha).toBe("head-review");
    expect(input.evidenceSource).toBe("webhook");
  });

  it("ingestCommentEvent → comment evidence block (actor lowercased in version)", async () => {
    const client = makeClient();
    await ingestCommentEvent(client, {
      repoFullName: "org/repo",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/org/repo/pull/42",
      title: "Fix test",
      author: "itsmiso-ai",
      commentBody: "Test failed: expected 200 but got 404",
      commentId: "c1",
      actorLogin: "OctoCat",
      updatedAt: "2026-10-02T12:00:00Z",
      headSha: "head-comment",
      source: "webhook",
    });

    expect(evidenceEnqueueInputs).toHaveLength(1);
    const input = evidenceEnqueueInputs[0];
    expect(input.evidenceKind).toBe("comment");
    expect(input.evidenceKey).toBe("comment:org/repo#42:c1");
    expect(input.evidenceVersion).toBe("updated=2026-10-02t12:00:00z|actor=octocat");
    expect(input.evidenceActionable).toBe(true);
    expect(input.evidenceContentSignature).toMatch(/^[0-9a-f]{32}$/);
    expect(input.evidenceObservedAt).toBe("2026-10-02T12:00:00Z");
  });

  it("ingestReviewCommentEvent with a resolved thread → recorded, never actionable", async () => {
    const client = makeClient();
    await ingestReviewCommentEvent(client, {
      repoFullName: "org/repo",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/org/repo/pull/42",
      title: "Fix test",
      author: "itsmiso-ai",
      commentBody: "Unused import on line 12",
      commentId: "rc1",
      path: "src/foo.ts",
      line: 12,
      actorLogin: "octocat",
      commitId: "abc123",
      updatedAt: "2026-10-03T00:00:00Z",
      threadResolved: true,
      threadOutdated: false,
      headSha: "head-rc",
      source: "webhook",
    });

    expect(evidenceEnqueueInputs).toHaveLength(1);
    const input = evidenceEnqueueInputs[0];
    expect(input.evidenceKind).toBe("review_comment");
    expect(input.evidenceKey).toBe("review_comment:org/repo#42:rc1");
    expect(input.evidenceVersion).toContain("resolved=y");
    expect(input.evidenceActionable).toBe(false);
  });

  it("ingestReviewCommentEvent with undefined thread flags → defers the ledger (legacy cache semantics)", async () => {
    const client = makeClient();
    await ingestReviewCommentEvent(client, {
      repoFullName: "org/repo",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/org/repo/pull/42",
      title: "Fix test",
      author: "itsmiso-ai",
      commentBody: "Unused import on line 12",
      commentId: "rc2",
      path: "src/foo.ts",
      line: 12,
      actorLogin: "octocat",
      commitId: "abc123",
      updatedAt: "2026-10-03T00:00:00Z",
      threadResolved: undefined,
      threadOutdated: undefined,
      headSha: "head-rc",
      source: "webhook",
    });

    expect(evidenceEnqueueInputs).toHaveLength(1);
    const input = evidenceEnqueueInputs[0];
    // Unknown thread state defers: the enqueue still carries the identity
    // (bounded-cache dedupe keeps working) but NO ledger fields, so a
    // transient GraphQL thread-read failure can never overwrite a known
    // resolved/unresolved baseline or mint an unknown-version transition.
    expect(input.evidenceKey).toBe("review_comment:org/repo#42:rc2");
    expect(input.evidenceKind).toBeNull();
    expect(input.evidenceVersion).toBeNull();
    expect(input.evidenceActionable).toBeNull();
    expect(input.evidenceContentSignature).toBeNull();
  });

  it("ingestCheckRunEvent with a failing conclusion → actionable check_run block", async () => {
    const client = makeClient();
    await ingestCheckRunEvent(client, {
      repoFullName: "org/repo",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/org/repo/pull/42",
      title: "Fix test",
      author: "itsmiso-ai",
      checkName: "lint",
      conclusion: "failure",
      checkRunId: "cr1",
      checkDetails: "eslint error: unused import",
      checkStatus: "completed",
      completedAt: "2026-10-04T00:00:00Z",
      headSha: "head-check",
      source: "webhook",
    });

    expect(evidenceEnqueueInputs).toHaveLength(1);
    const input = evidenceEnqueueInputs[0];
    expect(input.evidenceKind).toBe("check_run");
    expect(input.evidenceKey).toBe("check_run:org/repo#42:cr1");
    expect(input.evidenceVersion).toBe("head=head-check|status=completed|conclusion=failure");
    expect(input.evidenceActionable).toBe(true);
    expect(input.evidenceObservedAt).toBe("2026-10-04T00:00:00Z");
    expect(input.evidenceHeadSha).toBe("head-check");
    expect(input.evidenceSource).toBe("webhook");
  });

  it("ingestMergeStateEvent dirty → stable per-PR identity (no state-derived key)", async () => {
    const client = makeClient();
    await ingestMergeStateEvent(client, {
      repoFullName: "org/repo",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/org/repo/pull/42",
      title: "Fix test",
      author: "itsmiso-ai",
      mergeStateStatus: "dirty",
      headSha: "head-ms",
      source: "webhook",
    });

    expect(evidenceEnqueueInputs).toHaveLength(1);
    const input = evidenceEnqueueInputs[0];
    expect(input.evidenceKind).toBe("merge_state");
    expect(input.evidenceKey).toBe("merge_state:org/repo#42");
    expect(input.evidenceVersion).toBe("state=dirty|head=head-ms");
    expect(input.evidenceActionable).toBe(true);
  });

  it("ingestMergeConflict CONFLICTING → stable per-PR identity (no trailing state)", async () => {
    const client = makeClient();
    await ingestMergeConflict(client, {
      repoFullName: "org/repo",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/org/repo/pull/42",
      title: "Fix test",
      author: "itsmiso-ai",
      mergeable: "CONFLICTING",
      headSha: "head-mc",
      source: "webhook",
    });

    expect(evidenceEnqueueInputs).toHaveLength(1);
    const input = evidenceEnqueueInputs[0];
    expect(input.type).toBe("REBASE");
    expect(input.evidenceKind).toBe("merge_conflict");
    expect(input.evidenceKey).toBe("merge_conflict:org/repo#42");
    expect(input.evidenceVersion).toBe("mergeable=conflicting|head=head-mc");
    expect(input.evidenceActionable).toBe(true);
    expect(input.evidenceContentSignature).toBeNull();
  });

  it("ingestReviewEvent with a non-date submittedAt → observedAt passes through raw (queue validates)", async () => {
    const client = makeClient();
    const result = await ingestReviewEvent(client, {
      repoFullName: "org/repo",
      prNumber: 42,
      branch: "fix/test",
      url: "https://github.com/org/repo/pull/42",
      title: "Fix test",
      author: "itsmiso-ai",
      reviewBody: "Test failed: expected 200 but got 404",
      reviewId: "r7",
      reviewState: "CHANGES_REQUESTED",
      actorLogin: "octocat",
      commitId: "abc123",
      submittedAt: "not-a-date",
      headSha: "head-review",
      source: "webhook",
    });

    // No throw, and the event was enqueued.
    expect(result).toBe("review:org/repo#42:r7");
    expect(evidenceEnqueueInputs).toHaveLength(1);
    // The forge timestamp is recorded verbatim — the queue is what validates it.
    expect(evidenceEnqueueInputs[0].evidenceObservedAt).toBe("not-a-date");
  });
});

// ─── Record-only review state transitions (#1276) ────────────────────────────
//
// A review that leaves CHANGES_REQUESTED is an observation of the ledger, not
// work: ingestion must record the transition on the EXISTING item's durable
// ledger and enqueue nothing, and must still report the event as not-enqueued.
//
// makeClient above is deliberately ledger-inert (its transaction handle has no
// prFixEvidence), which is what keeps every pre-existing enqueue assertion
// exactly as it was. These cases need the durable surface to be observable at
// all, so this is the smallest ledger-capable fake: lookup by (repo, pr) plus
// the pinned counter claim the record-only path makes.

function makeLedgerClient() {
  const items: any[] = [];
  const ledger: any[] = [];
  const history: any[] = [];
  let seq = 0;
  const applyData = (row: any, data: any) => {
    for (const [key, value] of Object.entries(data ?? {})) {
      if (value !== null && typeof value === "object" && "increment" in (value as any)) {
        row[key] = (row[key] ?? 0) + (value as any).increment;
      } else {
        row[key] = value;
      }
    }
  };
  const client: any = {
    items,
    ledger,
    history,
    issue: { findFirst: async () => null },
    prFixQueueItem: {
      findUnique: async ({ where }: any) =>
        where.repo_pr
          ? items.find((r) => r.repo === where.repo_pr.repo && r.pr === where.repo_pr.pr) ?? null
          : items.find((r) => r.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const row = {
          id: `item-${++seq}`,
          generation: 1,
          fixAttempts: 1,
          evidenceSequence: 0,
          status: "QUEUED",
          feedback: [],
          evidenceKeys: [],
          postDispatchEvidenceKeys: [],
          ...data,
        };
        items.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = items.find((r) => r.id === where.id);
        if (!row) throw new Error("P2025");
        applyData(row, data);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = items.filter(
          (r) =>
            r.id === where.id &&
            (where.evidenceSequence === undefined || r.evidenceSequence === where.evidenceSequence),
        );
        for (const row of hit) applyData(row, data);
        return { count: hit.length };
      },
    },
    prFixHistory: {
      create: async ({ data }: any) => {
        history.push(data);
        return data;
      },
    },
    prFixEvidence: {
      findFirst: async ({ where }: any) =>
        ledger.find((row) => row.itemId === where.itemId && row.identity === where.identity) ?? null,
      findMany: async ({ where }: any) =>
        ledger.filter(
          (row) =>
            row.itemId === where.itemId &&
            (where.contentSignature === undefined || row.contentSignature === where.contentSignature),
        ),
      upsert: async ({ where, create, update }: any) => {
        const { itemId, identity } = where.itemId_identity;
        const existing = ledger.find((row) => row.itemId === itemId && row.identity === identity);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { ...create };
        ledger.push(row);
        return row;
      },
    },
    $transaction: async (fn: any) => fn(client),
  };
  return client;
}

/** The CHANGES_REQUESTED review that opens the item the transition lands on. */
const REQUESTED_REVIEW = {
  repoFullName: "org/repo",
  prNumber: 42,
  branch: "fix/test",
  url: "https://github.com/org/repo/pull/42",
  title: "Fix test",
  author: "itsmiso-ai",
  reviewBody: "Test failed: expected 200 but got 404",
  reviewId: "r1",
  reviewState: "CHANGES_REQUESTED",
  actorLogin: "octocat",
  commitId: "abc123",
  submittedAt: "2026-10-01T10:00:00Z",
  headSha: "head-review",
  source: "webhook",
} as const;

describe("record-only review state transitions (#1276)", () => {
  beforeEach(() => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    evidenceEnqueueInputs.length = 0;
  });

  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
  });

  it("an APPROVED re-read records the transition and enqueues no work", async () => {
    const client = makeLedgerClient();
    await ingestReviewEvent(client, REQUESTED_REVIEW);
    expect(client.items).toHaveLength(1);
    expect(client.ledger).toHaveLength(1);
    const before = {
      status: client.items[0].status,
      lane: client.items[0].lane,
      feedback: [...client.items[0].feedback],
      generation: client.items[0].generation,
      history: client.history.length,
    };

    const result = await ingestReviewEvent(client, { ...REQUESTED_REVIEW, reviewState: "APPROVED" });

    // Recorded, and reported as NOT enqueued.
    expect(result).toBeNull();
    expect(evidenceEnqueueInputs).toHaveLength(1); // only the CHANGES_REQUESTED enqueue
    expect(client.ledger).toHaveLength(1);
    expect(client.ledger[0]).toMatchObject({
      identity: "review:org/repo#42:r1",
      kind: "review",
      version: "state=approved|commit=abc123",
      actionable: false,
    });
    expect(client.items[0].evidenceSequence).toBe(2);
    // Work state untouched: no enqueue, so nothing about the attempt moved.
    expect(client.items[0].status).toBe(before.status);
    expect(client.items[0].lane).toBe(before.lane);
    expect(client.items[0].feedback).toEqual(before.feedback);
    expect(client.items[0].generation).toBe(before.generation);
    expect(client.items[0].fixAttempts).toBe(1);
    expect(client.history).toHaveLength(before.history);
  });

  it("a DISMISSED review with no queue item records nothing and creates nothing", async () => {
    const client = makeLedgerClient();
    const result = await ingestReviewEvent(client, {
      ...REQUESTED_REVIEW,
      reviewState: "DISMISSED",
      prNumber: 99,
    });

    expect(result).toBeNull();
    expect(evidenceEnqueueInputs).toHaveLength(0);
    expect(client.items).toHaveLength(0);
    expect(client.ledger).toHaveLength(0);
    expect(client.history).toHaveLength(0);
  });

  it("processPrFollowupEvents counts a record-only review as skipped, never enqueued", async () => {
    const client = makeLedgerClient();
    await ingestReviewEvent(client, REQUESTED_REVIEW);

    const counts = await processPrFollowupEvents(client, [
      {
        eventType: "review",
        repoFullName: "org/repo",
        prNumber: 42,
        branch: "fix/test",
        url: "https://github.com/org/repo/pull/42",
        title: "Fix test",
        author: "itsmiso-ai",
        body: "Test failed: expected 200 but got 404",
        id: "r1",
        state: "APPROVED",
        actorLogin: "octocat",
        commitId: "abc123",
        submittedAt: "2026-10-01T10:00:00Z",
        headSha: "head-review",
        source: "sync",
      },
    ]);

    expect(counts).toEqual({ enqueued: 0, skipped: 1 });
    expect(client.ledger[0]).toMatchObject({
      version: "state=approved|commit=abc123",
      actionable: false,
    });
    expect(client.items[0].status).toBe("QUEUED");
  });

  it("an existing CHANGES_REQUESTED review still enqueues work exactly as before", async () => {
    const client = makeLedgerClient();
    const counts = await processPrFollowupEvents(client, [
      {
        eventType: "review",
        repoFullName: "org/repo",
        prNumber: 42,
        branch: "fix/test",
        url: "https://github.com/org/repo/pull/42",
        title: "Fix test",
        author: "itsmiso-ai",
        body: "Test failed: expected 200 but got 404",
        id: "r1",
        state: "CHANGES_REQUESTED",
        actorLogin: "octocat",
        commitId: "abc123",
        submittedAt: "2026-10-01T10:00:00Z",
        headSha: "head-review",
        source: "sync",
      },
    ]);

    expect(counts).toEqual({ enqueued: 1, skipped: 0 });
    expect(client.items).toHaveLength(1);
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.items[0].type).toBe("REVIEW_FEEDBACK");
    expect(client.ledger).toHaveLength(1);
    expect(client.ledger[0]).toMatchObject({ version: "state=changes_requested|commit=abc123", actionable: true });
  });

  it("the eligibility filters still apply to record-only reviews", async () => {
    const client = makeLedgerClient();
    await ingestReviewEvent(client, REQUESTED_REVIEW);
    const ledgerBefore = { ...client.ledger[0] };

    // Non-bot PR author, terminal PR, and a disallowed branch owner each drop
    // the observation exactly like they drop work.
    await ingestReviewEvent(client, { ...REQUESTED_REVIEW, reviewState: "APPROVED", author: "human" });
    await ingestReviewEvent(client, { ...REQUESTED_REVIEW, reviewState: "APPROVED", prState: "closed" });
    process.env.PR_FOLLOWUP_BRANCH_OWNERS = "other-org";
    await ingestReviewEvent(client, { ...REQUESTED_REVIEW, reviewState: "APPROVED" });
    delete process.env.PR_FOLLOWUP_BRANCH_OWNERS;

    expect(client.ledger[0]).toEqual(ledgerBefore);
    expect(client.items[0].evidenceSequence).toBe(1);
    expect(evidenceEnqueueInputs).toHaveLength(1);
  });
});

// ─── Record-only merge_state observations (#1276 review) ─────────────────────
//
// `merge_state` gates work on the same actionability predicate the ledger
// stamps (`isActionableEvidenceVersion`), so a state that is NOT problematic is
// a record-only observation of the PR's stable condition identity. Without the
// record-only branch the ledger row froze at its last `dirty`/`behind` version
// with `actionable: true` and a later settlement could read that stale
// condition as fresh post-watermark evidence — reopening a merge state that had
// actually cleared.

describe("record-only merge_state observations (#1276 review)", () => {
  beforeEach(() => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    evidenceEnqueueInputs.length = 0;
  });

  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
  });

  const DIRTY_STATE = {
    repoFullName: "org/repo",
    prNumber: 42,
    branch: "fix/test",
    url: "https://github.com/org/repo/pull/42",
    title: "Fix test",
    author: "itsmiso-ai",
    mergeStateStatus: "dirty",
    headSha: "head-1",
    source: "sync",
  } as const;

  it("a cleared merge state moves the ledger row to a non-actionable version and enqueues nothing", async () => {
    const client = makeLedgerClient();
    await ingestMergeStateEvent(client, DIRTY_STATE);
    expect(client.ledger).toHaveLength(1);
    expect(client.ledger[0]).toMatchObject({
      identity: "merge_state:org/repo#42",
      kind: "merge_state",
      version: "state=dirty|head=head-1",
      actionable: true,
    });
    const before = {
      status: client.items[0].status,
      lane: client.items[0].lane,
      type: client.items[0].type,
      feedback: [...client.items[0].feedback],
      generation: client.items[0].generation,
      fixAttempts: client.items[0].fixAttempts,
      history: client.history.length,
    };

    const result = await ingestMergeStateEvent(client, { ...DIRTY_STATE, mergeStateStatus: "clean" });

    // Recorded (same stable identity, one row) and reported as NOT enqueued.
    expect(result).toBeNull();
    expect(evidenceEnqueueInputs).toHaveLength(1);
    expect(client.ledger).toHaveLength(1);
    expect(client.ledger[0]).toMatchObject({
      identity: "merge_state:org/repo#42",
      kind: "merge_state",
      version: "state=clean|head=head-1",
      actionable: false,
    });
    // The transition is real (the version moved), so it got its own position.
    expect(client.items[0].evidenceSequence).toBe(2);
    // Work untouched: no enqueue, no reopen, no attempt movement.
    expect(client.items[0].status).toBe(before.status);
    expect(client.items[0].lane).toBe(before.lane);
    expect(client.items[0].type).toBe(before.type);
    expect(client.items[0].feedback).toEqual(before.feedback);
    expect(client.items[0].generation).toBe(before.generation);
    expect(client.items[0].fixAttempts).toBe(before.fixAttempts);
    expect(client.history).toHaveLength(before.history);
  });

  it("a replayed cleared merge state is inert (no counter bump, no restamp)", async () => {
    const client = makeLedgerClient();
    await ingestMergeStateEvent(client, DIRTY_STATE);
    await ingestMergeStateEvent(client, { ...DIRTY_STATE, mergeStateStatus: "clean" });
    const settled = { ...client.ledger[0] };

    await ingestMergeStateEvent(client, { ...DIRTY_STATE, mergeStateStatus: "clean" });

    expect(client.ledger[0]).toEqual(settled);
    expect(client.items[0].evidenceSequence).toBe(2);
    expect(evidenceEnqueueInputs).toHaveLength(1);
  });

  it("processPrFollowupEvents counts a cleared merge state as skipped, never enqueued", async () => {
    const client = makeLedgerClient();
    await ingestMergeStateEvent(client, DIRTY_STATE);

    const counts = await processPrFollowupEvents(client, [
      {
        eventType: "merge_state",
        repoFullName: DIRTY_STATE.repoFullName,
        prNumber: DIRTY_STATE.prNumber,
        branch: DIRTY_STATE.branch,
        url: DIRTY_STATE.url,
        title: DIRTY_STATE.title,
        author: DIRTY_STATE.author,
        id: "clean",
        mergeStateStatus: "clean",
        headSha: "head-1",
        source: "sync",
      },
    ]);

    expect(counts).toEqual({ enqueued: 0, skipped: 1 });
    expect(client.ledger[0]).toMatchObject({ version: "state=clean|head=head-1", actionable: false });
    expect(client.items[0].status).toBe("QUEUED");
  });

  it("the eligibility filters still apply to cleared merge states", async () => {
    const client = makeLedgerClient();
    await ingestMergeStateEvent(client, DIRTY_STATE);
    const ledgerBefore = { ...client.ledger[0] };

    // A merged/closed PR, a non-bot author, and a disallowed branch owner each
    // drop the observation exactly like they drop work.
    await ingestMergeStateEvent(client, { ...DIRTY_STATE, mergeStateStatus: "clean", prMergedAt: "2026-06-01T00:00:00Z" });
    await ingestMergeStateEvent(client, { ...DIRTY_STATE, mergeStateStatus: "clean", prState: "closed" });
    await ingestMergeStateEvent(client, { ...DIRTY_STATE, mergeStateStatus: "clean", author: "human" });
    process.env.PR_FOLLOWUP_BRANCH_OWNERS = "other-org";
    await ingestMergeStateEvent(client, { ...DIRTY_STATE, mergeStateStatus: "clean" });
    delete process.env.PR_FOLLOWUP_BRANCH_OWNERS;

    expect(client.ledger[0]).toEqual(ledgerBefore);
    expect(client.items[0].evidenceSequence).toBe(1);
    expect(evidenceEnqueueInputs).toHaveLength(1);
  });

  it("defers `unknown` instead of clearing a real condition (#1276 review)", async () => {
    const client = makeLedgerClient();
    await ingestMergeStateEvent(client, DIRTY_STATE);
    const actionableRow = { ...client.ledger[0] };

    // GitHub still computing mergeability is the ABSENCE of an observation, not
    // a cleared one. Recording it would overwrite an actionable `dirty`
    // baseline with a non-actionable version at a HIGHER sequence — a false
    // silence on a condition that is still live, and one no later re-read would
    // repair until the PR's state actually changed again.
    const result = await ingestMergeStateEvent(client, { ...DIRTY_STATE, mergeStateStatus: "unknown" });

    expect(result).toBeNull();
    expect(client.ledger).toHaveLength(1);
    expect(client.ledger[0]).toEqual(actionableRow);
    expect(client.items[0].evidenceSequence).toBe(1);
    expect(evidenceEnqueueInputs).toHaveLength(1);

    // A DEFINITE non-problematic state is the opposite case and does record, so
    // the deferral is scoped to "unknown" and not to "not problematic".
    await ingestMergeStateEvent(client, { ...DIRTY_STATE, mergeStateStatus: "blocked" });
    expect(client.ledger[0]).toMatchObject({ version: "state=blocked|head=head-1", actionable: false });
    expect(client.items[0].evidenceSequence).toBe(2);
  });
});

// ─── Cleared merge_conflict ledger baseline (#1276 review) ───────────────────
//
// Settling a resolved conflict FIXED without recording the cleared condition
// left the `merge_conflict:<repo>#<pr>` row authoritative and actionable — a
// durable baseline contradicting a PR that had already resolved. The transition
// is recorded BEFORE the settle so a crash between the two leaves a stale
// QUEUED item (re-run idempotently) rather than a settled item whose baseline
// still demands work.

describe("clearResolvedConflictItems ledger baseline (#1276 review)", () => {
  beforeEach(() => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
    evidenceEnqueueInputs.length = 0;
  });

  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
  });

  const CONFLICT = {
    repoFullName: "org/repo",
    prNumber: 42,
    branch: "fix/test",
    url: "https://github.com/org/repo/pull/42",
    title: "Fix test",
    author: "itsmiso-ai",
    mergeable: "CONFLICTING",
    headSha: "head-1",
    source: "sync",
  } as const;

  async function conflicting(client: any) {
    await ingestMergeConflict(client, CONFLICT);
    return client.items[0];
  }

  it("records the cleared condition on the ledger BEFORE settling FIXED", async () => {
    const client = makeLedgerClient();
    const item = await conflicting(client);
    item.attemptEvidenceWatermark = 2;
    const historyBefore = client.history.length;

    // Observe the ledger exactly as the settle sees it, so the ordering is
    // asserted rather than assumed.
    const ledgerAtSettle: any[] = [];
    const originalUpdate = client.prFixQueueItem.update;
    client.prFixQueueItem.update = async (args: any) => {
      ledgerAtSettle.push(client.ledger.map((row: any) => ({ version: row.version, actionable: row.actionable })));
      return originalUpdate(args);
    };

    const cleared = await clearResolvedConflictItems(client, {
      repoFullName: CONFLICT.repoFullName,
      prNumber: CONFLICT.prNumber,
      mergeable: "MERGEABLE",
      headSha: "head-1",
    });

    expect(cleared).toBe(true);
    expect(ledgerAtSettle).toEqual([[{ version: "mergeable=mergeable|head=head-1", actionable: false }]]);
    expect(client.ledger).toHaveLength(1);
    expect(client.ledger[0]).toMatchObject({
      identity: "merge_conflict:org/repo#42",
      kind: "merge_conflict",
      version: "mergeable=mergeable|head=head-1",
      actionable: false,
      contentSignature: null,
      observedAt: null,
      headSha: "head-1",
      source: "sync",
    });
    expect(item.evidenceSequence).toBe(2);
    // Existing settle behaviour untouched.
    expect(item.status).toBe("FIXED");
    expect(item.attemptEvidenceWatermark).toBeNull();
    expect(client.history).toHaveLength(historyBefore + 1);
    expect(client.history.at(-1).status).toBe("FIXED");
    // No work was created: only the original conflict enqueue exists.
    expect(evidenceEnqueueInputs).toHaveLength(1);
  });

  it("records a head-less cleared version when the caller has no head SHA", async () => {
    const client = makeLedgerClient();
    await conflicting(client);

    const cleared = await clearResolvedConflictItems(client, {
      repoFullName: CONFLICT.repoFullName,
      prNumber: CONFLICT.prNumber,
      mergeable: "MERGEABLE",
    });

    expect(cleared).toBe(true);
    expect(client.ledger[0]).toMatchObject({
      identity: "merge_conflict:org/repo#42",
      version: "mergeable=mergeable|head=",
      actionable: false,
      headSha: null,
    });
    expect(client.items[0].status).toBe("FIXED");
  });

  it("settles FIXED even when the ledger record fails, and warns", async () => {
    const client = makeLedgerClient();
    const item = await conflicting(client);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    client.prFixEvidence.findFirst = async () => {
      throw new Error("ledger unavailable");
    };

    try {
      const cleared = await clearResolvedConflictItems(client, {
        repoFullName: CONFLICT.repoFullName,
        prNumber: CONFLICT.prNumber,
        mergeable: "MERGEABLE",
        headSha: "head-1",
      });

      // The conflict really did clear, so a ledger error must not strand the
      // item in QUEUED.
      expect(cleared).toBe(true);
      expect(item.status).toBe("FIXED");
      expect(item.attemptEvidenceWatermark).toBeNull();
      expect(warn.mock.calls.some((call) => JSON.stringify(call[0]).includes("cleared merge-conflict ledger record failed"))).toBe(true);
      // Worst case left visible for an operator: the row is still the old
      // actionable condition, which is the failure mode the ordering bounds.
      expect(client.ledger[0]).toMatchObject({ version: "mergeable=conflicting|head=head-1", actionable: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the QUEUED guard and still requires a non-conflicting state", async () => {
    const client = makeLedgerClient();
    const item = await conflicting(client);
    item.status = "BLOCKED";
    const historyBefore = client.history.length;

    expect(
      await clearResolvedConflictItems(client, {
        repoFullName: CONFLICT.repoFullName,
        prNumber: CONFLICT.prNumber,
        mergeable: "MERGEABLE",
        headSha: "head-1",
      }),
    ).toBe(false);
    expect(await clearResolvedConflictItems(client, {
      repoFullName: CONFLICT.repoFullName,
      prNumber: CONFLICT.prNumber,
      mergeable: "CONFLICTING",
      headSha: "head-1",
    })).toBe(false);
    // Still conflicting, or not a clearable status: nothing recorded, nothing settled.
    expect(client.ledger[0]).toMatchObject({ version: "mergeable=conflicting|head=head-1", actionable: true });
    expect(item.status).toBe("BLOCKED");
    expect(client.items).toHaveLength(1);
    expect(client.history).toHaveLength(historyBefore);
  });

  it("settles a legacy MERGE_CONFLICT row FIXED when the conflict clears", async () => {
    // Pre-#1327 rows queued by the fix loop carry MERGE_CONFLICT; the guard
    // clears them the same as REBASE rows.
    const client = makeLedgerClient();
    const item = await conflicting(client);
    item.type = "MERGE_CONFLICT";

    const cleared = await clearResolvedConflictItems(client, {
      repoFullName: CONFLICT.repoFullName,
      prNumber: CONFLICT.prNumber,
      mergeable: "MERGEABLE",
      headSha: "head-1",
    });

    expect(cleared).toBe(true);
    expect(item.status).toBe("FIXED");
  });
});
