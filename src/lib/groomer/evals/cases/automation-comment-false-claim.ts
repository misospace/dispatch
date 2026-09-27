import { alreadyDone, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";
import { AUTOMATION, STOREFRONT, STOREFRONT_HEAD } from "./shared";

const PR = "github:pr:acme/storefront#285";
const READY = "ready on the filter code read at head, with the automation claim kept as context";

export const automationCommentFalseClaim: GroomingCase = {
  id: "automation-comment-false-claim",
  scenario: "A prior automation comment wrongly claims the bug is fixed; it must never become authoritative evidence.",
  repoFullName: STOREFRONT,
  issue: {
    number: 290,
    title: "Search results ignore the in-stock filter",
    body: "Filtering search by 'In stock only' still shows sold-out products.",
    labels: ["priority/p1", "type/bug", "status/backlog"],
    lane: "backlog",
  },
  comments: [
    {
      id: 9001,
      author: AUTOMATION,
      body: "Grooming note: this was fixed by #285 and can be closed as done.",
      createdAt: "2026-09-10T09:00:00Z",
    },
    { id: 9002, author: "dana-qa", body: "Still reproduces on main with 'desk lamp'.", createdAt: "2026-09-18T16:30:00Z" },
  ],
  repository: { headSha: STOREFRONT_HEAD, read: ["src/search/filters.ts"] },
  relatedWork: [{ key: PR, kind: "pull_request", state: "merged", via: "read" }],
  forbidden: ["close"],
  candidates: [
    {
      name: "already_done on the automation comment alone",
      output: alreadyDone({ summary: "Fixed by #285 per the earlier note.", evidence: ["comment:9001"], closeEvidence: ["comment:9001"] }),
      expect: { accepted: false, rejectedFor: "(not the issue itself or automation comments)" },
    },
    {
      name: "ready on the automation comment alone",
      output: readyImplementation({
        summary: "Re-apply the #285 fix.",
        evidence: ["comment:9001"],
        brief: {
          verified: { statement: "The earlier note says #285 fixed it.", evidence: ["comment:9001"] },
          paths: [["repo:src/search/filters.ts", "modify"]],
        },
      }),
      expect: { accepted: false, rejectedFor: "read at the pinned head SHA" },
    },
    {
      name: "already_done on the automation comment plus the PR it names does not close (no current-revision evidence)",
      output: alreadyDone({
        summary: "#285 merged, as the earlier note says.",
        evidence: ["comment:9001", PR],
        closeEvidence: ["comment:9001", PR],
      }),
      expect: { accepted: false, rejectedFor: "already_done must cite pinned repository evidence" },
    },
    {
      name: READY,
      output: readyImplementation({
        summary: "applyFilters drops inStock when a query is present; #285 only changed sort order.",
        evidence: ["repo:src/search/filters.ts", "comment:9002", "comment:9001"],
        brief: {
          verified: {
            statement: "applyFilters in src/search/filters.ts skips the inStock predicate when q is non-empty.",
            evidence: ["repo:src/search/filters.ts"],
          },
          paths: [["repo:src/search/filters.ts", "modify"]],
        },
      }),
      expect: { accepted: true, status: "status/ready", ready: true, admission: "implementation" },
    },
  ],
  freshness: [
    {
      name: "a new automation comment does not invalidate the result",
      from: READY,
      event: { kind: "comment", author: AUTOMATION },
      stale: [],
    },
    {
      name: "a new human comment does",
      from: READY,
      event: { kind: "comment", author: "dana-qa" },
      stale: ["human_comment"],
    },
  ],
};
