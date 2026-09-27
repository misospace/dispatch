import { readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const verified = {
  statement: "applyDiscounts in src/checkout/pricing/totals.ts runs before the post-login cart merge.",
  evidence: ["repo:src/checkout/pricing/totals.ts"],
};

export const movedCodeReference: GroomingCase = {
  id: "moved-code-reference",
  scenario: "The issue points at a file and line that moved; the search index still surfaces the old path.",
  repoFullName: STOREFRONT,
  issue: {
    number: 214,
    title: "Checkout total ignores discount codes applied after login",
    body: "The bug is in `src/cart/totals.js` line 88: the discount is computed before the guest cart is merged.",
    labels: ["priority/p1", "type/bug", "status/backlog"],
    lane: "backlog",
  },
  repository: {
    headSha: STOREFRONT_HEAD,
    read: ["src/checkout/pricing/totals.ts", "src/checkout/pricing/totals.test.ts"],
    surfaced: ["src/cart/totals.js"],
  },
  forbidden: [],
  candidates: [
    {
      name: "ready on the stale path from the issue body (a search hit, never read)",
      output: readyImplementation({
        summary: "Fix the discount ordering in src/cart/totals.js.",
        evidence: ["repo:src/cart/totals.js"],
        brief: {
          verified: { statement: "Line 88 computes the discount first.", evidence: ["repo:src/cart/totals.js"] },
          paths: [["repo:src/cart/totals.js", "modify"]],
        },
      }),
      expect: { accepted: false, rejectedFor: "read at the pinned head SHA" },
    },
    {
      name: "ready on the new location, but only as a search hit",
      output: readyImplementation({
        summary: "Fix the discount ordering in the pricing module.",
        evidence: ["repo:src/cart/totals.js"],
        brief: { verified, paths: [["repo:src/checkout/pricing/totals.ts", "modify"]] },
      }),
      expect: { accepted: false, rejectedFor: "verdict.evidenceRefs must cite at least one repository source read" },
    },
    {
      name: "ready on a path that is in neither the issue nor the evidence",
      output: readyImplementation({
        summary: "Fix src/cart/discounts.js.",
        evidence: ["repo:src/cart/discounts.js"],
        brief: { verified, paths: [["repo:src/cart/discounts.js", "modify"]] },
      }),
      expect: { accepted: false, rejectedFor: 'unknown evidence reference "repo:src/cart/discounts.js"' },
    },
    {
      name: "ready on the moved file, read at head, with the stale reference corrected",
      output: readyImplementation({
        summary: "Move the discount step after the cart merge in src/checkout/pricing/totals.ts.",
        evidence: ["repo:src/checkout/pricing/totals.ts"],
        brief: {
          verified,
          paths: [
            ["repo:src/checkout/pricing/totals.ts", "modify"],
            ["repo:src/checkout/pricing/totals.test.ts", "modify"],
          ],
        },
      }),
      expect: { accepted: true, status: "status/ready", ready: true, admission: "implementation" },
    },
    {
      name: "ready on a pinned read, but the brief tells the worker to modify the stale path",
      output: readyImplementation({
        summary: "Fix the discount ordering.",
        evidence: ["repo:src/checkout/pricing/totals.ts"],
        brief: {
          verified,
          paths: [
            ["repo:src/cart/totals.js", "modify"],
            ["repo:src/checkout/pricing/totals.ts", "reference"],
          ],
        },
      }),
      expect: { accepted: false, rejectedFor: "src/cart/totals.js" },
    },
  ],
  freshness: [
    {
      name: "a commit touching the relied-on file invalidates the result",
      from: "ready on the moved file, read at head, with the stale reference corrected",
      event: { kind: "commit", files: ["src/checkout/pricing/totals.ts"] },
      stale: ["evidence_path_changed"],
    },
    {
      name: "a commit elsewhere in the repo does not",
      from: "ready on the moved file, read at head, with the stale reference corrected",
      event: { kind: "commit", files: ["README.md", "src/catalog/search.ts"] },
      stale: [],
    },
    {
      name: "a maintainer editing the body invalidates the result",
      from: "ready on the moved file, read at head, with the stale reference corrected",
      event: { kind: "issue_edit", body: "Actually it only happens with gift cards." },
      stale: ["issue_changed"],
    },
  ],
};
