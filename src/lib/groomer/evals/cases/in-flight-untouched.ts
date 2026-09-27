import { alreadyDone, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const evidence = ["repo:src/api/orders.ts"];

export const inFlightUntouched: GroomingCase = {
  id: "in-flight-untouched",
  scenario: "A worker holds the issue (status/in-progress); a groom records its plan but mutates nothing.",
  repoFullName: STOREFRONT,
  issue: {
    number: 300,
    title: "Paginate the order history API",
    body: "GET /api/orders returns every order; add cursor pagination.",
    labels: ["priority/p2", "type/feature", "status/in-progress", "agent/koji"],
    lane: "local",
  },
  repository: { headSha: STOREFRONT_HEAD, read: ["src/api/orders.ts"] },
  forbidden: ["github_write"],
  candidates: [
    {
      name: "ready re-groom while a worker holds it",
      output: readyImplementation({
        summary: "Add cursor pagination.",
        evidence,
        githubComment: "Re-groomed: still ready.",
        brief: {
          verified: { statement: "listOrders has no limit.", evidence },
          paths: [["repo:src/api/orders.ts", "modify"]],
        },
      }),
      expect: { accepted: true, status: "status/ready", ready: true },
    },
    {
      name: "already_done while a worker holds it",
      output: alreadyDone({ summary: "listOrders already paginates.", evidence, closeEvidence: evidence }),
      expect: { accepted: true, status: "status/done", ready: false, closes: false },
    },
  ],
};
