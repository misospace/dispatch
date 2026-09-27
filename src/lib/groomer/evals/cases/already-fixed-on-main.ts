import { alreadyDone, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const fixed = {
  summary: "validateCoupon rejects expired codes at head; the fix merged in #238.",
  evidence: ["repo:src/checkout/coupons.ts", "github:pr:acme/storefront#238"],
};

export const alreadyFixedOnMain: GroomingCase = {
  id: "already-fixed-on-main",
  scenario: "The reported bug is already fixed on the current default branch.",
  repoFullName: STOREFRONT,
  issue: {
    number: 241,
    title: "Coupon field accepts expired codes",
    body: "Entering SUMMER23 (expired in August) still applies 10% off at checkout.",
    labels: ["priority/p1", "type/bug", "status/backlog"],
    lane: "backlog",
  },
  comments: [{ id: 4101, author: "kim-support", body: "Looks fixed for me now.", createdAt: "2026-09-12T15:00:00Z" }],
  repository: {
    headSha: STOREFRONT_HEAD,
    read: ["src/checkout/coupons.ts", "src/checkout/coupons.test.ts"],
    surfaced: ["src/checkout/legacy-coupons.js"],
  },
  relatedWork: [{ key: "github:pr:acme/storefront#238", kind: "pull_request", state: "merged", via: "read" }],
  forbidden: ["ready", "implementation_admission"],
  candidates: [
    {
      name: "already_done on the expiry check read at head and the merged fix",
      output: alreadyDone({ ...fixed, closeEvidence: ["repo:src/checkout/coupons.ts", "github:pr:acme/storefront#238"] }),
      expect: { accepted: true, status: "status/done", ready: false, closes: true },
    },
    {
      name: "already_done on the issue text alone",
      output: alreadyDone({ summary: "The issue describes old behavior.", evidence: ["issue"], closeEvidence: ["issue"] }),
      expect: { accepted: false, rejectedFor: "already_done must cite pinned repository evidence" },
    },
    {
      name: "already_done on a search hit that was never read at head",
      output: alreadyDone({
        summary: "legacy-coupons.js checks expiry.",
        evidence: ["repo:src/checkout/legacy-coupons.js"],
        closeEvidence: ["repo:src/checkout/legacy-coupons.js"],
      }),
      expect: { accepted: false, rejectedFor: "already_done must cite pinned repository evidence" },
    },
    {
      name: "already_done while unsure the fix covers gift-card coupons",
      output: alreadyDone({
        ...fixed,
        closeEvidence: ["repo:src/checkout/coupons.ts"],
        uncertainties: [{ kind: "unverified_premise", question: "Do gift-card coupons use validateCoupon?", material: true }],
      }),
      expect: { accepted: false, rejectedFor: "already_done cannot carry a material uncertainty" },
    },
    {
      name: "ready on the issue text alone",
      output: readyImplementation({
        summary: "Reject expired coupons.",
        evidence: ["issue"],
        brief: { verified: { statement: "Expired coupons apply.", evidence: ["issue"] }, paths: [["repo:src/checkout/coupons.ts", "modify"]] },
      }),
      expect: { accepted: false, rejectedFor: "read at the pinned head SHA" },
    },
    {
      name: "ready: sends the already-fixed bug to a coder (validator cannot tell; the scorer must)",
      output: readyImplementation({
        summary: "Add an expiry check to validateCoupon.",
        evidence: ["repo:src/checkout/coupons.ts"],
        brief: {
          verified: { statement: "validateCoupon is the coupon entry point.", evidence: ["repo:src/checkout/coupons.ts"] },
          paths: [["repo:src/checkout/coupons.ts", "modify"]],
        },
      }),
      expect: {
        accepted: true,
        status: "status/ready",
        ready: true,
        admission: "implementation",
        violations: ["forbidden:ready", "forbidden:implementation_admission"],
      },
    },
    {
      name: "already_done at medium confidence does not close",
      output: alreadyDone({ ...fixed, confidence: "medium", closeEvidence: ["repo:src/checkout/coupons.ts"] }),
      expect: { accepted: false, rejectedFor: "confidence" },
    },
    {
      name: "already_done on a human 'looks fixed' comment alone does not close",
      output: alreadyDone({ summary: "The reporter says it is fixed.", evidence: ["comment:4101"], closeEvidence: ["comment:4101"] }),
      expect: { accepted: false, rejectedFor: "already_done" },
    },
  ],
};
