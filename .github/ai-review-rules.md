# AI PR Review: dispatch

## Security review conventions

Dispatch is a Next.js/TypeScript Kanban and work dispatch layer. Contains both application logic and infrastructure concerns.

Security-sensitive areas:
- **API routes** (`src/app/api/`): bearer-token auth (`DISPATCH_AGENT_TOKEN`), input validation before DB operations
- **Prisma ORM**: schema migrations, relation integrity (nullable foreign keys hide bugs — keep them strict)
- **GitHub tokens** (`GITHUB_TOKEN`): never log or persist to disk
- **Agent tokens** (`DISPATCH_AGENT_TOKEN`): bearer auth for agent API, never log
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
