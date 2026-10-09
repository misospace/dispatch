# Groomer Close Policy

**Status:** issue #1069 v1 decision. No additional automatic close classes are approved.

## V1 decision

The hosted groomer may close an issue only as `already_done`, with high confidence, no material uncertainty, and current repository evidence pinned to a SHA that grounds every acceptance criterion of that issue. A related PR or issue may corroborate the conclusion, but cannot establish it by itself; a merged PR alone is insufficient.

`duplicate` and `superseded` remain recommendations only. No machine deduplication, implementation child, UI override, or force path is approved. A human who decides to close an issue must close it manually in GitHub, choosing the target and reason; this is not a groomer close.

Recommendations are persisted in `GroomingRun.mutationPlan`, not surfaced in the UI. Operators can inspect an individual run through the authorized `GET /api/groomer/runs/[id]` detail API.

## Boundaries

No comment, label, duplicate marker, or other timeline event is sufficient human authority for automatic closure. Similar titles, bodies, labels, and citations do not establish duplicate identity. A superseded issue can qualify as `already_done` only when pinned repository evidence independently grounds that issue's own acceptance.

A merged PR that references the issue is corroboration only, in part because an open issue may have been reopened after the merge. An issue GitHub reports as reopened (`state_reason: "reopened"`), an explicit authoritative human report that it still reproduces, or unavailable reopen history withholds the `already_done` close and leaves the issue in backlog for human review; matching repository excerpts cannot override this veto.

## Gate for any separately approved extension

Any proposed extension needs a separate design and explicit approval, including:

- **Bound authority:** define and verify the permitted actor and source; distinguish human action from automation and quoted text.
- **Live target check:** bind the exact target and verify its identity and current state immediately before acting.
- **Regression fixtures:** cover the source-specific authority and target boundaries, including behavior regressing while the cited excerpt remains unchanged.

Until such an extension is approved, duplicate and superseded outcomes remain recommendations only.
