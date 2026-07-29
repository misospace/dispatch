/**
 * GitHub issues, pull requests and review helpers facade — intentionally empty.
 *
 * This facade was introduced as part of #618 (split `github.ts` into domain
 * modules) but was closed as declined by #655. The facades added no value
 * beyond re-exporting from `./github`, so they have been left as empty
 * modules to preserve the public module surface and the file's role as a
 * documented split point, without the misleading `export *` re-export.
 *
 * Callers should import directly from `@/lib/github`. See #655 for the
 * reconciliation decision.
 */
export {};
