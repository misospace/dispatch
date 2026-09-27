import { alreadyDone } from "../drafts";
import type { GroomingCase } from "../types";
import { STOREFRONT, STOREFRONT_HEAD } from "./shared";

const CLOSING_PR = "github:pr:acme/storefront#315";
const SIBLING_PR = "github:pr:acme/storefront#316";
const RELEASE_BRANCH_PR = "github:pr:acme/storefront#317";

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

const CLI_DOCS = "`sync --dry-run` prints the planned changes and writes nothing.\n";
const CHANGELOG = "## 1.8.0\n\n- sync: add --dry-run (#310)\n";

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

export const alreadyDoneGrounded: GroomingCase = {
  id: "already-done-grounded",
  scenario:
    "already_done closes only on this issue's own acceptance: every criterion quoted from its files at head, or a merged PR that closes this issue.",
  regressionOf: "dispatch#1099",
  repoFullName: STOREFRONT,
  issue: {
    number: 310,
    title: "Add a --dry-run flag to the sync CLI",
    body: BODY,
    labels: ["priority/p2", "type/feature", "status/backlog"],
    lane: "backlog",
  },
  repository: {
    headSha: STOREFRONT_HEAD,
    read: ["src/cli/sync.ts", "src/cli/sync.test.ts", "docs/cli.md", "CHANGELOG.md"],
    contents: {
      "src/cli/sync.ts": SYNC_TS,
      "src/cli/sync.test.ts": SYNC_TEST_TS,
      "docs/cli.md": CLI_DOCS,
      "CHANGELOG.md": CHANGELOG,
    },
  },
  relatedWork: [
    { key: CLOSING_PR, kind: "pull_request", state: "merged", via: "read", closes: ["acme/storefront#310"], baseRef: "main" },
    { key: SIBLING_PR, kind: "pull_request", state: "merged", via: "read", closes: ["acme/storefront#311"], baseRef: "main" },
    { key: RELEASE_BRANCH_PR, kind: "pull_request", state: "merged", via: "read", closes: ["acme/storefront#310"], baseRef: "release/1.x" },
  ],
  forbidden: ["ready"],
  candidates: [
    {
      name: "every criterion quoted from the expected files at head closes it",
      output: alreadyDone({ ...done, closeEvidence: ["repo:src/cli/sync.ts", "repo:src/cli/sync.test.ts"], criteria: GROUNDED }),
      expect: { accepted: true, status: "status/done", ready: false, closes: true },
    },
    {
      name: "a merged PR whose closing reference is this issue closes it",
      output: alreadyDone({ ...done, closeEvidence: ["repo:src/cli/sync.ts", CLOSING_PR] }),
      expect: { accepted: true, status: "status/done", ready: false, closes: true },
    },
    {
      name: "a merged PR closing a sibling issue does not",
      output: alreadyDone({ ...done, closeEvidence: ["repo:src/cli/sync.ts", SIBLING_PR] }),
      expect: { accepted: false, rejectedFor: `${SIBLING_PR} closes acme/storefront#311, not acme/storefront#310` },
    },
    {
      name: "a PR closing this issue but merged into a release branch does not",
      output: alreadyDone({ ...done, closeEvidence: ["repo:src/cli/sync.ts", RELEASE_BRANCH_PR] }),
      expect: { accepted: false, rejectedFor: "was merged into release/1.x, not the default branch" },
    },
    {
      name: "an excerpt that is not in the file rejects the close",
      output: alreadyDone({
        ...done,
        closeEvidence: ["repo:src/cli/sync.ts"],
        criteria: [GROUNDED[0], GROUNDED[1], ["A test covers dry-run mode.", "repo:src/cli/sync.test.ts", "dry-run never calls applySync"]],
      }),
      expect: { accepted: false, rejectedFor: "mutations.close.criteria[2].excerpt: not found verbatim in src/cli/sync.test.ts" },
    },
    {
      name: "an excerpt that is not in the file rejects the close even beside a closing PR",
      output: alreadyDone({
        ...done,
        closeEvidence: ["repo:src/cli/sync.ts", CLOSING_PR],
        criteria: [["A test covers dry-run mode.", "repo:src/cli/sync.test.ts", "dry-run never calls applySync"]],
      }),
      expect: { accepted: false, rejectedFor: "not found verbatim in src/cli/sync.test.ts" },
    },
    {
      name: "a criterion left ungrounded rejects the close",
      output: alreadyDone({ ...done, closeEvidence: ["repo:src/cli/sync.ts"], criteria: GROUNDED.slice(0, 2) }),
      expect: { accepted: false, rejectedFor: 'not grounded: "A test covers dry-run mode."' },
    },
    {
      name: "grounded only in docs, none of the expected files, does not close",
      output: alreadyDone({
        ...done,
        closeEvidence: ["repo:docs/cli.md"],
        criteria: GROUNDED.map(([criterion]) => [criterion, "repo:docs/cli.md", "prints the planned changes and writes nothing"]),
      }),
      expect: { accepted: false, rejectedFor: "the issue names expected files (src/cli/sync.ts, src/cli/sync.test.ts)" },
    },
    {
      name: "a changelog entry does not ground a criterion",
      output: alreadyDone({
        ...done,
        closeEvidence: ["repo:src/cli/sync.ts"],
        criteria: [GROUNDED[0], GROUNDED[1], ["A test covers dry-run mode.", "repo:CHANGELOG.md", "sync: add --dry-run (#310)"]],
      }),
      expect: { accepted: false, rejectedFor: "CHANGELOG.md is a changelog or release-notes file" },
    },
  ],
};
