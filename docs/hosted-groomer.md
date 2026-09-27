# Hosted LLM Groomer

Dispatch can run an optional hosted issue groomer that calls an OpenAI-compatible LLM endpoint and updates one GitHub issue per invocation.

The hosted groomer is intentionally narrow:

- It enriches issue labels, lane, grooming metadata, and optionally one GitHub comment.
- It runs at most one issue per request.
- It does not edit code, open PRs, merge PRs, or run shell commands. It closes an issue only when its plan's verdict is `already_done` (see [Grooming plan contract](#grooming-plan-contract)).
- Existing external groomer workers using `next-task?mode=groom` remain supported.

## Configuration

The feature is disabled by default.

| Variable | Default | Description |
| --- | --- | --- |
| `DISPATCH_HOSTED_GROOMER_ENABLED` | `false` | Enables `POST /api/groomer/run` when set to `true` or `1`. |
| `DISPATCH_LLM_BASE_URL` | required when enabled | OpenAI-compatible base URL, without `/chat/completions`. |
| `DISPATCH_LLM_API_KEY` | required when enabled | LLM provider API key. |
| `DISPATCH_GROOMER_MODEL` | required when enabled | Model sent to the chat completions API. Must be set explicitly when the hosted groomer is enabled. |
| `DISPATCH_GROOMER_TIMEOUT_MS` | Scaled | LLM request timeout. Defaults to `60s + 5s/KB of maxContextBytes`, clamped to 60s–300s. |
| `DISPATCH_GROOMER_MAX_CONTEXT_BYTES` | `8192` | Budget for issue context sent to the model. |
| `DISPATCH_GROOMER_DRY_RUN` | `true` | Keeps rollout safe by returning a mutation plan without writes. |
| `DISPATCH_LLM_RESPONSE_FORMAT` | `true` | Send `response_format` (`json_schema`, then `json_object`). Set `false` for backends that implement neither. |
| `DISPATCH_GROOMER_REPO_CONTEXT_ENABLED` | `false` | Enables bounded GitHub API repository context. When true, the groomer gathers repository metadata, code-search snippets, and file text through GitHub REST APIs only — it never clones repositories or runs shell commands. |
| `DISPATCH_GROOMER_MAX_CONTEXT_FILES` | `5` | Maximum number of files included in repository context. |
| `DISPATCH_GROOMER_MAX_SEARCHES` | `3` | Maximum GitHub code searches per grooming run. |
| `DISPATCH_GROOMER_MAX_FILE_BYTES` | `4096` | Maximum bytes per fetched file snippet. |
| `DISPATCH_GROOMER_COMMENT_COOLDOWN_HOURS` | `24` | Suppresses repeated hosted-groomer comments on the same issue. A comment is skipped (and recorded on the run) when a prior run posted a comment within this window, unless `force` is true. |
| `DISPATCH_GROOMER_TOOL_LOOP_ENABLED` | `true` | Lets the groomer drive its own repository exploration with tools (`search_code`, `read_file`, `list_directory`, `submit_findings`) instead of one pre-computed context block. |
| `DISPATCH_GROOMER_MAX_ROUNDS` | `12` | Model round-trips the exploration loop may make. One round can carry several tool calls, so this is not a cap on calls. `DISPATCH_GROOMER_MAX_TOOL_CALLS` is accepted as a deprecated alias. |
| `DISPATCH_GROOMER_MAX_SEARCH_RESULTS` | `10` | Maximum code-search results returned to the model per `search_code` call. |
| `DISPATCH_GROOMER_MAX_DIR_ENTRIES` | `60` | Maximum directory entries returned to the model per `list_directory` call. |
| `DISPATCH_GROOMER_CONTEXT_MODE` | `medium` | Exploration budget preset: `small`, `medium`, `large`. See below. |
| `DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS` | unset | The model's real context window in tokens. When set, the exploration budget is derived from it and `DISPATCH_GROOMER_CONTEXT_MODE` is ignored, up to the 96 KB `large` preset cap. |
| `DISPATCH_GROOMER_EXPLORE_MAX_BYTES` | from mode | Overrides the exploration byte budget. |
| `DISPATCH_GROOMER_EXPLORE_MAX_FILE_BYTES` | from mode | Overrides bytes per file returned to the model. Never exceeds the total budget. |
| `DISPATCH_GROOMER_EXPLORE_TIMEOUT_MS` | from mode | Overrides the wall-clock cap on the exploration loop. |
| `DISPATCH_GROOMER_TOKEN` | unset | Optional bearer token for scheduled or admin groomer invocations. When set, `POST /api/groomer/run` accepts this token in addition to `DISPATCH_AGENT_TOKEN`. |
| `DISPATCH_GROOMER_INTERVAL_MS` | 600000 | Interval for the in-process scheduler's `groomer` job. Dispatch still processes at most one issue per run. |

