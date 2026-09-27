import { parked, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT } from "./shared";

const evidence = ["repo:src/api/orders.ts"];
const PARKED = "backlog while the head is unpinned";

export const unpinnedSnapshot: GroomingCase = {
  id: "unpinned-snapshot",
  scenario: "The default-branch head could not be resolved, so nothing read this run is current.",
  repoFullName: STOREFRONT,
  issue: {
    number: 310,
    title: "Order history API returns 500 for guest orders",
    body: "GET /api/orders?guest=1 throws because customerId is null.",
    labels: ["priority/p1", "type/bug"],
  },
  repository: { headSha: null, read: ["src/api/orders.ts"] },
  forbidden: ["ready"],
  candidates: [
    {
      name: "ready on a read that was not pinned to any head",
      output: readyImplementation({
        summary: "Guard the null customerId.",
        evidence,
        brief: { verified: { statement: "listOrders dereferences customerId.", evidence }, paths: [["repo:src/api/orders.ts", "modify"]] },
      }),
      expect: { accepted: false, rejectedFor: "not pinned to a default-branch head SHA" },
    },
    {
      name: PARKED,
      output: parked("backlog", { summary: "Re-groom once the head resolves.", evidence }),
      expect: { accepted: true, status: "status/backlog", ready: false },
    },
  ],
  freshness: [
    {
      name: "a new commit does not re-groom an unpinned result in a loop",
      from: PARKED,
      event: { kind: "commit", files: ["src/api/orders.ts"] },
      stale: [],
    },
  ],
};
