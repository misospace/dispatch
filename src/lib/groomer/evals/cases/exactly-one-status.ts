import { parked, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { DISPATCH, DISPATCH_HEAD } from "./shared";

const evidence = ["repo:src/components/IssueCard.tsx"];
const issueBody = "IssueCard shows the agent label but not who holds the active lease, so a stale claim looks live.";

export const exactlyOneStatus: GroomingCase = {
  id: "exactly-one-status",
  scenario: "An issue that drifted to two status labels comes out of any groom with exactly one.",
  regressionOf: "dispatch#941 / #943",
  repoFullName: DISPATCH,
  issue: {
    number: 940,
    title: "Queue: show the lease holder on the issue card",
    body: issueBody,
    labels: ["priority/p2", "type/feature", "status/ready", "status/blocked"],
    lane: "local",
  },
  repository: { headSha: DISPATCH_HEAD, read: ["src/components/IssueCard.tsx"] },
  forbidden: [],
  candidates: [
    {
      name: "re-grooms to backlog",
      output: parked("backlog", { summary: "Needs a lease API field first.", evidence }),
      expect: { accepted: true, status: "status/backlog", ready: false },
    },
    {
      name: "re-grooms to blocked",
      output: parked("blocked", { summary: "Blocked on the lease API.", evidence }),
      expect: { accepted: true, status: "status/blocked", ready: false },
    },
    {
      name: "re-confirms ready",
      output: readyImplementation({
        summary: "Render lease.agentName on the card.",
        evidence,
        brief: {
          verified: { statement: "IssueCard renders agent labels only.", evidence },
          paths: [["repo:src/components/IssueCard.tsx", "modify"]],
        },
      }),
      expect: { accepted: true, status: "status/ready", ready: true },
    },
    {
      name: "backlog that tries to strip the status labels itself",
      output: parked("backlog", { summary: "Park it.", evidence, labelsToRemove: ["status/ready", "status/blocked"] }),
      expect: { accepted: false, rejectedFor: "status is derived from verdict.actionability" },
    },
  ],
};

export const exactlyOneStatusForeignLabel: GroomingCase = {
  id: "exactly-one-status-foreign-label",
  scenario: "An issue carries a status/* label the groomer does not own; the derived status must still be the one that remains.",
  regressionOf: "dispatch#941 / #943 (the external groom route already strips every other status)",
  repoFullName: DISPATCH,
  issue: {
    number: 944,
    title: "Queue: show the lease holder on the issue card",
    body: issueBody,
    labels: ["priority/p2", "type/feature", "status/needs-review"],
    lane: "backlog",
  },
  repository: { headSha: DISPATCH_HEAD, read: ["src/components/IssueCard.tsx"] },
  forbidden: [],
  candidates: [
    {
      name: "re-confirms ready",
      output: readyImplementation({
        summary: "Render lease.agentName on the card.",
        evidence,
        brief: {
          verified: { statement: "IssueCard renders agent labels only.", evidence },
          paths: [["repo:src/components/IssueCard.tsx", "modify"]],
        },
      }),
      expect: { accepted: true, status: "status/ready", ready: true },
    },
    {
      name: "re-grooms to backlog",
      output: parked("backlog", { summary: "Needs a lease API field first.", evidence }),
      expect: { accepted: true, status: "status/backlog", ready: false },
      knownBug:
        "run.ts ensureSingleStatusLabel keeps the first status present for a non-ready plan, so status/needs-review survives and the derived status/backlog is dropped",
    },
  ],
};
