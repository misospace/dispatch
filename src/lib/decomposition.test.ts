import { describe, expect, it } from "vitest";
import {
  CHILD_ISSUE_LABELS,
  UMBRELLA_LABEL,
  childBodyMarker,
  childBriefKey,
  renderChildIssueBody,
  setDecompositionState,
  type ChildIssueTarget,
  type DecompositionStateClient,
} from "./decomposition";
import type { ChildBrief } from "./groomer/plan";

const parent: ChildIssueTarget = {
  repoFullName: "acme/storefront",
  number: 260,
  url: "https://github.com/acme/storefront/issues/260",
};

const fullChild: ChildBrief = {
  title: "Add order search to the admin dashboard",
  problem: "Admins cannot search orders from the dashboard.",
  designDecision: "Search lives in a dedicated admin sub-route.",
  verifiedCurrentBehavior: "Dashboard.tsx renders four unrelated legacy widgets.",
  relevantPaths: ["src/admin/Dashboard.tsx", "src/admin/routes.ts"],
  inScope: ["the order search query and results list"],
  outOfScope: ["moving the dashboard to the new design system"],
  dependencies: ["the refund approval queue child"],
  acceptanceCriteria: ["an admin can search orders by id and see the match"],
  tests: ["src/admin/orders-search.test.ts"],
};

const minimal: ChildBrief = {
  title: "Fix redirect after reset",
  problem: "Login drops the return URL after a password reset.",
  designDecision: null,
  verifiedCurrentBehavior: null,
  relevantPaths: [],
  inScope: [],
  outOfScope: [],
  dependencies: [],
  acceptanceCriteria: ["a reset-then-login test lands on the return URL"],
  tests: [],
};

describe("labels", () => {
  it("uses the umbrella label and starts children in status/backlog", () => {
    expect(UMBRELLA_LABEL).toBe("umbrella");
    expect(CHILD_ISSUE_LABELS).toEqual(["status/backlog"]);
  });
});

describe("childBriefKey", () => {
  it("is stable for the same input", () => {
    expect(childBriefKey(parent.repoFullName, parent.number, fullChild)).toBe(
      childBriefKey(parent.repoFullName, parent.number, fullChild),
    );
  });

  it("is insensitive to repo case and surrounding whitespace", () => {
    expect(childBriefKey("  ACME/Storefront  ", 260, fullChild)).toBe(childBriefKey("acme/storefront", 260, fullChild));
  });

  it("differs for a different parent issue", () => {
    expect(childBriefKey(parent.repoFullName, 261, fullChild)).not.toBe(childBriefKey(parent.repoFullName, 260, fullChild));
  });

  it("keeps the identity of an old-shape brief: missing fields hash as null/empty", () => {
    const {
      designDecision: _dd,
      verifiedCurrentBehavior: _vcb,
      relevantPaths: _rp,
      inScope: _ins,
      outOfScope: _oos,
      dependencies: _deps,
      tests: _tests,
      ...oldShape
    } = fullChild;
    const oldShapeWithNulls: ChildBrief = {
      ...oldShape,
      designDecision: null,
      verifiedCurrentBehavior: null,
      relevantPaths: [],
      inScope: [],
      outOfScope: [],
      dependencies: [],
      tests: [],
    };
    expect(childBriefKey(parent.repoFullName, parent.number, oldShape as unknown as ChildBrief)).toBe(
      childBriefKey(parent.repoFullName, parent.number, oldShapeWithNulls),
    );
  });
});

describe("childBodyMarker", () => {
  it("embeds the child key in a dispatch-groomer HTML comment", () => {
    expect(childBodyMarker("abc123")).toBe("<!-- dispatch-groomer:child=abc123 -->");
  });
});

