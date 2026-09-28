import { parked, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const COUPON = "repo:src/checkout/coupon.ts";
const PR = "github:pr:acme/storefront#301";
const COMMENT = "comment:9001";

const ready = (relatedRef: string) =>
  readyImplementation({
    summary: "Stacked coupons skip the minimum-order check; apply it per coupon.",
    evidence: [COUPON],
    relatedWork: [{ ref: relatedRef, relation: "related", note: "introduced coupon stacking" }],
    brief: {
      verified: { statement: "applyCoupons checks the minimum order once, before the first coupon.", evidence: [COUPON] },
      paths: [[COUPON, "modify"]],
    },
  });

export const evidenceIdAsRelatedWork: GroomingCase = {
  id: "evidence-id-as-related-work",
  scenario:
    "The model cites an evidence-catalog id (a comment, a file, the issue itself) where only a related-work id is valid; a repair turn or a degrade keeps the plan, but never a close that relied on it.",
  regressionOf: "dispatch#1126: most hosted-groomer failures were this one reference-format mistake",
  repoFullName: STOREFRONT,
  issue: {
    number: 305,
    title: "Stacked coupons bypass the minimum order value",
    body: "Since coupon stacking shipped, a second coupon is applied even when the order drops below the minimum.",
    labels: ["priority/p1", "type/bug"],
  },
  comments: [
    { id: 9001, author: "maintainer", body: "Probably a regression from the stacking PR.", createdAt: "2026-09-20T00:00:00Z" },
  ],
  repository: { headSha: STOREFRONT_HEAD, read: ["src/checkout/coupon.ts"] },
  relatedWork: [{ key: PR, kind: "pull_request", state: "merged", via: "read" }],
  forbidden: ["close"],
  candidates: [
    {
      name: "cites the maintainer's comment as related work, then repairs it to the PR the comment meant",
      output: ready(COMMENT),
      repair: ready(PR),
      expect: { accepted: true, status: "status/ready", ready: true, admission: "implementation" },
    },
    {
      name: "cites the issue itself as related work and repeats it on repair: the entry is dropped",
      output: ready("issue"),
      expect: { accepted: true, status: "status/ready", ready: true, admission: "implementation" },
    },
    {
      name: "a duplicate recommendation resting on a comment cited as related work",
      output: parked("backlog", {
        summary: "The maintainer thinks this duplicates the stacking regression.",
        evidence: [COUPON, COMMENT],
        relatedWork: [{ ref: COMMENT, relation: "duplicate_of", note: "the maintainer's guess" }],
        close: { reason: "duplicate", rationale: "Same regression.", evidenceRefs: [COMMENT] },
      }),
      expect: { accepted: false, rejectedFor: 'must cite a relatedWork entry with relation "duplicate_of"' },
    },
  ],
};
