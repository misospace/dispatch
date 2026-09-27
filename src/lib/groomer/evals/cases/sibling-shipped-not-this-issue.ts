import { alreadyDone, readyImplementation } from "../drafts";
import type { GroomingCase } from "../types";

const REPO = "misospace/pr-reviewer-action";
const HEAD = "5e0f3c1a9b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f";
const SIBLING_PR = "github:pr:misospace/pr-reviewer-action#590";
const SIBLING_ISSUE = "github:issue:misospace/pr-reviewer-action#587";

const PLATFORM_PY = `"""Resolve which forge backend this run talks to."""

VALID_PLATFORMS = ("github", "forgejo")


def resolve_platform(env):
    explicit = env.get("PLATFORM", "auto").lower()
    if explicit in VALID_PLATFORMS:
        return explicit
    if explicit != "auto":
        raise ValueError(f"Unknown PLATFORM: {explicit}")
    host = env.get("GITHUB_SERVER_URL", "https://github.com")
    return "github" if host == "https://github.com" else "forgejo"
`;

const TANGLED_SESSION_PY = `"""Tangled pull-request sessions (#587)."""


class TangledSession:
    def __init__(self, context):
        self.repo_did = context.repo_did
        self.pull_rkey = context.pull_rkey
`;

const CHANGELOG_MD = `# Changelog

## 2.4.0

- Tangled: open review sessions for Tangled pull requests (#587)
`;

const CRITERIA = [
  "`resolve_platform()` accepts explicit `tangled`.",
  "`auto` resolves to Tangled when running under a Spindle/Tangled environment.",
  "Existing GitHub auto-resolution behavior remains unchanged.",
  "Existing Forgejo auto-resolution behavior remains unchanged.",
];

const BODY = `Parent: #564

## The ask

Add \`tangled\` as a resolved platform and normalize Tangled/Spindle runtime context without implementing Tangled API calls.

## Expected files

\`pr_reviewer/platform.py\`
\`scripts/platform_api.sh\`
\`tests/test_platform.py\`
\`tests/test_platform_api.sh\`

If a dedicated context module is warranted, add:
\`pr_reviewer/tangled_context.py\`

## Acceptance criteria

${CRITERIA.map((c) => `- [ ] ${c}`).join("\n")}

## Dependencies

None. This is a dependency root for the Tangled support series.`;

const inferred = {
  summary: "Tangled support shipped in 2.4.0 (#587); #583 is its dependency root, so it must already be done.",
  rationale:
    "#583 is the dependency root of the Tangled series; its platform work was necessarily completed before #587 could ship.",
  evidence: ["repo:CHANGELOG.md", "repo:pr_reviewer/tangled_session.py", SIBLING_PR],
};

/** Every criterion, each "grounded" by a verbatim excerpt of the given file. */
function everyCriterion(ref: string, excerpt: string): Array<[string, string, string]> {
  return CRITERIA.map((criterion) => [criterion, ref, excerpt]);
}

export const siblingShippedNotThisIssue: GroomingCase = {
  id: "sibling-shipped-not-this-issue",
  scenario:
    "A sibling issue in the same series shipped, but this issue's own expected files are unchanged: already_done must not close it on the sibling's evidence.",
  regressionOf: "misospace/pr-reviewer-action#583 / dispatch#1099",
  repoFullName: REPO,
  issue: {
    number: 583,
    title: "Tangled support 1/10: add platform identity and runtime context",
    body: BODY,
    labels: ["priority/p2", "type/feature", "status/backlog"],
    lane: "backlog",
  },
  repository: {
    headSha: HEAD,
    read: ["pr_reviewer/platform.py", "pr_reviewer/tangled_session.py", "CHANGELOG.md"],
    contents: {
      "pr_reviewer/platform.py": PLATFORM_PY,
      "pr_reviewer/tangled_session.py": TANGLED_SESSION_PY,
      "CHANGELOG.md": CHANGELOG_MD,
    },
  },
  relatedWork: [
    {
      key: SIBLING_PR,
      kind: "pull_request",
      state: "merged",
      via: "read",
      closes: ["misospace/pr-reviewer-action#587"],
      baseRef: "main",
    },
    { key: SIBLING_ISSUE, kind: "issue", state: "closed", via: "read" },
  ],
  forbidden: ["close"],
  candidates: [
    {
      name: "the incident: already_done inferred from the sibling's changelog entry and module",
      output: alreadyDone({
        ...inferred,
        closeEvidence: ["repo:CHANGELOG.md", "repo:pr_reviewer/tangled_session.py", SIBLING_PR, SIBLING_ISSUE],
      }),
      expect: { accepted: false, rejectedFor: "already_done must ground every acceptance criterion" },
    },
    {
      name: "already_done quoting the sibling's changelog entry for every criterion",
      output: alreadyDone({
        ...inferred,
        closeEvidence: ["repo:CHANGELOG.md"],
        criteria: everyCriterion("repo:CHANGELOG.md", "Tangled: open review sessions for Tangled pull requests (#587)"),
      }),
      expect: { accepted: false, rejectedFor: "is a changelog or release-notes file" },
    },
    {
      name: "already_done quoting the sibling's module, none of this issue's expected files",
      output: alreadyDone({
        ...inferred,
        closeEvidence: ["repo:pr_reviewer/tangled_session.py"],
        criteria: everyCriterion("repo:pr_reviewer/tangled_session.py", "self.repo_did = context.repo_did"),
      }),
      expect: { accepted: false, rejectedFor: "the issue names expected files" },
    },
    {
      name: "already_done citing the sibling's merged PR as the closing proof",
      output: alreadyDone({ ...inferred, closeEvidence: ["repo:pr_reviewer/platform.py", SIBLING_PR] }),
      expect: { accepted: false, rejectedFor: "already_done must ground every acceptance criterion" },
    },
    {
      name: "already_done quoting Tangled support that platform.py does not contain",
      output: alreadyDone({
        ...inferred,
        closeEvidence: ["repo:pr_reviewer/platform.py"],
        criteria: everyCriterion("repo:pr_reviewer/platform.py", 'VALID_PLATFORMS = ("github", "forgejo", "tangled")'),
      }),
      expect: { accepted: false, rejectedFor: "mutations.close.criteria[0].excerpt: not found verbatim in pr_reviewer/platform.py" },
    },
    {
      name: "ready: platform.py still resolves only github and forgejo",
      output: readyImplementation({
        summary: "platform.py resolves only github and forgejo; add tangled.",
        evidence: ["repo:pr_reviewer/platform.py", SIBLING_PR],
        brief: {
          verified: {
            statement: 'VALID_PLATFORMS is ("github", "forgejo") and auto falls back to forgejo for any non-github host.',
            evidence: ["repo:pr_reviewer/platform.py"],
          },
          paths: [["repo:pr_reviewer/platform.py", "modify"]],
          filesToCreate: ["tests/test_platform.py"],
          criteria: [["tests/test_platform.py covers explicit and auto-detected tangled", "automated_test"]],
        },
      }),
      expect: { accepted: true, status: "status/ready", ready: true, admission: "implementation" },
    },
  ],
};
