# Hosted LLM Groomer

Dispatch can run an optional hosted issue groomer that calls an OpenAI-compatible LLM endpoint and updates one GitHub issue per invocation.

The hosted groomer is intentionally narrow:

- It enriches issue labels, lane, grooming metadata, and optionally one GitHub comment.
- It runs at most one issue per request.
- It does not edit code, open PRs, merge PRs, or run shell commands. It closes an issue only when its plan's verdict is `already_done` at high confidence with current-revision evidence that proves that issue's own acceptance (see [Close policy](#close-policy)).
- Before writing anything it re-checks that the issue and default branch still match the evidence the plan was built on, and it applies each plan at most once (see [Applying a plan](#applying-a-plan)).
- External `next-task?mode=groom` task dispatch is retired (#1200). Hosted grooming remains available through `POST /api/groomer/run`.

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
| `DISPATCH_GROOMER_COMMENT_COOLDOWN_HOURS` | `24` | Suppresses repeated hosted-groomer comments on the same issue. A comment is skipped (and recorded on the run) when a run that recorded a comment was last updated within this window, or a hosted-groomer comment (found by its hidden marker) was posted on the issue within it, unless `force` is true. |
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
| `DISPATCH_GROOMER_TRUSTED_LOGINS` | empty | Comma- or newline-separated GitHub logins treated as trusted participants for the external-participant reply gate. |
| `DISPATCH_GROOMER_EXTERNAL_REPLIES` | `pending` | `pending` queues externally-engaged comments for operator approval; `off` suppresses them without queueing. |
| `DISPATCH_GROOMER_INTERVAL_MS` | 600000 | Interval for the in-process scheduler's `groomer` job. Dispatch still processes at most one issue per run. |

## External-participant reply gate

The hosted groomer's public-comment side effect is gated independently from its ordinary grooming writes. Issue labels, status, and other validated grooming changes can still apply, but an externally-engaged issue never receives an autonomous public groomer comment; the proposed reply is held for an operator to review and approve.

Trust is resolved per issue author and commenter. Dispatch's internal automation authors are trusted, as are logins explicitly listed in `DISPATCH_GROOMER_TRUSTED_LOGINS`. `author_association` values `OWNER`, `MEMBER`, and `COLLABORATOR` are only trusted after a live repository collaborator-permission lookup confirms `admin`, `maintain`, or `write`. Every other association and permission is untrusted. Missing logins, unknown associations, lookup errors, and any other failure fail closed as untrusted. The issue is externally engaged when any participant is untrusted.

`DISPATCH_GROOMER_EXTERNAL_REPLIES` controls the held-comment behavior: `pending` (the default) creates a pending approval item, while `off` suppresses the comment without queueing it. `DISPATCH_GROOMER_TRUSTED_LOGINS` accepts comma- or newline-separated GitHub logins; configure it only for accounts that operators intend to trust.

Operators can review pending replies in the Hosted Groomer page or use `GET /api/groomer/pending-replies`, then call `POST /api/groomer/pending-replies/{id}/approve` or `POST /api/groomer/pending-replies/{id}/dismiss`. Approval posts the saved reply with its idempotency marker; dismissal records the operator decision without posting. Both mutation endpoints require operator authentication: an OIDC session, basic auth, or auth-disabled mode. Any bearer token is rejected, including `DISPATCH_GROOMER_TOKEN` (401) and maintainer-tier `DISPATCH_AGENT_TOKEN` (403); bearer tokens cannot approve or dismiss a held reply. Audit actions include `groomer_reply_held`, `groomer_reply_suppressed`, `groomer_reply_approved`, and `groomer_reply_dismissed`.

**External grooming retired (#1200):** `GET /api/agents/<name>/next-task?mode=groom` returns HTTP `410 Gone` and never hands out a task. The Hosted Groomer page calls `POST /api/groomer/run` directly. Disable legacy external pollers and revoke their unnecessary GitHub write credentials; removing task discovery cannot revoke independently held credentials.

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
- `already_done` is the only close the runner applies; see [Close policy](#close-policy).
- `duplicate` and `superseded` closes are recorded recommendations only; each must cite a matching `relatedWork` entry.
- A dependency state that contradicts the cited GitHub state is rejected. Dependencies are descriptive: the `depends on #N` claim gate stays authoritative.
- Output in the legacy `GroomerOutput` shape is rejected with a clear error rather than migrated.

### Close policy

The approved scope is limited to the existing deterministic `already_done` policy below. Duplicate and superseded outcomes remain recommendations for human review; see [Groomer Close Policy](./groomer-close-policy.md).

An `already_done` plan closes the issue, the highest-impact write the groomer makes. It validates only when all of these hold:

- the close has reason `already_done`, verdict confidence is `high`, and no material uncertainty remains;
- at least one close citation (`mutations.close.evidenceRefs`) is repository content read at the pinned head SHA. The issue itself, automation comments, a merged PR, a commit or a human comment may corroborate but never meet this alone;
- the evidence proves **this** issue's acceptance, not a sibling's, parent's or dependent's (dispatch#1099): `mutations.close.criteria` maps every acceptance criterion to `{ criterion, evidenceRef, excerpt }`, a `repo:` file read at the pinned head and an excerpt of it.
  - Dispatch checks each excerpt against the file's content as fetched this run: both sides have every run of whitespace collapsed to one space and are trimmed, then the excerpt must be an exact, case-sensitive substring. Re-wrapped lines pass; a paraphrase does not.
  - An excerpt must be at least 24 characters after that normalisation (300 at most), and must contain at least one word that is not a common keyword or literal (`import`, `return`, `nil`, `if`, `err`, `true` and the like). An excerpt of only keywords, punctuation, brackets and numbers could match nearly any file, so it grounds nothing. Whether the excerpt is relevant to its criterion is still the model's judgement; this only makes trivial matches impossible.
  - When the issue lists acceptance criteria (list items under an `Acceptance criteria` heading or label), every one of them must appear in `criteria`, compared ignoring case, backticks/emphasis, spacing and a trailing stop; with no enumerable criteria, at least one grounded criterion is required. When the issue names expected files, at least one grounded criterion must cite one of them.
- evidence about other issues, and related work in general, corroborates but never satisfies the close:
  - a merged pull request into the default branch whose GitHub closing reference is this exact issue is recorded as corroboration only. Such a PR closes the issue when it merges, so an issue still open afterwards was usually reopened, which is evidence it is not done;
  - a changelog or release-notes file (`CHANGELOG`, `CHANGES`, `HISTORY`, `NEWS`, `RELEASE_NOTES`, `RELEASES`, any extension) cannot ground a criterion unless the issue lists it as an expected file;
  - an excerpt that mentions another issue or PR (`#N`, `owner/repo#N`, or a GitHub issue/PR URL) cannot ground a criterion.

Expected files come from the issue body as captured: an `Expected files` (or `Affected files`, `Target files`) section, as a heading or a label line such as `Expected files:` / `**Expected files:**`, contributes its backticked paths or each list item's leading path. Without such a section, the explicit backticked repository paths anywhere in the body are the expected files. A token counts only when it looks like a file: a path with a directory and an extension (or a well-known name such as `Dockerfile`), a bare file name with a known source/config extension, or a dotfile. Identifiers, config keys, `owner/repo` refs, URLs and directories are ignored.

Closing references come from `read_related_pr` (and `read_related_issue` when the number is a PR): for a merged PR it makes one bounded, read-only GraphQL query for `closingIssuesReferences` (at most 10), which covers closing keywords and manual Development links. The references and the PR's base branch are recorded on the related-work evidence and shown in the catalog, so a closing PR is visible as corroboration. If the lookup fails, the references stay unknown. Search hits never carry them.

The content excerpts are checked against is what the run's repository-context fetches and `read_file` calls returned at the pinned head (what the model was shown, after truncation), held in memory for the run only, capped at 1 MB, and never persisted. The catalog rendered into the prompt lists the issue's expected files and acceptance criteria so the model knows what it must ground.

A close that fails any rule is a validation error and applies nothing. The applier re-checks the whole policy, grounding included, against the run's catalog before closing (see [What is applied, and in which order](#what-is-applied-and-in-which-order)); a close that fails there is withheld and the plan lands as backlog.

### Decomposition

A plan may also split the issue into bounded children instead of (or alongside) promoting it. This is an independent decision from the close and ready promotions: a plan that decomposes is withheld only when its own decomposition policy fails, never because the close or ready policy did. The policy requires, all at once:

- no close in the same plan — a decomposed parent is not closed;
- verdict confidence of at least `medium` (a low-confidence split is too speculative to fan out);
- no material uncertainty remaining (the same `verdict.uncertainties[].material` flag the close policy keys on);
- every child brief is a **complete bounded implementation brief**: its `problem`, `designDecision`, and `verifiedCurrentBehavior` are all non-blank, and its `relevantPaths`, `inScope`, `outOfScope`, `acceptanceCriteria`, and `tests` each name at least one entry (`dependencies` may be empty). A child brief that leaves any of those short — a design choice left open, no verified current behavior, no relevant paths, no out-of-scope, no acceptance criteria, no tests — is not bounded, so the whole split is withheld with the gap named in `withheld.decomposition` (`child brief[i] is not a complete bounded implementation brief (missing: …)`). This is an apply-time gate: the validator does not police child-brief completeness (a child brief is not an `ImplementationBrief`), so the gate lives in the decomposition policy the applier evaluates.

When it holds, each bounded child brief in `decomposition.childBriefs` becomes its own GitHub issue, created with the child labels (`status/backlog`). Child creation is idempotent: every child is keyed by a stable `childBriefKey` (repository, parent issue number, and the child brief) recorded in the `GroomingChildClaim` table, so a retried attempt reuses a child an earlier attempt already created and opens only the ones still missing. Once every child exists or is reused, the children step records the parent's decomposition state — `decomposed`, `decomposedAt`, `decomposedBy: "hosted-groomer"`, the decomposition reason as the note, and the created child URLs as its `followUpUrls` — through the same `setDecompositionState` helper the operator `POST /api/issues/actions/decompose` route uses, so both paths write the state and its audit entry identically, and **only then** adds the umbrella label, as the step's final write (an additive `addLabel`, not part of the labels write). The ordering matters: the umbrella label removes the issue from groomer selection on every path (the selector excludes `umbrella`-labeled issues on every path, including a targeted re-groom), so it must be the step's last write; any earlier failure (a child create, the state write) keeps the parent re-selectable, so a partially applied decomposition converges on retry. Two convergence behaviors of the child-claim hold are accepted: a fresh null claim under a different application key is held as another in-flight attempt's claim, so if an LLM re-plan produces a new key shortly after a failed attempt, that child's convergence waits out the active-claim window (about 10 minutes) rather than failing forever; and if the final umbrella label add fails after the decomposition state was recorded, a later retry replays the created children but re-records the decomposition state, which appends another `issue_decomposed` audit entry — accepted as audit noise on an already-rare failure path.

Alongside creating the children, the step writes a **managed decomposition section** into the parent's body between the `dispatch-groomer:decomposition:start` and `dispatch-groomer:decomposition:end` markers — a short heading, one line that says what the section is, and one `- #<n>: <url>` line per created-or-reused child, in brief order. The section renders into the body as it stands after the content step, so it **coexists** with the managed enrichment section that step writes — each is parsed and rendered independently. The write only happens when the section content actually changed (no digests, no timestamps), so re-rendering the same children is a byte-for-byte no-op and a well-groomed parent is never churned; the step records the outcome in its detail (`written`, `unchanged`, or `refused`). A body whose markers a human edit broke (unpaired, repeated, or out of order) is **refused rather than guessed at**, and so is a rendered body that would exceed GitHub's body cap (a write that large would fail on every retry and the umbrella would never land) — in either case the step records the refusal reason in its detail, but the children, the state write, and the umbrella still land, so the decomposition converges on retry.

Three consequences of the managed section are accepted. Re-planning is **last-write-wins**: a fresh plan with different child briefs replaces the section and the recorded `followUpUrls` with the new child set, and children a previous plan already created stay open as `status/backlog` issues, still traceable to the parent by the `Parent:` backlink in their body rather than by any link on the parent. A single well-formed marker pair in the body is treated as **Dispatch-owned** and replaced in place — only a broken or duplicated pair (unpaired, repeated, or out of order) is refused. And because the section's fixed prose makes the parent body permanently non-sparse, a decomposed parent is **never enriched afterwards**: the content step's sparsity gate sees the section's text and skips the write.

A decomposition that fails any rule is withheld: no child is created and the parent is not decorated, and `withheld.decomposition` records why.

### Compatibility

`GroomingRun.validatedOutput` stores the full plan. `mutationPlan` keeps its existing fields and adds `planSchemaVersion`, `evidenceDigest`, `readiness`, `closeRecommendation`, `applicationKey`, `preconditions` and `willCreateChildren` (true when the plan's decomposition children will be created; forced false for in-flight plans, including their dry-run previews, which apply nothing) and, when a policy withheld something, `withheld`. The run path applies mutations through `toGroomerOutput`, the legacy view that `POST /api/groomer/run` still returns as `output` (with the plan alongside as `plan`). A rejected plan's raw output and `validationErrors` are kept on the run. Runs recorded before the plan contract still render on `/automation/groomer`, marked `legacy`, with no readiness claim.

## Applying a plan

A validated plan is not written straight to GitHub. The applier (`src/lib/groomer/mutation-validator.ts`, `src/lib/groomer/mutation-applier.ts`) sits between the plan and every write.

### Preconditions

Immediately before the first write, the run re-reads live state with the same capture path as its evidence snapshot and checks:

| Precondition | Fails when |
| --- | --- |
| `issue` | The live title, body, labels (any label, including `agent/*` claims) or state differ from the snapshot, the issue is no longer open, or it cannot be re-read. A snapshot that never captured the issue can never be applied. |
| `comments` | A human comment (non-automation author) was posted after the run's evidence window opened, or the recent comments cannot be read. |
| `head` | The default branch was renamed, its head cannot be resolved, or the head moved in a way that touches what the plan relies on: a commit changing a relied-on path, any commit when the plan relies on repo-wide evidence, or a comparison that cannot be trusted (diverged history, truncated file list, compare failure). A head that moved without touching the plan's evidence passes, with the same rules the freshness pass uses, and the result is recorded as verified at the new head. A snapshot with no pinned head skips this check; such a plan cannot be ready or close anyway. |

If any precondition changed or cannot be verified, the run applies **zero** grooming mutations: no label, comment, title/body, close, lane, grooming field or freshness baseline is written. Every check is kept in `preconditions`, with one line per failed check in `preconditionFailures` (a run stopped before planning, below, records only its one failure) (for example `issue: issue changed since the evidence snapshot: body`). Stale evidence is never patched through. What happens next depends on why:

- **Stale** (live state `changed`): the `GroomingRun` ends with `status: "stale"`, `stage: "validated"`, `retryable: true`, `applyOutcome: "stale"`. Nothing on the issue moves, so it stays exactly as eligible as when this run selected it and is re-groomed promptly on the fresh evidence.
- **Unverifiable** (a live read failed or could not be completed; this wins when both occur): the same zero-mutation record, but with `status: "unverifiable"`, plus `Issue.groomingRetryAfter` set one hour ahead. The selector skips the issue until then on every path, including the stale one, so a persistently unreadable issue (deleted upstream, or GitHub failing for it) cannot win selection every tick. Targeted runs ignore the backoff. One hour rather than the 24h cooldown, because most read failures are transient. An applied groom clears the backoff.

When the evidence snapshot fails to capture the live issue in the first place, the run stops right there, before any repository read or model call: a plan built on it could never be ready, close, or pass these preconditions. It records `status: "unverifiable"` and backs off the same way (a dry run records the outcome and writes nothing).

Issues that are `status/in-progress` or `status/in-review` in either Dispatch's cache or the live snapshot are still skipped before any of this (no preconditions, no application).

### What is applied, and in which order

The diff is computed against the live issue, never Dispatch's cache, and only what differs is written, so re-applying a plan to an issue that already matches it writes nothing. Steps run from lowest to highest impact, and the first failure stops every later step:

1. **labels**: priority/type changes and the derived status. For an `already_done` plan the status stays as it was here.
2. **comment**: at most one, with `@` mentions neutralized and a hidden `<!-- dispatch-groomer:apply=<key> -->` marker at its end. Any marker the model wrote into its own text is stripped, and a marker only counts on a comment by an automation author, so nobody else can forge one to suppress or impersonate a groomer comment.
3. **title/body**: one write. A title is rewritten only when the current one is bad (the existing guard). The body is never replaced: enrichment goes into one Dispatch-managed section between `<!-- dispatch-groomer:managed:start -->` and `<!-- dispatch-groomer:managed:end -->` markers, appended after the human text on first write and replaced in place afterwards. Text outside the section is kept byte for byte. Enrichment still applies only when the human-authored text is sparse, and a body whose markers are unpaired or repeated is left alone.
4. **children**, only for a plan that decomposes and still satisfies the decomposition policy (no close in the same plan, at least medium confidence, no material uncertainty, and every child brief a complete bounded implementation brief). Each bounded child brief becomes its own issue (created with the child labels), an already-created child is reused rather than re-opened, and once every child exists or is reused the parent is recorded as decomposed with the child URLs as its follow-ups; the step then writes a managed decomposition section into the parent body (one `- #<n>: <url>` line per child) and, only then, adds the `umbrella` label — the step's final write (see [Decomposition](#decomposition)).
5. **close**, only for an `already_done` plan that still satisfies the close policy.
6. **status/done**, only once the close has landed, so a failed close leaves the issue open in its previous (groomable) status rather than open with `status/done`, which the selector would skip forever.

Each step is recorded as `applied`, `replayed`, `noop`, `skipped` (comment cooldown), `failed` or `not_attempted` in `appliedMutations.steps`, alongside the existing `labelsUpdated`, `titleUpdated`, `bodyUpdated`, `commentUrl`, `commentSkippedReason`, `commentError`, `issueClosed` and `issueClosedError` fields. A run where a later step failed after earlier ones landed ends with `status: "partial"`, `retryable: true` and an `errorMessage` naming the failed step; the grooming fields and freshness baseline record only what actually landed. A run whose first needed write failed (nothing landed) fails as before.

The ready and close policies are checked again here against the run's catalog. They cannot normally disagree with plan validation, but if they do, the ready promotion or close is withheld: the plan lands as `status/backlog` in the non-claimable lane with only its priority/type labels, and `withheld` records why.

### Idempotency

Every application has a key: a SHA-256 over the repository, issue number, the plan's evidence digest, the plan schema version and the normalized mutation intent (final label set, lane, comment text, title, body, close). The key is claimed in the `GroomingApplication` table (unique on the key) before the first write, and each step's result is recorded as it lands.

Every run captures its own snapshot, so the key only recurs when the issue, its comments and the head are exactly as they were for the earlier attempt:

- A run whose key was already fully applied is a **replay**: it writes nothing to GitHub and no lane history, stamps only `groomedAt` (so the same plan is not re-billed every tick), and records `applyOutcome: "replayed"` with the claiming run.
- A run whose key was claimed but not finished **resumes** it: steps recorded as landed are replayed, not repeated, and only the rest are attempted. Because a landed label, title/body or close write changes the issue (and so the next snapshot and key), in practice what a resume skips is a comment that landed before the attempt failed or crashed. An unfinished claim updated in the last 10 minutes may belong to an attempt that is still running, so a run that meets one writes nothing (`applyOutcome: "busy"`, retryable, no cooldown stamp); an older one is treated as abandoned and taken over with a compare-and-swap, so of two runs resuming the same abandoned claim only one proceeds.
- A comment that landed without being recorded is found on GitHub by its marker instead of being posted again, including when the comment write itself reported a failure after GitHub accepted it.
- A retry after earlier writes landed sees them in its own snapshot, so its preconditions pass and it has a new key. The diff from live state makes the already-applied parts no-ops, and the comment cooldown (recorded runs, or groomer markers on the issue) stops a second comment within the window.

Dry runs use the same preconditions, diff and policies without writing: `mutationPlan.applyOutcome` is `dry_run`, `stale` or `unverifiable` (with `preconditionFailures`), or `would_replay` when the key was already applied. A dry run never claims a key, so it never reports `busy`, and it never writes a backoff.

Out of scope here, and still to come: worker admission gating on these results (#1065), and UI exposure of the new history fields (#1067).

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

Freshness unknown: issues groomed before this existed, or through `POST /api/issues/groom` (which carries no evidence and resets any recorded baseline), have no fingerprint. The hosted groomer backfills them at the lowest priority, only when nothing else wants grooming and outside the usual 24h cooldown; deliberately blocked issues are not backfilled. External groomers polling `next-task?mode=groom` are not offered backfill work. [Worker admission](#worker-admission) decides how unknown and unverified results are treated.

## Worker Admission

Worker admission (#1065) decides whether a `status/ready` issue may be handed to an autonomous implementation worker, from persisted state only: no model call, no GitHub call, and nothing is written by `next-task` or `/queue`. It is opt-in via `DISPATCH_QUEUE_ADMISSION_MODE`:

| Mode | Behaviour |
| --- | --- |
| `off` (default) | Queue behaviour is exactly what it was: same query, same items, no `admission` field. Unset or unrecognised values mean `off` (an unrecognised value is logged once), so a typo can never starve the fleet. |
| `audit` | Nothing is filtered. Every issue item in `/queue` and `get_queue` carries an `admission` decision, board cards show "Would be withheld from workers (audit): ...", and `next-task` logs a `[queue-admission] audit:` warning when it hands out an item enforce mode would withhold. |
| `enforce` | Withheld issues are removed from implementation pickup. `next-task` never returns an `implement` task for them and goes idle with `No work available (N ready issues withheld by grooming admission)` when nothing else is left. `GET /api/agents/{name}/queue?includeWithheld=true` (MCP `get_queue` `includeWithheld`) appends them with `claimable: false` for diagnostics; board cards show "Withheld from workers: ...". |

Roll out with `audit` first, check which ready issues would be withheld and why, then switch to `enforce`.

### Admission rule

Only `status/ready` issues are gated. A worker's `status/in-progress` work is never withheld (the freshness pass does not track worker-owned statuses, so gating them would only strand claimed work). A ready issue is admitted only when all of these hold:

1. No open `depends on #N` blocker (#1038). The dependency gate still runs first and stays authoritative; admission never re-admits a blocked issue.
2. The issue has a freshness baseline (not unknown) that is not marked stale.
3. The cached issue still matches the baseline's fingerprint, so an edit the freshness pass has not recorded yet still withholds it. The groomer does not write its own title/body changes into Dispatch's cache, so right after a groom that rewrote them the issue reads as `grooming_issue_changed` until the next sync.
4. A baseline whose evidence scope depends on the repository (`paths`, `global`) was pinned to a verified SHA (`groomingVerifiedSha`). Ongoing head verification is the freshness pass's job: it marks the result stale on a relevant commit.
5. Either the baseline is a current operator override (below), or the grooming run it points at (`groomedRunId`) was fully applied (`stage: "applied"`, `status: "completed"`, not a dry run; `partial` is withheld until the retry lands) and its plan's readiness (#1062) is `ready`, bound to the same evidence digest the baseline records, with an `escalation` admission sitting on the escalation lane.

Readiness is read only from the run the baseline points at. Skipped (in-flight), stale, unverifiable, failed and dry runs never write a baseline, so their stored readiness is never consulted.

The decision on a queue item:

```json
"admission": {
  "mode": "enforce",
  "admitted": false,
  "basis": "grooming",
  "reasons": [{ "code": "grooming_stale", "message": "Grooming decision is stale (human_comment); awaiting re-grooming" }],
  "summary": "Grooming decision is stale (human_comment); awaiting re-grooming",
  "groomedRunId": "clx..."
}
```

`basis` is `grooming`, `override`, or `not_gated` (not a ready issue). Reason codes: `dependency_blocked`, `grooming_unknown`, `grooming_stale`, `grooming_issue_changed`, `grooming_unverified`, `grooming_run_missing`, `grooming_not_applied`, `grooming_partial`, `grooming_readiness_missing`, `grooming_not_ready`, `grooming_evidence_mismatch`, `escalation_lane_mismatch`.

Admission gates what the queue hands out (`next-task`, `/queue`, `get_queue`); it does not gate the claim APIs for an issue a caller names explicitly, the same as the dependency gate.

PR-fix queue items are never subject to admission, and linked-PR follow-up routing in `next-task` scans the queue before admission, so a withheld issue's PR can still be followed up.

Cost: the queue loads a few extra `Issue` columns and does one primary-key `GroomingRun` lookup for the ready issues' baselines, only when admission is on.

### Withheld work stays groomable

Re-grooming is the only way withheld work gets admitted, so with admission on the hosted groomer keeps it eligible: stale results take the existing stale path; a ready issue with no baseline is backfilled ahead of routine backlog re-grooming instead of last; and a fresh result the gate withholds (partial, unpinned, not ready, missing readiness, lane mismatch) is re-selected after the normal 24h cooldown with `candidateSource: "admission_withheld"`. External groomers are not offered this work, for the same reason as backfill.

### Operator override

A bare `status/ready` label is never an override. An operator records one explicitly:

- `POST /api/issues/{issueId}/admission-override` with an optional body `{ "reason": "...", "headSha": "<40-hex>" }`. The issue must be open and already `status/ready` in Dispatch's cache. Without `headSha`, the live default-branch head is resolved from GitHub.
- `DELETE /api/issues/{issueId}/admission-override` clears it; if it was still the baseline, freshness returns to unknown.

The override records the actor, time, reason and head SHA on the issue (`admissionOverride*` columns) and an `admission_override` `AuditLog` row. It is written as the freshness baseline itself, with `groomedRunId` set to the override id and evidence scope `global` (the override vouches for the whole repository at that SHA), so it goes stale under exactly the checks a grooming result does: an issue edit, a new human comment, a dependency change, or any default-branch commit. A later applied groom replaces the baseline and supersedes the override. It never bypasses a `depends on #N` blocker. It also sets `groomedAt`, so the periodic groomer does not replace it on its next tick. Only operator auth can record or clear an override: an OIDC session, basic auth, or `DISPATCH_AUTH_MODE=disabled`. Agent bearer tokens (`DISPATCH_AGENT_TOKEN`, which every worker holds) get `403` on both `POST` and `DELETE`, so a worker cannot override the gate that exists to stop it. In legacy auth mode (no `DISPATCH_AUTH_MODE`) only bearer auth exists, so overrides are unavailable there. The actor is the authenticated operator, and the audit row records it with the auth type.

## Repository Context

When `DISPATCH_GROOMER_REPO_CONTEXT_ENABLED=true`, the groomer gathers bounded repository context through GitHub REST APIs only — it does not clone repositories, execute shell commands, or run GitHub Actions. The number of searches, number of files, bytes per file, and total prompt context are all capped by configuration.

Repository context is best-effort: fetch warnings are recorded on the `GroomingRun` record and the groomer proceeds with issue-only context when the targeted GitHub issue can still be loaded from Dispatch's cache.

## Scheduling

Dispatch exposes a one-run endpoint (`POST /api/groomer/run`), driven by the in-process scheduler in `src/lib/scheduler.ts` on the `DISPATCH_GROOMER_INTERVAL_MS` interval (default 10 minutes). The endpoint remains callable directly — by an external scheduler, or by hand with `DISPATCH_AGENT_TOKEN` or `DISPATCH_GROOMER_TOKEN` — and processes at most one issue per run either way.
