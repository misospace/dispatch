---
name: dispatch-security-review
description: Review Dispatch API routes, bearer-token authorization, Prisma data integrity, GitHub sync, webhooks, and PR automation for security and correctness.
---

# AI PR Review: dispatch

## Security review conventions

Dispatch is a Next.js/TypeScript Kanban and work dispatch layer. Contains both application logic and infrastructure concerns.

Security-sensitive areas:
- **API routes** (`src/app/api/`): enforce the correct bearer-token tier and authorization before DB operations. `DISPATCH_WORKER_TOKENS` binds worker credentials to an agent identity; `DISPATCH_AGENT_TOKEN` / `DISPATCH_MAINTAINER_TOKEN` are full-rights maintainer credentials.
- **Prisma ORM**: schema migrations, relation integrity (nullable foreign keys hide bugs — keep them strict)
- **GitHub tokens** (`GITHUB_TOKEN`): never log or persist to disk
- **Worker credentials** (`DISPATCH_WORKER_TOKENS`): each `agentName:token` pair binds one worker token to one agent; never trust caller-supplied identity over the token binding. The legacy unbound `DISPATCH_WORKER_TOKEN` is rejected on identity-scoped routes.
- **Maintainer credentials** (`DISPATCH_AGENT_TOKEN`, `DISPATCH_MAINTAINER_TOKEN`): full-rights bearer credentials; never expose to ordinary workers, log, or persist outside their intended secret/configuration path.
- **Automation sync**: pipeline syncs issue data from GitHub; validate incoming data shapes
- **Webhook/ingestion endpoints** (`pr-followup`, `pr-fix-queue`): validate webhook payloads, authenticate sources

## Compact Renovate digest-only reviews

For Renovate digest-only container image updates where the repository and tag are unchanged and the diff only changes `@sha256:` values, keep `review_markdown` compact.

Prefer:
- short recommendation
- changed files summary
- non-blocking caveats, if any

Do not include separate Standards Compliance, Linked Issue Fit, Evidence Provider Findings, Tool Harness Findings, or Unknowns sections unless they contain an actual warning or blocker.

Do not include internal planner/tool-harness diagnostics such as missing `requests[]` unless they affect the recommendation.

Missing OCI revision/source labels are a non-blocking caveat for same-tag digest refreshes when repository, tag, and created timestamp evidence are consistent.

## Review tone

- Be direct and practical.
- Flag only real defects, regressions, or meaningful risks as blocking.
- Do not nitpick formatting, naming, or style unless it affects readability or correctness.
- Prefer `approve` or non-blocking comments for PRs that look reasonable overall.

## Focused review procedure

- Trace each changed API route from authentication and authorization through input validation, database access, and response serialization. Validate before querying or mutating.
- Treat GITHUB_TOKEN and all DISPATCH_* tokens as credentials: they must not be logged, returned to clients, or persisted outside their intended secret/configuration path.
- For Prisma schema or migration changes, check relation integrity, nullability, uniqueness, transaction boundaries, migration reversibility where applicable, and generated client changes.
- For webhook or GitHub ingestion changes, validate the source and payload shape, handle retries and duplicates, and preserve GitHub as the source of truth rather than treating cached rows as authoritative.
- For PR-fix queue or follow-up automation, check authorization, issue/PR identity binding, race handling, and that untrusted event fields never become shell code.
- Keep Renovate digest-only reviews compact as described above. Report concrete risks with changed paths and evidence, not generic hardening wishes.
