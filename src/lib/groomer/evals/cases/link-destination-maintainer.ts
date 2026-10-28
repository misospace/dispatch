/**
 * dispatch#1452, live failure mode: a documentation link with no recorded
 * destination. The run's exploration completed cleanly — no failed tools, no
 * truncated reads — so the model's declared human question stands: this is a
 * maintainer choice, classified as human_question, not an investigation that
 * never finished.
 */
import { parked, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const BILLING_TSX = `export function BillingSettings() {
  return (
    <section>
      <h1>Billing</h1>
      <p>Manage your billing profile.</p>
    </section>
  );
}
`;

export const linkDestinationMaintainer: GroomingCase = {
  id: "link-destination-maintainer",
  scenario:
    "The issue asks for a documentation link but names no destination; on a clean run the genuine maintainer choice classifies as a human question.",
  regressionOf: "dispatch#1452 (live: a documentation link with no recorded destination)",
  repoFullName: STOREFRONT,
  issue: {
    number: 333,
    title: "Surface the billing documentation link on the settings page",
    body: "Merchants ask where the billing docs live; add a link to them on the checkout settings page.",
    labels: ["priority/p3", "type/feature"],
  },
  repository: {
    headSha: STOREFRONT_HEAD,
    read: ["src/settings/billing.tsx"],
    contents: { "src/settings/billing.tsx": BILLING_TSX },
  },
  forbidden: ["implementation_admission"],
  candidates: [
    {
      name: "needs_info asking which page hosts the link is a human question",
      output: parked("needs_info", {
        summary: "The issue names no documentation destination; a maintainer must pick the page.",
        rationale: "No documentation page is recorded in the repository or its history, so the destination is a maintainer choice.",
        evidence: ["repo:src/settings/billing.tsx"],
        infoGap: {
          kind: "product_decision",
          question: "Which documentation page should host the billing link?",
          whyToolsCannotAnswer: "no documentation destination is recorded in the repository or its history",
        },
      }),
      expect: { accepted: true, status: "status/backlog", ready: false, gapClass: "human_question" },
    },
    {
      name: "a ready hedge whose acceptance criterion is subjective is rejected",
      output: readyImplementation({
        summary: "Add the billing documentation link to the settings page.",
        evidence: ["repo:src/settings/billing.tsx"],
        brief: {
          verified: {
            statement: "billing.tsx renders the settings section with no documentation link.",
            evidence: ["repo:src/settings/billing.tsx"],
          },
          paths: [["repo:src/settings/billing.tsx", "modify"]],
          criteria: [["the link is visible and looks right", "subjective"]],
        },
      }),
      expect: { accepted: false, rejectedFor: "is not deterministic" },
    },
  ],
};
