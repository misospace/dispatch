/**
 * dispatch#1452, live failure mode: a timed-out code search. The exploration
 * loop broke — a search that never came back, a read cut off before the
 * routing step, an aborted loop — and the model's needs_info was parked on a
 * question nobody was really owed. The run's own gap facts must classify the
 * verdict as an incomplete investigation, whatever kind the model declares,
 * so it keeps retrying on the bounded schedule instead of stalling.
 */
import { parked, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

// What this run's broken investigation actually saw: the matcher read was
// cut off before the routing step it needed.
const ROUTER_TS = `export function routeAlert(alert: Alert, routes: AlertRoute[]): AlertRoute {
  return routes.find((route) => route.channel === alert.channel) ?? routes[0];
}
`;
const MATCHER_TS = `export function matchAlert(alert: Alert, rules: AlertRule[]): boolean {
  return rules.some((rule) => rule.matches
`;

export const toolGapTimedOutSearch: GroomingCase = {
  id: "tool-gap-timed-out-search",
  scenario:
    "The run's investigation broke — a code search timed out and the loop aborted — so any needs_info verdict on top of it classifies as an incomplete investigation, whatever kind the model declares.",
  regressionOf: "dispatch#1452 (live: a timed-out search parked as a maintainer question)",
  repoFullName: STOREFRONT,
  issue: {
    number: 331,
    title: "Failed-order alerts are not routed to on-call",
    body: "When an order fails at checkout, the alert is matched but nobody receives it. The routing step is unclear.",
    labels: ["priority/p1", "type/bug"],
  },
  repository: {
    headSha: STOREFRONT_HEAD,
    read: ["src/alerts/router.ts", "src/alerts/matcher.ts"],
    contents: { "src/alerts/router.ts": ROUTER_TS, "src/alerts/matcher.ts": MATCHER_TS },
  },
  exploration: {
    toolCalls: [
      { name: "search_code", arguments: { query: "routeAlert on-call" }, ok: false, preview: "search_code timed out after 30s" },
      { name: "read_file", arguments: { path: "src/alerts/matcher.ts" }, preview: "export function matchAlert(...", truncated: true },
    ],
    gaps: { toolFailures: ["search_code"], truncatedReads: ["src/alerts/matcher.ts"], aborted: true },
  },
  forbidden: ["ready", "close", "implementation_admission"],
  candidates: [
    {
      name: "needs_info naming the timed-out search stays an incomplete investigation",
      output: parked("needs_info", {
        summary: "The code search that would have located the routing step timed out, so this run cannot decide.",
        rationale:
          "The search timed out and the matcher read was cut off before the routing step, so the evidence this run needed was never read.",
        evidence: ["repo:src/alerts/router.ts", "repo:src/alerts/matcher.ts"],
        infoGap: {
          kind: "investigation_incomplete",
          question: "Which step of the alert pipeline routes a matched alert to on-call, and why did it drop for failed orders?",
          whyToolsCannotAnswer:
            "the search timed out and the matcher read was truncated before the routing step, so the evidence this run needed was never read",
        },
      }),
      expect: { accepted: true, status: "status/backlog", ready: false, gapClass: "investigation_incomplete" },
    },
    {
      name: "the same broken run claiming a maintainer decision still resolves to investigation_incomplete",
      output: parked("needs_info", {
        summary: "The routing channel for failed-order alerts is a product choice.",
        rationale: "No routing policy is recorded in the repository, so a maintainer must pick the channel.",
        evidence: ["repo:src/alerts/router.ts"],
        infoGap: {
          kind: "product_decision",
          question: "Should failed-order alerts route to the on-call channel or the general engineering channel?",
          whyToolsCannotAnswer: "no routing policy is recorded in the repository or its history",
        },
      }),
      expect: { accepted: true, status: "status/backlog", ready: false, gapClass: "investigation_incomplete" },
    },
    {
      name: "a ready hedge at low confidence is rejected",
      output: readyImplementation({
        summary: "Route failed-order alerts to on-call from the matcher.",
        confidence: "low",
        evidence: ["repo:src/alerts/router.ts", "repo:src/alerts/matcher.ts"],
        brief: {
          verified: {
            statement: "matcher.ts matches alert rules; the routing step after the match was not read this run.",
            evidence: ["repo:src/alerts/matcher.ts"],
          },
          paths: [["repo:src/alerts/matcher.ts", "modify"]],
        },
      }),
      expect: { accepted: false, rejectedFor: "verdict.confidence is low" },
    },
  ],
};
