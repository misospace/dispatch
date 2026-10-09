import { alreadyDone } from "../drafts";
import type { GroomingCase } from "../types";
import { AUTOMATION, STOREFRONT, STOREFRONT_HEAD } from "./shared";

const SYNC_TS = `export const syncCommand = new Command("sync")
  .description("Sync the catalog with the upstream feed")
  .option("--dry-run", "print the planned changes without writing them")
  .action(async (opts) => {
    const plan = await planSync();
    if (opts.dryRun) {
      printPlan(plan);
      return;
    }
    await applySync(plan);
  });
`;

const SYNC_TEST_TS = `it("prints the plan and writes nothing with --dry-run", async () => {
  await run(["sync", "--dry-run"]);
  expect(applySync).not.toHaveBeenCalled();
});
`;

const BODY = `The sync command always writes. Add a dry-run mode.

## Expected files

- \`src/cli/sync.ts\`
- \`src/cli/sync.test.ts\`

## Acceptance criteria

- [ ] \`sync --dry-run\` prints the planned changes without writing.
- [ ] The flag is documented in the command's help text.
- [ ] A test covers dry-run mode.`;

const GROUNDED: Array<[string, string, string]> = [
  ["sync --dry-run prints the planned changes without writing.", "repo:src/cli/sync.ts", "if (opts.dryRun) { printPlan(plan); return; }"],
  ["The flag is documented in the command's help text.", "repo:src/cli/sync.ts", '.option("--dry-run", "print the planned changes without writing them")'],
  ["A test covers dry-run mode.", "repo:src/cli/sync.test.ts", 'it("prints the plan and writes nothing with --dry-run"'],
];

const done = {
  summary: "sync.ts has a --dry-run option that prints the plan and returns before applySync; a test covers it.",
  evidence: ["repo:src/cli/sync.ts", "repo:src/cli/sync.test.ts"],
};

const regressionReport = "This regressed on main after the merged fix — sync --dry-run still writes.";
const output = alreadyDone({ ...done, closeEvidence: ["repo:src/cli/sync.ts", "repo:src/cli/sync.test.ts"], criteria: GROUNDED });

function regressionCase(
  id: string,
  scenario: string,
  stateReason: string | null,
  comments: GroomingCase["comments"],
  name: string,
  closes: boolean,
): GroomingCase {
  return {
    id,
    scenario,
    regressionOf: "dispatch#1113",
    repoFullName: STOREFRONT,
    issue: {
      number: 310,
      title: "Add a --dry-run flag to the sync CLI",
      body: BODY,
      labels: ["priority/p2", "type/feature", "status/backlog"],
      lane: "backlog",
      stateReason,
    },
    comments,
    repository: {
      headSha: STOREFRONT_HEAD,
      read: ["src/cli/sync.ts", "src/cli/sync.test.ts"],
      contents: {
        "src/cli/sync.ts": SYNC_TS,
        "src/cli/sync.test.ts": SYNC_TEST_TS,
      },
    },
    forbidden: ["ready"],
    candidates: [
      {
        name,
        output,
        expect: {
          accepted: true,
          // The harness exposes the validated plan, whose derived status is
          // status/done; a withheld close is distinguished by `closes: false`
          // and by mutationPlan.withheld.close (checked by the invariants).
          status: "status/done",
          ready: false,
          closes,
        },
      },
    ],
  };
}

export const alreadyDoneReopenRegression: GroomingCase = regressionCase(
  "already-done-reopen-regression",
  "A reopened issue stays in backlog despite unchanged code that still satisfies its acceptance criteria.",
  "reopened",
  undefined,
  "a reopened issue with unchanged code is withheld, not closed",
  false,
);

export const alreadyDoneRegressionReport: GroomingCase = regressionCase(
  "already-done-human-regression-report",
  "An authoritative human report of a live regression withholds an otherwise grounded already-done close.",
  null,
  [{ id: 7001, author: "maintainer", createdAt: "2026-09-25T00:00:00Z", body: regressionReport }],
  "an explicit regression report with code still present is withheld, not closed",
  false,
);

export const alreadyDoneAutomationRegression: GroomingCase = regressionCase(
  "already-done-automation-regression-report",
  "An automation regression claim cannot veto an otherwise grounded already-done close.",
  null,
  [{ id: 7002, author: AUTOMATION, createdAt: "2026-09-25T00:00:00Z", body: regressionReport }],
  "an automation comment claiming a regression is not authority and does not withhold",
  true,
);

export const alreadyDoneOrdinary: GroomingCase = regressionCase(
  "already-done-ordinary-after-1113",
  "Current-state proof still closes an ordinary open issue without reopen history or a regression report.",
  null,
  undefined,
  "ordinary already-done with current-state proof still closes",
  true,
);
