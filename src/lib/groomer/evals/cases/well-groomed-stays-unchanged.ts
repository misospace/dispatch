import { readyImplementation, type BriefOptions } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const evidence = ["repo:src/admin/orders/OrdersTable.tsx", "repo:src/lib/csv.ts"];
const brief: BriefOptions = {
  verified: { statement: "OrdersTable has no export action; src/lib/csv.ts already has toCsv(rows, columns).", evidence },
  paths: [
    ["repo:src/admin/orders/OrdersTable.tsx", "modify"],
    ["repo:src/lib/csv.ts", "reference"],
  ],
  criteria: [["exporting the current filter downloads a CSV with the visible columns", "automated_test"]],
};
const CONFIRMED = "re-confirms ready with no rewrites";

export const wellGroomedStaysUnchanged: GroomingCase = {
  id: "well-groomed-stays-unchanged",
  scenario: "A well-groomed ready issue is re-groomed; it should come out essentially unchanged.",
  repoFullName: STOREFRONT,
  issue: {
    number: 280,
    title: "Add CSV export for the orders table",
    body: [
      "## Problem",
      "Support staff copy orders into spreadsheets by hand.",
      "",
      "## Acceptance criteria",
      "- An Export button on the orders table downloads the current filter as CSV.",
      "- Columns match the visible table columns.",
      "",
      "## Files",
      "- src/admin/orders/OrdersTable.tsx",
      "- src/lib/csv.ts (reuse toCsv)",
    ].join("\n"),
    labels: ["priority/p2", "type/feature", "status/ready"],
    lane: "local",
  },
  repository: { headSha: STOREFRONT_HEAD, read: ["src/admin/orders/OrdersTable.tsx", "src/lib/csv.ts"] },
  forbidden: ["title_change", "body_change", "label_change"],
  candidates: [
    {
      name: CONFIRMED,
      output: readyImplementation({ summary: "Still ready: the export reuses toCsv.", evidence, brief }),
      expect: { accepted: true, status: "status/ready", ready: true, admission: "implementation" },
    },
    {
      name: "re-confirms ready but proposes a rewritten title and body",
      output: readyImplementation({
        summary: "Still ready.",
        evidence,
        brief,
        proposedTitle: "Orders table: add a CSV export button using toCsv",
        proposedBody: "Add an export button to OrdersTable that calls toCsv. (Rewritten by the groomer.)",
      }),
      expect: { accepted: true, status: "status/ready", ready: true },
    },
    {
      name: "re-confirms ready but reshuffles priority and type (validator cannot tell; the scorer must)",
      output: readyImplementation({
        summary: "Still ready.",
        evidence,
        brief,
        labelsToAdd: ["priority/p1", "type/chore"],
        labelsToRemove: ["priority/p2", "type/feature"],
      }),
      expect: { accepted: true, status: "status/ready", ready: true, violations: ["forbidden:label_change"] },
    },
  ],
  freshness: [
    {
      name: "the groomer's own applied state reads back as unchanged",
      from: CONFIRMED,
      event: { kind: "none" },
      stale: [],
    },
    {
      name: "a worker's agent/* claim label is not a grooming change",
      from: CONFIRMED,
      event: { kind: "issue_edit", addLabels: ["agent/koji"] },
      stale: [],
    },
    {
      name: "a maintainer retitling it is",
      from: CONFIRMED,
      event: { kind: "issue_edit", title: "Add CSV and XLSX export for the orders table" },
      stale: ["issue_changed"],
    },
  ],
  pending: [
    { name: "body enrichment replaces one Dispatch-managed section and preserves the human text", on: "#1063" },
  ],
};
