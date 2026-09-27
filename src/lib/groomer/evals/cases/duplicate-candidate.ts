import { alreadyDone, parked } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const DUP = "github:issue:acme/storefront#212";

export const duplicateCandidate: GroomingCase = {
  id: "duplicate-candidate",
  scenario: "An open issue already tracks the same bug; duplicates are recorded, never auto-closed (#1069 gates that).",
  repoFullName: STOREFRONT,
  issue: {
    number: 250,
    title: "Order confirmation email is sent twice",
    body: "Customers get two confirmation emails when the payment provider retries the webhook.",
    labels: ["priority/p2", "type/bug"],
  },
  repository: { headSha: STOREFRONT_HEAD, read: ["src/notifications/order-confirmation.ts"] },
  relatedWork: [{ key: DUP, kind: "issue", state: "open", via: "read" }],
  forbidden: ["close"],
  candidates: [
    {
      name: "backlog, recommending a duplicate close of #212",
      output: parked("backlog", {
        summary: "Same root cause as #212 (webhook retries are not idempotent).",
        evidence: ["repo:src/notifications/order-confirmation.ts", DUP],
        relatedWork: [{ ref: DUP, relation: "duplicate_of", note: "same retry path" }],
        close: { reason: "duplicate", rationale: "#212 tracks the same retry bug.", evidenceRefs: [DUP] },
      }),
      expect: { accepted: true, status: "status/backlog", ready: false, closes: false },
    },
    {
      name: "a duplicate recommendation that never names the duplicate in relatedWork",
      output: parked("backlog", {
        summary: "Looks like a duplicate.",
        evidence: [DUP],
        close: { reason: "duplicate", rationale: "Probably a duplicate.", evidenceRefs: [DUP] },
      }),
      expect: { accepted: false, rejectedFor: 'must cite a relatedWork entry with relation "duplicate_of"' },
    },
    {
      name: "already_done because an open issue covers it",
      output: alreadyDone({ summary: "#212 covers this.", evidence: [DUP], closeEvidence: [DUP] }),
      expect: { accepted: false, rejectedFor: "already_done" },
    },
  ],
};
