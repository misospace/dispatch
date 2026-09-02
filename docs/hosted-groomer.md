# Hosted LLM Groomer

Dispatch can run an optional hosted issue groomer that calls an OpenAI-compatible LLM endpoint and updates one GitHub issue per invocation.

The hosted groomer is intentionally narrow:

- It enriches issue labels, lane, grooming metadata, and optionally one GitHub comment.
- It runs at most one issue per request.
- It does not edit code, open PRs, merge PRs, run shell commands, or close issues.
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
| `DISPATCH_GROOMER_REPO_CONTEXT_ENABLED` | `false` | Enables bounded GitHub API repository context. When true, the groomer gathers repository metadata, code-search snippets, and file text through GitHub REST APIs only — it never clones repositories or runs shell commands. |
| `DISPATCH_GROOMER_MAX_CONTEXT_FILES` | `5` | Maximum number of files included in repository context. |
| `DISPATCH_GROOMER_MAX_SEARCHES` | `3` | Maximum GitHub code searches per grooming run. |
| `DISPATCH_GROOMER_MAX_FILE_BYTES` | `4096` | Maximum bytes per fetched file snippet. |
| `DISPATCH_GROOMER_COMMENT_COOLDOWN_HOURS` | `24` | Suppresses repeated hosted-groomer comments on the same issue. A comment is skipped (and recorded on the run) when a prior run posted a comment within this window, unless `force` is true. |
| `DISPATCH_GROOMER_TOOL_LOOP_ENABLED` | `true` | Lets the groomer drive its own repository exploration with tools (`search_code`, `read_file`, `list_directory`, `submit_findings`) instead of one pre-computed context block. |
| `DISPATCH_GROOMER_MAX_TOOL_CALLS` | `12` | Tool calls the exploration loop may make per grooming run. |
| `DISPATCH_GROOMER_CONTEXT_MODE` | `medium` | Exploration budget preset: `small`, `medium`, `large`. See below. |
| `DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS` | unset | The model's real context window in tokens. When set, the exploration budget is derived from it and `DISPATCH_GROOMER_CONTEXT_MODE` is ignored — recommended for self-hosted models whose windows do not match what a named preset assumes. |
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

The default suits a modest self-hosted model. If your model's window is much
larger, prefer setting `DISPATCH_GROOMER_MODEL_CONTEXT_TOKENS` over guessing a
preset: a starved loop stops mid-investigation and reports fewer files, which
shows up as `repository exploration hit its byte budget` in a run's
`contextWarnings`. The resolved budget and which path produced it are recorded
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

Write mode updates GitHub labels, posts one comment only when the model returned `githubComment`, updates Dispatch grooming fields and lane history, and records `AgentRun`/`AuditLog` rows.

## History and Audit

Every hosted grooming run is recorded in a dedicated `GroomingRun` table. Operators can inspect recent runs at `/automation/groomer`, including dry-run plans, write-mode applied mutations, context warnings, the LLM output summary, labels before/after, lane before/after, and the failure stage when a run fails.

`AgentRun` and `AuditLog` rows are still written for compatibility with existing activity and audit views. `GroomingRun` is the detailed drilldown for hosted grooming and is the source of truth for `/automation/groomer`.

Two history API endpoints back the UI and integrations:

- `GET /api/groomer/runs` lists recent runs with filters for repo, issue number, status, dry-run/write mode, and model.
- `GET /api/groomer/runs/[id]` returns one run with its full plan, applied result, context summary, and error details.

## Repository Context

When `DISPATCH_GROOMER_REPO_CONTEXT_ENABLED=true`, the groomer gathers bounded repository context through GitHub REST APIs only — it does not clone repositories, execute shell commands, or run GitHub Actions. The number of searches, number of files, bytes per file, and total prompt context are all capped by configuration.

Repository context is best-effort: fetch warnings are recorded on the `GroomingRun` record and the groomer proceeds with issue-only context when the targeted GitHub issue can still be loaded from Dispatch's cache.

## Scheduling

Dispatch exposes a one-run endpoint (`POST /api/groomer/run`), driven by the in-process scheduler in `src/lib/scheduler.ts` on the `DISPATCH_GROOMER_INTERVAL_MS` interval (default 10 minutes). The endpoint remains callable directly — by an external scheduler, or by hand with `DISPATCH_AGENT_TOKEN` or `DISPATCH_GROOMER_TOKEN` — and processes at most one issue per run either way.
