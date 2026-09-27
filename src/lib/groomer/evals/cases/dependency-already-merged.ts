import { parked, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const verified = {
  statement: "GET /api/refunds/:id returns refund.status; OrderDetail.tsx does not render it yet.",
  evidence: ["repo:src/api/refunds.ts", "repo:src/orders/OrderDetail.tsx"],
};

const READY = "ready: the dependency is recorded closed, with the GitHub state it was read at";

export const dependencyAlreadyMerged: GroomingCase = {
  id: "dependency-already-merged",
  scenario: "The issue still says it depends on #229, but #229 was closed by a merged PR.",
  repoFullName: STOREFRONT,
  issue: {
    number: 230,
    title: "Show refund status on the order detail page",
    body: "Depends on #229 (refund status API).\n\nOnce the API exposes refund.status, show it on the order detail page.",
    labels: ["priority/p2", "type/feature", "status/blocked"],
    lane: "backlog",
  },
  repository: {
    headSha: STOREFRONT_HEAD,
    read: ["src/api/refunds.ts", "src/orders/OrderDetail.tsx"],
  },
  relatedWork: [
    { key: "github:issue:acme/storefront#229", kind: "issue", state: "closed", via: "read" },
    { key: "github:pr:acme/storefront#233", kind: "pull_request", state: "merged", via: "read" },
  ],
  trackedIssues: [{ number: 229, state: "closed" }],
  closedDependencies: ["acme/storefront#229"],
  forbidden: [],
  candidates: [
    {
      name: "stays blocked, stating the closed dependency is open against its own evidence",
      output: parked("blocked", {
        summary: "Blocked on #229.",
        evidence: ["github:issue:acme/storefront#229"],
        brief: {
          verified,
          dependencies: [{ ref: "#229", state: "open", evidenceRef: "github:issue:acme/storefront#229" }],
        },
      }),
      expect: { accepted: false, rejectedFor: "contradicts the cited evidence (github:issue:acme/storefront#229 is closed)" },
    },
    {
      name: "stays blocked on #229 without citing its state (the model misread the body)",
      output: parked("blocked", {
        summary: "Blocked until the refund API from #229 lands.",
        evidence: ["issue"],
        brief: { verified, dependencies: [{ ref: "#229", state: "open", evidenceRef: null }] },
      }),
      expect: { accepted: true, status: "status/blocked", ready: false, violations: ["dependency-truth"] },
    },
    {
      name: READY,
      output: readyImplementation({
        summary: "The refund API from #229 shipped in #233; render refund.status on the order page.",
        evidence: ["repo:src/api/refunds.ts", "github:pr:acme/storefront#233"],
        brief: {
          verified,
          paths: [
            ["repo:src/orders/OrderDetail.tsx", "modify"],
            ["repo:src/api/refunds.ts", "reference"],
          ],
          dependencies: [{ ref: "#229", state: "closed", evidenceRef: "github:issue:acme/storefront#229" }],
        },
      }),
      expect: { accepted: true, status: "status/ready", ready: true, admission: "implementation" },
    },
  ],
  freshness: [
    {
      name: "the dependency reopening invalidates the ready result",
      from: READY,
      event: { kind: "dependency_state", number: 229, state: "open" },
      stale: ["dependency_changed"],
    },
    {
      name: "nothing changing leaves it fresh",
      from: READY,
      event: { kind: "none" },
      stale: [],
    },
  ],
};
