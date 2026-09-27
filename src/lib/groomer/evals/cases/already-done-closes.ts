import { alreadyDone } from "../drafts";
import type { GroomingCase } from "../types";
import { DISPATCH, DISPATCH_HEAD } from "./shared";

const done = {
  summary: "selector.ts no longer exports legacyLaneMap at head; #949 removed it.",
  evidence: ["repo:src/lib/groomer/selector.ts", "github:pr:misospace/dispatch#949"],
  closeEvidence: ["repo:src/lib/groomer/selector.ts"],
};

const withoutClose = alreadyDone(done);
withoutClose.mutations.close = null;

export const alreadyDoneCloses: GroomingCase = {
  id: "already-done-closes",
  scenario: "An already_done verdict closes the issue and leaves exactly status/done, instead of parking it open in backlog.",
  regressionOf: "dispatch#957 / #958",
  repoFullName: DISPATCH,
  issue: {
    number: 955,
    title: "Groomer: remove the unused legacyLaneMap export from selector.ts",
    body: "legacyLaneMap is exported from src/lib/groomer/selector.ts but nothing imports it.",
    labels: ["priority/p3", "type/chore", "status/backlog"],
    lane: "backlog",
  },
  repository: { headSha: DISPATCH_HEAD, read: ["src/lib/groomer/selector.ts"] },
  relatedWork: [{ key: "github:pr:misospace/dispatch#949", kind: "pull_request", state: "merged", via: "read" }],
  forbidden: ["ready"],
  candidates: [
    {
      name: "already_done on the code at head closes it with exactly status/done",
      output: alreadyDone(done),
      expect: { accepted: true, status: "status/done", ready: false, closes: true },
    },
    {
      name: "already_done that also asks for status/ready",
      output: alreadyDone({ ...done, labelsToAdd: ["status/ready"] }),
      expect: { accepted: false, rejectedFor: "status is derived from verdict.actionability" },
    },
    {
      name: "already_done with no close recommendation (the pre-#957 dead enum)",
      output: withoutClose,
      expect: { accepted: false, rejectedFor: 'an already_done verdict requires a close with reason "already_done"' },
    },
  ],
};
