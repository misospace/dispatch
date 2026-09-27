# Groomer Close Policy

**Status:** issue #1069 v1 decision. This document does not authorize or implement additional automatic close classes.

## V1 decision

The hosted groomer may autonomously close only an issue it classifies as `already_done` under the existing deterministic policy: high confidence, no material uncertainty, and current repository evidence pinned to a SHA that grounds every acceptance criterion of that issue. Each criterion must be grounded in repository content read at that SHA. A related PR or issue may corroborate the conclusion, but cannot establish it by itself; a merged PR alone is not proof that this issue is resolved.

`duplicate` and `superseded` remain recommendations for human review. No new autonomous close class, machine deduplication, implementation child, UI override, or force path is approved. The existing `already_done` policy is not broadened by this decision. There is no requirement or authorization for an operator override: a human who decides to close an issue must close it manually in GitHub, choosing the target and reason themselves. That manual action is not a groomer close and does not feed back as verified provenance to the groomer.

The recommendations are persisted in `GroomingRun.mutationPlan` only; they are not surfaced in the UI. An operator can inspect an individual run through the authorized `GET /api/groomer/runs/[id]` detail API. The recommendation does not presently carry a verified human decision or a complete, independently verified target record, so it must not be treated as such.

## Authority and evidence boundaries

No GitHub comment, label, duplicate marker, or other timeline event is sufficient human authority for automatic closure in v1. This includes a human-authored comment: although an operator can manually close an issue in GitHub with a chosen target and reason, Dispatch does not currently verify the actor, intent, target, or provenance of that action for groomer policy. A bot or AI-authored comment, quoted text, or automation event is not human authority either.

Do not infer duplicate identity from title or body similarity. Machine deduplication is not approved. Any future proposal must define a stable, machine-readable identity under a source-specific contract and demonstrate collision and regression safety; similar wording, shared labels, and related-work citations are insufficient.

A superseded issue may be classified `already_done` only when current pinned repository evidence independently grounds that issue's own acceptance as satisfied. The existence of a newer issue, replacement PR, or merged PR does not suffice. Reopened issues and issues with regression evidence must go to human review, not an automatic close. This is a normative safety rule, not a description of current behavior: the existing `already_done` path does not check the issue's reopened/regression timeline. That implementation gap needs a separate guardrail follow-up; #1063 is already closed and does not supply it. Until that guardrail exists, do not interpret the current path as proving that an issue was never reopened or regressed.

## Requirements for a separately approved extension

Any future close class needs a separate design and explicit approval, and must establish all of the following before implementation or enablement:

- **Bound authority:** specify the allowed actor and source, prove provenance, and distinguish authenticated human action from automation and quoted content. A timeline signal alone is not authority.
- **Bound target:** record the target repository, issue number, URL, and observed state; verify the target and state are current immediately before acting. A target being closed is not proof that this issue's symptom is resolved.
- **Bound evidence:** record checked-at time, immutable source/event ID, pinned repository SHA, and evidence bindings connecting this exact issue's acceptance to the decision. State explicitly what present recommendation data does not establish.
- **Versioned live check:** record the policy version and re-check required facts immediately before a close. Missing, stale, ambiguous, or changed facts fail closed.
- **Safe uncertainty handling:** preserve the recommendation and route uncertainty to human review; do not apply a done label or close. The existing pipeline can post a pre-close comment before a close attempt. Any future close class must not post an automatic resolution comment; that prohibition does not claim the current pipeline never posts a comment before closing.
- **No generic override:** human review means a human manually acts in GitHub. It is not a UI control, a generic `force` bypass, or permission for the groomer to close on the human's behalf. Any future machine override would need a separately specified and approved authority contract.
- **Regression proof:** pass the concrete fixture matrix below, expanded for the source-specific boundary cases, before enablement.

### Minimum fixture matrix for a future extension

| Case | Expected result |
| --- | --- |
| Authenticated human action with explicit target and reason, verified from the authoritative source | May proceed only if the separately approved policy accepts that exact source; record actor, target, reason, and immutable event ID. |
| Same-looking comment by bot/AI, or quoted human text | Reject as authority; recommendation only. |
| Human comment or label without a verified actor, target, or reason | Reject as authority; recommendation only. |
| GitHub duplicate marker from unknown/unverified actor | Reject as authority; recommendation only. |
| Correct target is open, wrong repository/number, deleted, inaccessible, or stale | Do not close; retain recommendation for human review. |
| Target is closed or merged PR exists, but current issue's acceptance is not independently proven | Do not close. |
| Current issue was reopened or has regression evidence | Do not close; route to human review. Include the current `already_done` implementation gap as a failing safety fixture until a separate guardrail closes it. |
| Similar titles/bodies, shared labels, or citation without a stable identity | Do not deduplicate or close. |
| Stable identity collision or contradictory evidence | Fail closed and retain recommendation. |
| Required source/event/state/evidence is missing, stale, ambiguous, or changes between planning and apply | Apply no close; record why and retain recommendation. |

These are gates for a separately approved extension, not features promised by the current groomer. Until a class passes its applicable fixtures and receives an explicit policy decision, duplicate and superseded outcomes remain recommendations only.
