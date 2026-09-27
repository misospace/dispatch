# Hosted LLM Groomer

Dispatch can run an optional hosted issue groomer that calls an OpenAI-compatible LLM endpoint and updates one GitHub issue per invocation.

The hosted groomer is intentionally narrow:

- It enriches issue labels, lane, grooming metadata, and optionally one GitHub comment.
- It runs at most one issue per request.
- It does not edit code, open PRs, merge PRs, or run shell commands. It closes an issue only when its plan's verdict is `already_done` at high confidence with current-revision evidence (see [Grooming plan contract](#grooming-plan-contract)).
- Before writing anything it re-checks that the issue and default branch still match the evidence the plan was built on, and it applies each plan at most once (see [Applying a plan](#applying-a-plan)).
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
| `DISPATCH_GROOMER_COMMENT_COOLDOWN_HOURS` | `24` | Suppresses repeated hosted-groomer comments on the same issue. A comment is skipped (and recorded on the run) when a prior run recorded a comment within this window, or a hosted-groomer comment (found by its hidden marker) was posted on the issue within it, unless `force` is true. |
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

Write mode first re-validates the plan against live GitHub state, then applies only what differs from the live issue: labels, at most one comment when the model returned `githubComment`, a bad-title rewrite or managed body section, and the `already_done` close. It then updates Dispatch grooming fields and lane history, records the result's freshness baseline (see [Grooming Freshness](#grooming-freshness)), and records `AgentRun`/`AuditLog` rows. A plan whose preconditions changed applies nothing (see [Applying a plan](#applying-a-plan)).

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
- for `implementation` work: the brief is present, its verified current behavior cites pinned repository evidence, it names at least one path or file to create, every relevant path it marks `modify` was read at the pinned SHA (a path only surfaced by search may have moved; `reference` paths may stay surfaced, since they orient the worker rather than tell it what to change), `inScope` is not empty, every acceptance criterion is verified by an automated test, a command, or code inspection (not `subjective`), and no decomposition is required;
- for `design` work: the lane is the one with role `escalation`, and only `design_choice` uncertainties remain. Design work never validates into the default lane, and without an escalation lane it cannot be ready;
- the lane is claimable and no close is recommended.

A ready verdict that breaks any rule is a validation error: the run fails as retryable and applies no mutation. The persisted plan records the result as `readiness` (`ready`, `admission` of `implementation` or `escalation`, `lane`, `evidenceDigest`), which an admission gate can check against the current evidence digest. `evaluateReadiness` re-runs the rules against a fresh catalog.

Other rules the validator enforces:

- Status is derived from actionability (`ready` → `status/ready`, `blocked` → `status/blocked`, `already_done` → `status/done`, otherwise `status/backlog`); the plan cannot set `status/*` or `agent/*` labels. After an applied groom the derived status is the only `status/*` label: every other one is removed, including statuses the groomer does not own (such as `status/needs-review`), as the external groom route already does.
- An issue carrying `status/in-progress` or `status/in-review` (claimed, or with an open PR) is never moved, including on targeted runs. Its plan is recorded on the run, with `mutationPlan.skippedReason: "in_flight_status"`, but no label, lane, title/body, comment or close mutation is applied. Only `groomedAt` is stamped, so the 24h re-groom cooldown still applies.
- A non-ready verdict is placed in the non-claimable lane, so a lane alone never promotes an issue. A ready verdict placed there is moved to the default lane (implementation) or escalation lane (design). Both moves are recorded in `contextWarnings`.
- `already_done` requires a close with reason `already_done`, `high` verdict confidence, no material uncertainty, and at least one close citation that is repository content read at the pinned head SHA: direct evidence that the work is done on the code as it is now. A merged PR, a commit or a human comment may corroborate, but none of them can close an issue alone, and the issue itself and automation comments never count. It remains the only close the runner applies.
- `duplicate` and `superseded` closes are recorded recommendations only; each must cite a matching `relatedWork` entry.
- A dependency state that contradicts the cited GitHub state is rejected. Dependencies are descriptive: the `depends on #N` claim gate stays authoritative.
- Output in the legacy `GroomerOutput` shape is rejected with a clear error rather than migrated.

### Compatibility

`GroomingRun.validatedOutput` stores the full plan. `mutationPlan` keeps its existing fields and adds `planSchemaVersion`, `evidenceDigest`, `readiness`, `closeRecommendation`, `applicationKey`, `preconditions` and, when a policy withheld something, `withheld`. The run path applies mutations through `toGroomerOutput`, the legacy view that `POST /api/groomer/run` still returns as `output` (with the plan alongside as `plan`). A rejected plan's raw output and `validationErrors` are kept on the run. Runs recorded before the plan contract still render on `/automation/groomer`, marked `legacy`, with no readiness claim.

## Applying a plan

A validated plan is not written straight to GitHub. The applier (`src/lib/groomer/mutation-validator.ts`, `src/lib/groomer/mutation-applier.ts`) sits between the plan and every write.

### Preconditions

Immediately before the first write, the run re-reads live state with the same capture path as its evidence snapshot and checks:

| Precondition | Fails when |
| --- | --- |
| `issue` | The live title, body, labels (any label, including `agent/*` claims) or state differ from the snapshot, the issue is no longer open, or it cannot be re-read. A snapshot that never captured the issue can never be applied. |
| `comments` | A human comment (non-automation author) was posted after the run's evidence window opened, or the recent comments cannot be read. |
| `head` | The default branch was renamed, its head cannot be resolved, or the head moved in a way that touches what the plan relies on: a commit changing a relied-on path, any commit when the plan relies on repo-wide evidence, or a comparison that cannot be trusted (diverged history, truncated file list, compare failure). A head that moved without touching the plan's evidence passes, with the same rules the freshness pass uses, and the result is recorded as verified at the new head. A snapshot with no pinned head skips this check; such a plan cannot be ready or close anyway. |

If any precondition changed or cannot be verified, the run applies **zero** grooming mutations: no label, comment, title/body, close, lane, grooming field or freshness baseline is written. The `GroomingRun` ends with `status: "stale"`, `stage: "validated"`, `retryable: true`, `applyOutcome: "stale"`, every check in `preconditions`, and one line per failed check in `preconditionFailures` (for example `issue: issue changed since the evidence snapshot: body`). Because nothing on the issue moved, it stays exactly as eligible for a fresh groom as when this run selected it. Stale evidence is never patched through.

Issues that are `status/in-progress` or `status/in-review` in either Dispatch's cache or the live snapshot are still skipped before any of this (no preconditions, no application).

### What is applied, and in which order

The diff is computed against the live issue, never Dispatch's cache, and only what differs is written, so re-applying a plan to an issue that already matches it writes nothing. Steps run from lowest to highest impact, and the first failure stops every later step:

1. **labels**: priority/type changes and the derived status. For an `already_done` plan the status stays as it was here.
2. **comment**: at most one, with `@` mentions neutralized and a hidden `<!-- dispatch-groomer:apply=<key> -->` marker at its end. Any marker the model wrote into its own text is stripped, and a marker only counts on a comment by an automation author, so nobody else can forge one to suppress or impersonate a groomer comment.
3. **title/body**: one write. A title is rewritten only when the current one is bad (the existing guard). The body is never replaced: enrichment goes into one Dispatch-managed section between `<!-- dispatch-groomer:managed:start -->` and `<!-- dispatch-groomer:managed:end -->` markers, appended after the human text on first write and replaced in place afterwards. Text outside the section is kept byte for byte. Enrichment still applies only when the human-authored text is sparse, and a body whose markers are unpaired or repeated is left alone.
4. **close**, only for an `already_done` plan that still satisfies the close policy.
5. **status/done**, only once the close has landed, so a failed close leaves the issue open in its previous (groomable) status rather than open with `status/done`, which the selector would skip forever.

Each step is recorded as `applied`, `replayed`, `noop`, `skipped` (comment cooldown), `failed` or `not_attempted` in `appliedMutations.steps`, alongside the existing `labelsUpdated`, `titleUpdated`, `bodyUpdated`, `commentUrl`, `commentSkippedReason`, `commentError`, `issueClosed` and `issueClosedError` fields. A run where a later step failed after earlier ones landed ends with `status: "partial"`, `retryable: true` and an `errorMessage` naming the failed step; the grooming fields and freshness baseline record only what actually landed. A run whose first needed write failed (nothing landed) fails as before.

The ready and close policies are checked again here against the run's catalog. They cannot normally disagree with plan validation, but if they do, the ready promotion or close is withheld: the plan lands as `status/backlog` in the non-claimable lane with only its priority/type labels, and `withheld` records why.

### Idempotency

Every application has a key: a SHA-256 over the repository, issue number, the plan's evidence digest, the plan schema version and the normalized mutation intent (final label set, lane, comment text, title, body, close). The key is claimed in the `GroomingApplication` table (unique on the key) before the first write, and each step's result is recorded as it lands.

Every run captures its own snapshot, so the key only recurs when the issue, its comments and the head are exactly as they were for the earlier attempt:

- A run whose key was already fully applied is a **replay**: it writes nothing to GitHub and no lane history, stamps only `groomedAt` (so the same plan is not re-billed every tick), and records `applyOutcome: "replayed"` with the claiming run.
- A run whose key was claimed but not finished **resumes** it: steps recorded as landed are replayed, not repeated, and only the rest are attempted. Because a landed label, title/body or close write changes the issue (and so the next snapshot and key), in practice what a resume skips is a comment that landed before the attempt failed or crashed. An unfinished claim updated in the last 10 minutes may belong to an attempt that is still running, so a run that meets one writes nothing (`applyOutcome: "busy"`, retryable, no cooldown stamp); an older one is treated as abandoned and resumed.
- A comment that landed without being recorded is found on GitHub by its marker instead of being posted again, including when the comment write itself reported a failure after GitHub accepted it.
- A retry after earlier writes landed sees them in its own snapshot, so its preconditions pass and it has a new key. The diff from live state makes the already-applied parts no-ops, and the comment cooldown (recorded runs, or groomer markers on the issue) stops a second comment within the window.

Dry runs use the same preconditions, diff and policies without writing: `mutationPlan.applyOutcome` is `dry_run`, `stale` (with `preconditionFailures`), or `would_replay` when the key was already applied. A dry run never claims a key.

Out of scope here, and still to come: worker admission gating on these results (#1065), child issue creation (#1066), semantic duplicate/superseded closes (design gate #1069), and UI exposure of the new history fields (#1067).

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