describe("renderChildIssueBody", () => {
  it("puts the marker first, the parent link, and a status/backlog footer", () => {
    const body = renderChildIssueBody({ brief: minimal, parent, decompositionReason: null, childKey: "k" });
    expect(body.split("\n")[0]).toBe("<!-- dispatch-groomer:child=k -->");
    expect(body).toContain(`Parent: ${parent.url}`);
    expect(body).toContain("This child starts as `status/backlog`");
  });

  it("omits sections whose content is null or empty", () => {
    const body = renderChildIssueBody({ brief: minimal, parent, decompositionReason: null, childKey: "k" });
    for (const heading of [
      "## Verified current behavior",
      "## Current relevant code paths",
      "## Settled design decision",
      "## In scope",
      "## Out of scope",
      "## Dependencies",
      "## Tests",
      "Decomposition reason:",
    ]) {
      expect(body).not.toContain(heading);
    }
  });

  it("renders a full brief deterministically, with checklist acceptance criteria", () => {
    const input = { brief: fullChild, parent, decompositionReason: "The dashboard bundles four independent features.", childKey: "abc" };
    const expected = `<!-- dispatch-groomer:child=abc -->

Parent: ${parent.url}

## Problem
Admins cannot search orders from the dashboard.

## Verified current behavior
Dashboard.tsx renders four unrelated legacy widgets.

## Current relevant code paths
- src/admin/Dashboard.tsx
- src/admin/routes.ts

## Settled design decision
Search lives in a dedicated admin sub-route.

## In scope
- the order search query and results list

## Out of scope
- moving the dashboard to the new design system

## Dependencies
- the refund approval queue child

## Acceptance criteria
- [ ] an admin can search orders by id and see the match

## Tests
- src/admin/orders-search.test.ts

---
Created by the Dispatch hosted groomer when it decomposed ${parent.url}.
Decomposition reason: The dashboard bundles four independent features.
This child starts as \`status/backlog\`: it needs its own evidence-backed grooming pass before it is worker-ready. Do not implement it directly from this brief.`;
    expect(renderChildIssueBody(input)).toBe(expected);
    expect(renderChildIssueBody(input)).toBe(expected);
  });

  it("neutralizes @-mentions so model text never carries a live mention", () => {
    const brief: ChildBrief = { ...minimal, problem: "Login drops the return URL; asked @user for input." };
    const body = renderChildIssueBody({ brief, parent, decompositionReason: null, childKey: "k" });
    expect(body).toContain("asked `@user` for input");
  });
});

describe("setDecompositionState", () => {
  function fakeClient() {
    const calls = { update: [] as Record<string, unknown>[], create: [] as Record<string, unknown>[] };
    const client: DecompositionStateClient = {
      issue: {
        update: (args) => {
          calls.update.push(args.data);
          return Promise.resolve({});
        },
      },
      auditLog: {
        create: (args) => {
          calls.create.push(args.data);
          return Promise.resolve({});
        },
      },
    };
    return { client, calls };
  }

  it("marks the issue decomposed and records the audit entry", async () => {
    const labels = ["status/backlog", "priority/p2"];
    const { client, calls } = fakeClient();
    await setDecompositionState(client, {
      issue: { id: "issue-1", labels },
      repoFullName: "acme/storefront",
      issueNumber: 260,
      actor: "hosted-groomer",
      decomposed: true,
      note: "split into four children",
      followUpUrls: ["https://github.com/acme/storefront/issues/261"],
    });
    labels.push("mutated-after");

    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({
      decomposed: true,
      decomposedBy: "hosted-groomer",
      decomposedNote: "split into four children",
      followUpUrls: ["https://github.com/acme/storefront/issues/261"],
    });
    expect(calls.update[0]!.decomposedAt).toBeInstanceOf(Date);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({
      actor: "hosted-groomer",
      action: "issue_decomposed",
      repoFullName: "acme/storefront",
      issueNumber: 260,
      issueId: "issue-1",
      beforeLabels: ["status/backlog", "priority/p2"],
      afterLabels: ["status/backlog", "priority/p2"],
      success: true,
    });
    expect(calls.create[0]!.notes).toBe(
      "Issue marked as decomposed. Note: split into four children. Follow-up URLs: https://github.com/acme/storefront/issues/261",
    );
  });

  it("reactivates with nulls and the reactivation note", async () => {
    const { client, calls } = fakeClient();
    await setDecompositionState(client, {
      issue: { id: "issue-1", labels: [] },
      repoFullName: "acme/storefront",
      issueNumber: 260,
      actor: "operator",
      decomposed: false,
      note: null,
      followUpUrls: [],
    });

    expect(calls.update[0]).toMatchObject({
      decomposed: false,
      decomposedAt: null,
      decomposedBy: null,
      decomposedNote: null,
      followUpUrls: [],
    });
    expect(calls.create[0]).toMatchObject({ action: "issue_reactivated" });
    expect(calls.create[0]!.notes).toBe("Issue reactivated (decomposed set to false)");
  });
});
