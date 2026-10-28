/**
 * dispatch#1452, live failure mode: already fixed, but the proof is incomplete.
 * The read shows the dedup guard in place, yet the acceptance wording cannot
 * be quoted verbatim — the read was truncated before the retry hook. An
 * already_done close on such proof must not land, and the honest answer is a
 * parked needs_info classified as an incomplete investigation.
 */
import { alreadyDone, parked, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

// What this run's read saw: the dedup guard at the top of charge(), then the
// read was cut off before the retry hook that would prove the criterion.
const PAYMENT_TS = `export async function charge(order: Order): Promise<Charge> {
  const existing = await charges.findFor(order.id);
  if (existing) {
    return existing;
  }
  const charge = await gateway.charge(order.total, order.card);
  await charges.record(order.id, charge);
`;

export const alreadyFixedProofIncomplete: GroomingCase = {
  id: "already-fixed-proof-incomplete",
  scenario:
    "The fix appears to have landed at head, but the proof is incomplete: the close cannot quote the acceptance wording verbatim, so it must not land.",
  regressionOf: "dispatch#1452 (live: an already-shipped fix parked on incomplete proof)",
  repoFullName: STOREFRONT,
  issue: {
    number: 332,
    title: "A retried payment charges the card twice",
    body: "When the gateway times out and the checkout retries, the card is charged a second time.\n\n## Acceptance criteria\n\n- [ ] A payment retry never charges the card a second time.",
    labels: ["priority/p1", "type/bug", "status/backlog"],
  },
  repository: {
    headSha: STOREFRONT_HEAD,
    read: ["src/checkout/payment.ts"],
    contents: { "src/checkout/payment.ts": PAYMENT_TS },
  },
  exploration: {
    toolCalls: [
      {
        name: "read_file",
        arguments: { path: "src/checkout/payment.ts" },
        preview: "export async function charge(...",
        truncated: true,
      },
    ],
    gaps: { truncatedReads: ["src/checkout/payment.ts"] },
  },
  forbidden: ["ready", "close"],
  candidates: [
    {
      name: "an already_done whose excerpt the file does not contain is rejected",
      output: alreadyDone({
        summary: "charge() dedupes by order id; a retry returns the existing charge.",
        rationale: "The dedup guard in payment.ts makes a second charge impossible.",
        evidence: ["repo:src/checkout/payment.ts"],
        closeEvidence: ["repo:src/checkout/payment.ts"],
        criteria: [
          [
            "A payment retry never charges the card a second time.",
            "repo:src/checkout/payment.ts",
            "the retry hook returns the existing charge before calling the gateway",
          ],
        ],
      }),
      expect: { accepted: false, rejectedFor: "not found verbatim in src/checkout/payment.ts" },
    },
    {
      name: "the same proof gap, declared investigation_incomplete, parks the issue",
      output: parked("needs_info", {
        summary: "The dedup guard is visible, but the proof of the retry path was truncated.",
        rationale: "The read of payment.ts was cut off before the retry hook, so the criterion cannot be quoted verbatim.",
        evidence: ["repo:src/checkout/payment.ts"],
        infoGap: {
          kind: "investigation_incomplete",
          question: "Does the retry path in payment.ts return the existing charge before calling the gateway?",
          whyToolsCannotAnswer: "the read of src/checkout/payment.ts was truncated before the retry hook could be quoted",
        },
      }),
      expect: { accepted: true, status: "status/backlog", ready: false, gapClass: "investigation_incomplete" },
    },
    {
      name: "a ready hedge at low confidence is rejected",
      output: readyImplementation({
        summary: "Make the payment retry path return the existing charge before calling the gateway.",
        confidence: "low",
        evidence: ["repo:src/checkout/payment.ts"],
        brief: {
          verified: {
            statement: "charge() dedupes by order id, but whether the retry path reaches the guard was not established this run.",
            evidence: ["repo:src/checkout/payment.ts"],
          },
          paths: [["repo:src/checkout/payment.ts", "modify"]],
        },
      }),
      expect: { accepted: false, rejectedFor: "verdict.confidence is low" },
    },
  ],
};
