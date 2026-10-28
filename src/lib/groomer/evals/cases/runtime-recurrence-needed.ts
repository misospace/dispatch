/**
 * dispatch#1452, live failure mode: a rare crash awaiting a runtime recurrence.
 * The batched parser is visible at head, but the claim that it fixed the
 * stack overflow can only be verified with runtime evidence no one has run
 * since. The exploration completed cleanly, so the model's declared kind
 * stands: a runtime_reproduction gap is a human question, and an honest
 * investigation_incomplete is never rewritten into one.
 */
import { parked } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const PARSER_TS = `export async function parseCsv(rows: AsyncIterable<CsvRow>) {
  const batch: CsvRow[] = [];
  for await (const row of rows) {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      await processBatch(batch.splice(0, BATCH_SIZE));
    }
  }
  if (batch.length > 0) await processBatch(batch);
}
`;

export const runtimeRecurrenceNeeded: GroomingCase = {
  id: "runtime-recurrence-needed",
  scenario:
    "A rare crash may already be fixed, but the proof needs a runtime recurrence; on a clean run the model's declared gap class stands as declared.",
  regressionOf: "dispatch#1452 (live: a rare crash awaiting a runtime recurrence)",
  repoFullName: STOREFRONT,
  issue: {
    number: 334,
    title: "Order import crashes on very large CSV files",
    body: "Importing a CSV with more than a million rows crashes the worker with a stack overflow. A batched rewrite was merged last month; the crash has not been seen since.",
    labels: ["priority/p2", "type/bug"],
  },
  repository: {
    headSha: STOREFRONT_HEAD,
    read: ["src/import/parser.ts"],
    contents: { "src/import/parser.ts": PARSER_TS },
  },
  forbidden: ["close", "implementation_admission"],
  candidates: [
    {
      name: "needs_info asking for a runtime recurrence is a human question",
      output: parked("needs_info", {
        summary: "The batched parser is in place, but the crash needs a runtime recurrence to verify the fix.",
        rationale: "The crash reproduces only at runtime on very large inputs; no one has run it since the batched rewrite.",
        evidence: ["repo:src/import/parser.ts"],
        infoGap: {
          kind: "runtime_reproduction",
          question: "Does the import still crash on a multi-million-row CSV with the batched parser in place?",
          whyToolsCannotAnswer:
            "a crash that reproduces only at runtime needs a reproduction; the repository and its history cannot run the importer",
        },
      }),
      expect: { accepted: true, status: "status/backlog", ready: false, gapClass: "human_question" },
    },
    {
      name: "an honest investigation_incomplete on a clean run is never rewritten into a human question",
      output: parked("needs_info", {
        summary: "The fix is visible in the source, but this run gathered no runtime evidence for it.",
        rationale: "No reproduction was run this groom, so the claim that the batched parser fixes the crash is unverified.",
        evidence: ["repo:src/import/parser.ts"],
        infoGap: {
          kind: "investigation_incomplete",
          question: "Was the batched parser verified against the original stack-overflow crash?",
          whyToolsCannotAnswer:
            "this run read the source but gathered no runtime evidence, so the verification is missing rather than answered",
        },
      }),
      expect: { accepted: true, status: "status/backlog", ready: false, gapClass: "investigation_incomplete" },
    },
  ],
};
