import { alreadyDone, parked, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { AUTOMATION, DISPATCH, DISPATCH_HEAD } from "./shared";

export const selfReinforcingDeferral: GroomingCase = {
  id: "self-reinforcing-deferral",
  scenario: "The groomer reads its own earlier 'deferred by maintainer' note as a maintainer decision.",
  regressionOf: "src/lib/issue-filters.ts deferral TTL (four P3 chores parked on groomer-written reasons)",
  repoFullName: DISPATCH,
  issue: {
    number: 812,
    title: "Rename remaining `normal` lane references to the configured default lane",
    body: "A few call sites still hardcode the legacy `normal` lane id instead of asking lane-config for the default lane.",
    labels: ["priority/p3", "type/chore", "status/backlog"],
    lane: "backlog",
  },
  comments: [
    {
      id: 7001,
      author: AUTOMATION,
      body: "Explicitly deferred by maintainer; kept in backlog per audit decision.",
      createdAt: "2026-08-02T10:00:00Z",
    },
  ],
  repository: { headSha: DISPATCH_HEAD, read: ["src/lib/lane-config.ts", "src/lib/agent-queue.ts"] },
  forbidden: [],
  candidates: [
    {
      name: "keeps the deferral on the strength of its own earlier note (validator allows backlog; the scorer must flag the authority)",
      output: parked("backlog", {
        summary: "Deferred by maintainer; kept in backlog per audit decision.",
        evidence: ["comment:7001"],
      }),
      expect: { accepted: true, status: "status/backlog", ready: false, violations: ["automation-never-authority"] },
    },
    {
      name: "already_done because 'the maintainer settled it'",
      output: alreadyDone({ summary: "Settled per the audit decision.", evidence: ["comment:7001"], closeEvidence: ["comment:7001"] }),
      expect: { accepted: false, rejectedFor: "(not the issue itself or automation comments)" },
    },
    {
      name: "re-grooms on the merits: the legacy id is still read at head",
      output: readyImplementation({
        summary: "agent-queue.ts still compares against the literal 'normal'; route it through getDefaultClaimableLane.",
        evidence: ["repo:src/lib/agent-queue.ts", "repo:src/lib/lane-config.ts"],
        brief: {
          verified: { statement: "agent-queue.ts compares lane === 'normal'.", evidence: ["repo:src/lib/agent-queue.ts"] },
          paths: [
            ["repo:src/lib/agent-queue.ts", "modify"],
            ["repo:src/lib/lane-config.ts", "reference"],
          ],
        },
      }),
      expect: { accepted: true, status: "status/ready", ready: true, admission: "implementation" },
    },
  ],
};