## Exploration budget

Repository exploration is a multi-turn tool loop, so it needs a budget of its
own rather than the single-call one. Three ways to size it, most specific first:

1. the individual `DISPATCH_GROOMER_EXPLORE_*` overrides,
2. `DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS`, which derives the budget from the
   model's real context window and reserves the rest for the system prompt, the
   issue context and the model's own output,
3. `DISPATCH_GROOMER_CONTEXT_MODE`.

| Mode | Total bytes | Per file | Timeout |
| --- | --- | --- | --- |
| `small` | 8 KB | 4 KB | 90s |
| `medium` (default) | 24 KB | 8 KB | 150s |
| `large` | 96 KB | 24 KB | 300s |

With two rounds left the loop tells the model to submit what it has, so a run
that explores well but never volunteers findings is not discarded empty. The
byte budget carries the same nudge when it runs out.

The default suits a modest self-hosted model. If your model's window is much
larger, setting `DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS` avoids undersizing the
loop, but derived budgets stop at the 96 KB `large` preset cap: a tool loop does
not need to consume the model's full context window. A starved loop stops
mid-investigation and reports fewer files, which shows up as
`repository exploration hit its byte budget` in a run's `contextWarnings`. The
resolved budget and which path produced it are recorded
on every run under `contextSummary.exploration.budget`.

## Endpoint

```http
POST /api/groomer/run
Authorization: Bearer <DISPATCH_AGENT_TOKEN>
Content-Type: application/json
```

Optional body:

```json
{
  "dryRun": true,
  "repoFullName": "org/repo",
  "issueNumber": 123,
  "force": false
}
```

`dryRun` overrides the environment default for a single request. `repoFullName` and `issueNumber` target a specific synced issue. `force` lets the hosted groomer proceed when another active issue lease exists.

## Rollout

1. Configure the LLM endpoint and keep `DISPATCH_GROOMER_DRY_RUN=true`.
2. Invoke `POST /api/groomer/run` and inspect the returned `plannedLabels` and model output.
3. Once plans look safe, set `dryRun=false` for a targeted request or change `DISPATCH_GROOMER_DRY_RUN=false`.

Write mode updates GitHub labels, posts one comment only when the model returned `githubComment`, updates Dispatch grooming fields and lane history, records the result's freshness baseline (see [Grooming Freshness](#grooming-freshness)), and records `AgentRun`/`AuditLog` rows.

## Grooming plan contract

The model returns a versioned `GroomingPlan` (`src/lib/groomer/plan.ts`, schema version 1), not free-form label advice. The plan keeps analysis separate from mutation intent:

| Section | Holds |
| --- | --- |
| `verdict` | `actionability` (`ready`, `needs_info`, `blocked`, `backlog`, `already_done`), `workType` (`implementation` or `design`), confidence, lane, summary, rationale, `evidenceRefs`, and `uncertainties` (each with a kind and whether it is material). |
| `implementationBrief` | The bounded worker brief, or `null`: problem, verified current behavior with its evidence, relevant paths (cited as evidence), files to create, invariants, in/out of scope, dependencies, acceptance criteria with how each is verified, and tests. |
| `mutations` | Priority/type labels to add or remove, proposed title/body, one comment, and an optional close recommendation (`already_done`, `duplicate`, `superseded`) with its evidence. |
| `decomposition` | Whether the issue must be split, and bounded child briefs. |
| `relatedWork` | Related issues/PRs/commits cited as `duplicate_of`, `superseded_by`, or `related`. |

