import { children, parked, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const AREAS = ["Admin order search", "Refund approval queue", "Inventory low-stock alerts", "Sales analytics page"];
const verified = {
  statement: "Dashboard.tsx renders four unrelated legacy widgets; routes.ts has no admin sub-routes.",
  evidence: ["repo:src/admin/Dashboard.tsx", "repo:src/admin/routes.ts"],
};

export const broadNeedsDecomposition: GroomingCase = {
  id: "broad-needs-decomposition",
  scenario: "A broad epic must be split into bounded children, not handed to one worker.",
  repoFullName: STOREFRONT,
  issue: {
    number: 260,
    title: "Rebuild the admin dashboard",
    body: "The admin dashboard needs order search, refund approvals, inventory alerts and a sales analytics page. Also move it to the new design system.",
    labels: ["priority/p2", "type/feature"],
  },
  repository: { headSha: STOREFRONT_HEAD, read: ["src/admin/Dashboard.tsx", "src/admin/routes.ts"] },
  forbidden: ["implementation_admission"],
  candidates: [
    {
      name: "ready as one implementation task while flagging that it must be split",
      output: readyImplementation({
        summary: "Rebuild the dashboard.",
        evidence: ["repo:src/admin/Dashboard.tsx"],
        brief: { verified, paths: [["repo:src/admin/Dashboard.tsx", "modify"]] },
        decomposition: children(AREAS),
      }),
      expect: { accepted: false, rejectedFor: "decomposition.required is true" },
    },
    {
      name: "backlog with four bounded child briefs",
      output: parked("backlog", {
        summary: "Four independent features; split before any worker picks it up.",
        evidence: ["repo:src/admin/Dashboard.tsx", "repo:src/admin/routes.ts"],
        decomposition: children(AREAS),
      }),
      expect: { accepted: true, status: "status/backlog", ready: false },
    },
    {
      name: "backlog that splits into twelve children",
      output: parked("backlog", {
        summary: "Split into many small tasks.",
        evidence: ["repo:src/admin/Dashboard.tsx"],
        decomposition: children(Array.from({ length: 12 }, (_, i) => `Dashboard slice number ${i + 1}`)),
      }),
      expect: { accepted: false, rejectedFor: "decomposition.childBriefs: must have at most 8 items" },
    },
    {
      name: "backlog that says to split but names no children",
      output: parked("backlog", {
        summary: "Needs splitting.",
        evidence: ["repo:src/admin/Dashboard.tsx"],
        decomposition: [],
      }),
      expect: { accepted: false, rejectedFor: "required decomposition must describe at least one child" },
    },
    {
      name: "ready as one task, never mentioning its breadth (validator cannot tell; the scorer must)",
      output: readyImplementation({
        summary: "Rebuild Dashboard.tsx.",
        evidence: ["repo:src/admin/Dashboard.tsx"],
        brief: { verified, paths: [["repo:src/admin/Dashboard.tsx", "modify"]] },
      }),
      expect: {
        accepted: true,
        status: "status/ready",
        ready: true,
        admission: "implementation",
        violations: ["forbidden:implementation_admission"],
      },
    },
  ],
  pending: [{ name: "accepted child briefs are created once, idempotently", on: "#1066" }],
};
