import { parked, readyDesign, readyImplementation } from "../drafts";
import type { Uncertainty } from "../../plan";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const STORAGE_CHOICE: Uncertainty = {
  kind: "design_choice",
  question: "Store a price per currency, or convert from USD at read time with a daily FX rate?",
  material: true,
};
const evidence = ["repo:src/checkout/pricing/money.ts", "repo:prisma/schema.prisma"];
const verified = { statement: "Money is a USD-cents integer everywhere; Product has one price column.", evidence };

export const unresolvedArchitecture: GroomingCase = {
  id: "unresolved-architecture",
  scenario: "The issue hinges on an open architecture choice; it must not become an invented implementation brief.",
  repoFullName: STOREFRONT,
  issue: {
    number: 270,
    title: "Support multi-currency pricing",
    body: "We need EUR and GBP prices. Open question: store per-currency prices, or convert from USD at read time?",
    labels: ["priority/p2", "type/feature"],
  },
  repository: { headSha: STOREFRONT_HEAD, read: ["src/checkout/pricing/money.ts", "prisma/schema.prisma"] },
  forbidden: ["implementation_admission"],
  candidates: [
    {
      name: "ready implementation with the storage choice still open",
      output: readyImplementation({
        summary: "Add currency support.",
        evidence,
        uncertainties: [STORAGE_CHOICE],
        brief: { verified, paths: [["repo:src/checkout/pricing/money.ts", "modify"]] },
      }),
      expect: { accepted: false, rejectedFor: "material uncertainty remains" },
    },
    {
      name: "ready implementation that silently picks convert-at-read (validator cannot tell; the scorer must)",
      output: readyImplementation({
        summary: "Convert USD prices at read time with a daily FX rate.",
        evidence,
        brief: { verified, paths: [["repo:src/checkout/pricing/money.ts", "modify"]], filesToCreate: ["src/checkout/pricing/fx.ts"] },
      }),
      expect: {
        accepted: true,
        status: "status/ready",
        ready: true,
        admission: "implementation",
        violations: ["forbidden:implementation_admission"],
      },
    },
    {
      name: "ready design work routed to the default implementation lane",
      output: readyDesign({ summary: "Decide the currency model.", evidence, lane: "local", uncertainties: [STORAGE_CHOICE] }),
      expect: { accepted: false, rejectedFor: 'design work must route to the escalation lane "frontier"' },
    },
    {
      name: "ready design decision routed to the escalation lane",
      output: readyDesign({ summary: "Decide the currency storage model before any implementation.", evidence, uncertainties: [STORAGE_CHOICE] }),
      expect: { accepted: true, status: "status/ready", ready: true, admission: "escalation" },
    },
    {
      name: "backlog design work awaiting a maintainer decision",
      output: parked("backlog", {
        workType: "design",
        summary: "Needs a maintainer decision on the currency model.",
        evidence,
        uncertainties: [STORAGE_CHOICE],
      }),
      expect: { accepted: true, status: "status/backlog", ready: false, admission: null },
    },
  ],
};