The response schema sent as `json_schema` enum-constrains lanes (from the lane config), labels (priority/type allowlist), and every evidence id (from the run's catalog), and bounds every string and array. It names no provider or model.

### Evidence

Each run builds an evidence catalog from its revision-pinned snapshot and appends it to the prompt. The plan may cite only these ids:

- `issue`: the groomed issue as captured;
- `comment:<id>`: a comment, marked human or automation;
- `repo:<path>`: a repository path from this run. It is pinned only when the file was actually read at the snapshot head SHA (repository context fetches and `read_file`). Code-search hits come from the default-branch index and paths the model names in its findings were never read, so both are recorded as `via: "surfaced"` with `ref: null` and never satisfy a pinned-evidence rule;
- `github:<kind>:<ref>`: related GitHub issue/PR/commit state.

An id outside the catalog fails validation. Automation-authored comments may be cited as context but never satisfy an evidence requirement.

### Readiness invariant

Dispatch derives readiness; it does not trust the model's claim. A `ready` verdict validates only when:

- the snapshot was captured and pinned to a default-branch head SHA;
- `verdict.evidenceRefs` cites repository evidence read at that SHA, and confidence is not `low`;
- no material uncertainty remains;
- for `implementation` work: the brief is present, its verified current behavior cites pinned repository evidence, it names at least one path or file to create, `inScope` is not empty, every acceptance criterion is verified by an automated test, a command, or code inspection (not `subjective`), and no decomposition is required;
- for `design` work: the lane is the one with role `escalation`, and only `design_choice` uncertainties remain. Design work never validates into the default lane, and without an escalation lane it cannot be ready;
- the lane is claimable and no close is recommended.

A ready verdict that breaks any rule is a validation error: the run fails as retryable and applies no mutation. The persisted plan records the result as `readiness` (`ready`, `admission` of `implementation` or `escalation`, `lane`, `evidenceDigest`), which an admission gate can check against the current evidence digest. `evaluateReadiness` re-runs the rules against a fresh catalog.

Other rules the validator enforces:

- Status is derived from actionability (`ready` → `status/ready`, `blocked` → `status/blocked`, `already_done` → `status/done`, otherwise `status/backlog`); the plan cannot set `status/*` or `agent/*` labels. The groomer only manages these grooming-owned statuses, and any other one on the issue is removed.
- An issue carrying `status/in-progress` or `status/in-review` (claimed, or with an open PR) is never moved, including on targeted runs. Its plan is recorded on the run, with `mutationPlan.skippedReason: "in_flight_status"`, but no label, lane, title/body, comment or close mutation is applied. Only `groomedAt` is stamped, so the 24h re-groom cooldown still applies.
- A non-ready verdict is placed in the non-claimable lane, so a lane alone never promotes an issue. A ready verdict placed there is moved to the default lane (implementation) or escalation lane (design). Both moves are recorded in `contextWarnings`.
- `already_done` requires a close with reason `already_done`, backed by pinned repository evidence, related GitHub work, or a human comment, and no material uncertainty. It remains the only close the runner applies.
- `duplicate` and `superseded` closes are recorded recommendations only; each must cite a matching `relatedWork` entry.
- A dependency state that contradicts the cited GitHub state is rejected. Dependencies are descriptive: the `depends on #N` claim gate stays authoritative.
- Output in the legacy `GroomerOutput` shape is rejected with a clear error rather than migrated.

### Compatibility

`GroomingRun.validatedOutput` stores the full plan. `mutationPlan` keeps its existing fields and adds `planSchemaVersion`, `evidenceDigest`, `readiness`, and `closeRecommendation`. The run path applies mutations through `toGroomerOutput`, the legacy view that `POST /api/groomer/run` still returns as `output` (with the plan alongside as `plan`). A rejected plan's raw output and `validationErrors` are kept on the run. Runs recorded before the plan contract still render on `/automation/groomer`, marked `legacy`, with no readiness claim.

## History and Audit

Every hosted grooming run is recorded in a dedicated `GroomingRun` table. Operators can inspect recent runs at `/automation/groomer`, including dry-run plans, write-mode applied mutations, context warnings, the LLM output summary, labels before/after, lane before/after, and the failure stage when a run fails.

`AgentRun` and `AuditLog` rows are still written for compatibility with existing activity and audit views. `GroomingRun` is the detailed drilldown for hosted grooming and is the source of truth for `/automation/groomer`.

Two history API endpoints back the UI and integrations:

- `GET /api/groomer/runs` lists recent runs with filters for repo, issue number, status, dry-run/write mode, and model.
- `GET /api/groomer/runs/[id]` returns one run with its full plan, applied result, context summary, and error details.

## Grooming Freshness

A grooming result is only valid for the evidence it was checked against. After every applied (non-dry-run) groom, Dispatch records that evidence on the issue, and later syncs mark the result stale when the evidence changes. The groomer then picks the issue up again, even when it is fully classified `status/ready`, `status/backlog` or a parked `status/blocked`.

What is recorded (the `groomed*` columns on `Issue`):

- the default-branch head SHA and branch the run was pinned to;
- a fingerprint of the issue as the groom left it: title, body, state and labels, excluding `agent/*` claim labels. It is computed from what the groomer itself wrote, so its own label/title/body/close writes never read back as an external change;
- the comment count and the start of the run's evidence window;
- the evidence digest from the evidence snapshot, and the `GroomingRun` that produced the result;
- the repository paths the result relied on, plus an evidence scope: `paths` (a bounded path set), `global` (a code search found nothing, the result cites a path that was only surfaced by search or findings and never read, or the run consulted the repository without reading a path), or `none` (the run used no repository evidence). Only paths fetched at the pinned SHA (`via: "read"`) can bound a result. When the plan cites repository evidence, the cited read paths are what it relied on; when it cites none, every read path counts;
- the `depends on #N` keys in the body (parsed by the same code as dependency gating) and which of them were open;
- the related issues and PRs the plan cites, with the state it saw (or, when it cites none, those the run read directly).

What makes a result stale (`groomingStaleAt`, `groomingStaleReasons`, `groomingStaleDetail`):

| Reason | Trigger |
| --- | --- |
| `issue_changed` | Title, body, state or a non-`agent/*` label differs from what the groom left. |
| `human_comment` | A comment by a non-automation author after the run started. Automation authors (the same list the groomer uses to tag comments) never stale a result, including the groomer's own comment. |
| `dependency_changed` | A declared blocker closed or reopened. |
| `related_work_changed` | A related issue or PR the run read changed state (e.g. a PR merged). |
| `evidence_path_changed` | A default-branch commit touched a path the result relied on (exact file, or a file under an evidenced directory). |
| `global_evidence_commit` | Any new default-branch commit, when the result relied on `global` evidence. |
| `compare_unreliable` | The commit comparison cannot be trusted: the base SHA is gone, the histories diverged, or GitHub truncated the changed-file list. |

A commit that only touches unrelated paths does not stale a `paths` result; the issue's `groomingVerifiedSha` advances to the new head instead, so each later check compares a small range. A transient compare failure leaves the result fresh but unverified (`groomingVerifiedSha` behind the head) and is retried on the next sync. A run whose head SHA could not be pinned stays unverified rather than stale, so a repository whose head cannot be resolved does not re-groom in a loop.

How it runs:

- The scheduled and manual issue syncs run a freshness pass after syncing. It never calls the model. Database checks (issue fingerprint, dependencies, tracked related issues) cost nothing extra; GitHub reads are capped per pass: one head lookup per repository branch, at most 10 commit comparisons (shared by every issue verified at the same SHA), 10 comment reads (only when the comment count grew) and 10 related-work reads. Anything the budget does not reach is checked on a later pass. Issues a worker owns (`status/in-progress`, `status/in-review`) are not evaluated.
- `POST /api/issues/webhook` also accepts `issue_comment` `created` events and stales a result immediately for a new human comment. Without webhooks, the sync pass catches it.
- Writes are guarded on the recorded `GroomingRun` id and on the result still being fresh, so repeated passes are idempotent and a pass racing a new groom cannot stale the newer result. Each invalidation writes a `grooming_stale` `AuditLog` row.
- The selector offers stale issues ahead of routine backlog re-grooming but behind anything missing classification. A stale issue skips the 24h cooldown and the blocked/not-ready parking (the evidence that parked it changed), but is not re-groomed within 30 minutes of its last groom. The re-groom's `GroomingRun` records `candidateSource: "stale"` and the `staleReasons` that triggered it.
- Targeted runs (`issueNumber`) still force a re-evaluation regardless of freshness.
- A run skipped because the issue is `status/in-progress` or `status/in-review` records no baseline and leaves any earlier one as it was.

Freshness unknown: issues groomed before this existed, or through `POST /api/issues/groom` (which carries no evidence and resets any recorded baseline), have no fingerprint. The hosted groomer backfills them at the lowest priority, only when nothing else wants grooming and outside the usual 24h cooldown; deliberately blocked issues are not backfilled. External groomers polling `next-task?mode=groom` are not offered backfill work. Worker admission (#1065) decides how unknown and unverified results are treated.

## Repository Context

When `DISPATCH_GROOMER_REPO_CONTEXT_ENABLED=true`, the groomer gathers bounded repository context through GitHub REST APIs only — it does not clone repositories, execute shell commands, or run GitHub Actions. The number of searches, number of files, bytes per file, and total prompt context are all capped by configuration.

Repository context is best-effort: fetch warnings are recorded on the `GroomingRun` record and the groomer proceeds with issue-only context when the targeted GitHub issue can still be loaded from Dispatch's cache.

## Scheduling

Dispatch exposes a one-run endpoint (`POST /api/groomer/run`), driven by the in-process scheduler in `src/lib/scheduler.ts` on the `DISPATCH_GROOMER_INTERVAL_MS` interval (default 10 minutes). The endpoint remains callable directly — by an external scheduler, or by hand with `DISPATCH_AGENT_TOKEN` or `DISPATCH_GROOMER_TOKEN` — and processes at most one issue per run either way.
