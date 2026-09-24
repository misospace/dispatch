/**
 * Deterministic issue-dependency parsing and gating.
 *
 * An issue whose body says "depends on #5" stays claimable while #5 is open,
 * so dependents get worked before their blockers land. This module extracts
 * dependency refs from issue bodies (no labels involved — label-based gating
 * would churn in the groomer) so the agent queue can exclude claimable
 * issues whose declared blockers are still open.
 */

export interface DependencyRef {
  /** null means "same repo as the depending issue". */
  repo: string | null;
  number: number;
}

/**
 * Normalize a repo identifier for comparison: trim, lowercase.
 * null / undefined / empty string normalize to null (repo unknown / same-repo).
 */
export function normalizeRepoKey(repo: string | null | undefined): string | null {
  if (repo == null) return null;
  const trimmed = repo.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Canonical key for an issue: `owner/repo#N` (lowercased repo) or bare `#N`
 * when the repo is unknown. Used for set membership of open issues and for
 * dedupe of parsed refs.
 */
export function dependencyKey(repo: string | null | undefined, number: number): string {
  return `${normalizeRepoKey(repo) ?? ""}#${number}`;
}

/**
 * Phrases that introduce a list of issue references, matched case-insensitively.
 * "required by" is deliberately NOT a trigger: it names the requester, not a
 * blocker.
 */
const TRIGGER_PATTERN =
  /blocked\s+(?:by|on)|blocking\s+issue|depends?\s+(?:on|upon)|depended\s+on|dependency\s+on|dependencies\s+on|require(?:ments:|s|\b)/gi;

/**
 * One issue ref at the current parse position. Alternatives are ordered so a
 * full GitHub URL wins over `owner/repo#N`, which wins over bare `#N`.
 */
const REF_PATTERN =
  /^(?:https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)|([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)|#(\d+))/;

/** Chars that may separate one ref from the next. */
function isSeparator(ch: string): boolean {
  return ch === "," || ch === "&" || ch === "+" || ch === "/" || /\s/.test(ch);
}

/**
 * Clause boundary chars — the prefix preceding a trigger is clipped at the most
 * recent one, so a negation in one clause never suppresses a trigger in another.
 */
function isClauseBoundary(ch: string): boolean {
  return (
    ch === "." ||
    ch === "!" ||
    ch === "?" ||
    ch === "," ||
    ch === ";" ||
    ch === ":" ||
    ch === "\n"
  );
}

/** Substring from the most recent clause boundary up to (exclusive) `index`. */
function clausePrefix(text: string, index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    if (isClauseBoundary(text[i])) return text.slice(i + 1, index);
  }
  return text.slice(0, index);
}

/**
 * Negation tokens that, when present in the same clause *before* a trigger, mean
 * the phrase disclaims a dependency rather than declaring one ("no dependencies
 * on #5", "does not depend on #5", "don't depend on #5"). Matching the `'t` of a
 * contraction plus whole-word negations catches don't/doesn't/won't/isn't etc.
 */
const NEGATION_PATTERN = /\b(?:no|not|never|without|neither|nor|cannot)\b|'t\b/;

/**
 * Extract dependency refs from an issue body.
 *
 * A trigger phrase (see TRIGGER_PATTERN) starts a ref list; refs are
 * `#N`, `owner/repo#N`, or a GitHub URL ending in `/issues/N`, separated by
 * commas, "and", "&", "+", "/", or whitespace. Refs with number <= 0 are
 * ignored and duplicates (by dependencyKey, using each ref's own repo) are
 * dropped. Never throws; null/undefined bodies yield [].
 *
 * Scope decisions (deliberate):
 * - Negated phrases are not blockers: if the clause preceding a trigger (up to
 *   the nearest clause boundary) contains a negation, that trigger is skipped,
 *   so "does not depend on #5" or "no dependencies on #5" register nothing.
 * - GitHub native `blocked_by` / sub-issue links are not fetched by sync today
 *   (the Issue schema has no such field), so only body-text refs are operative.
 *   The resolver accepts refs from any source, so native links can be fed into
 *   the same gate later without changing this contract.
 */
export function parseIssueDependencies(body: string | null | undefined): DependencyRef[] {
  if (body == null) return [];
  const text = String(body).toLowerCase();
  const refs: DependencyRef[] = [];
  const seen = new Set<string>();

  const addRef = (repo: string | null, number: number) => {
    if (number <= 0) return;
    const key = dependencyKey(repo, number);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ repo, number });
  };

  for (const trigger of text.matchAll(TRIGGER_PATTERN)) {
    // Skip a trigger whose clause disclaims the dependency (negation guard).
    if (NEGATION_PATTERN.test(clausePrefix(text, trigger.index))) continue;
    let pos = trigger.index + trigger[0].length;
    while (pos < text.length) {
      while (pos < text.length && isSeparator(text[pos])) pos++;
      // "and" is a separator word: consume it, then expect a ref next.
      if (
        text.startsWith("and", pos) &&
        (pos + 3 >= text.length || isSeparator(text[pos + 3]))
      ) {
        pos += 3;
        continue;
      }
      const match = REF_PATTERN.exec(text.slice(pos));
      if (!match) break;
      const urlRepo = match[1] && match[2] ? `${match[1]}/${match[2]}` : null;
      const pathRepo = match[4] && match[5] ? `${match[4]}/${match[5]}` : null;
      const number = Number(match[3] ?? match[6] ?? match[7]);
      addRef(urlRepo ?? pathRepo, number);
      pos += match[0].length;
    }
  }
  return refs;
}

/**
 * Filter a list of dependency refs down to the ones whose target is currently
 * open, i.e. whose key (ref repo falling back to `defaultRepo`) is present in
 * `openIssueKeys`. A ref pointing at the depending issue itself is dropped
 * when `self` is provided, so an issue never blocks on itself.
 * Order of the input is preserved.
 *
 * Scope decisions (deliberate):
 * - Direct blockers only, non-transitive: openness is the blocker's raw GitHub
 *   state, not its queue eligibility. If A depends on B and B is itself gated,
 *   A becomes eligible as soon as B is open, even while B is withheld — this
 *   matches the issue's "direct blockers" acceptance criteria.
 * - A blocker in an untracked / disabled repo is absent from the open set and
 *   therefore does not gate (preserve-visibility, consistent with the queue's
 *   unknown-lane policy).
 */
export function resolveOpenBlockers(
  deps: DependencyRef[],
  openIssueKeys: Set<string>,
  defaultRepo: string | null | undefined,
  self?: { repo?: string | null; number?: number },
): DependencyRef[] {
  const open: DependencyRef[] = [];
  for (const dep of deps) {
    if (self && self.number !== undefined) {
      const selfRepo = normalizeRepoKey(self.repo ?? defaultRepo);
      const depRepo = normalizeRepoKey(dep.repo ?? defaultRepo);
      if (selfRepo === depRepo && dep.number === self.number) continue;
    }
    if (openIssueKeys.has(dependencyKey(dep.repo ?? defaultRepo, dep.number))) {
      open.push(dep);
    }
  }
  return open;
}

/**
 * Human-readable block reason for a set of open blockers. Returns "" when
 * there are none. Each ref renders as `owner/repo#N` when its repo differs
 * from `defaultRepo` (normalized) and as bare `#N` otherwise.
 */
export function formatDependencyBlockReason(
  blockers: DependencyRef[],
  defaultRepo?: string | null,
): string {
  if (blockers.length === 0) return "";
  const defaultKey = normalizeRepoKey(defaultRepo);
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const b of blockers) {
    const repoKey = normalizeRepoKey(b.repo);
    const rendered = repoKey && repoKey !== defaultKey ? `${b.repo}#${b.number}` : `#${b.number}`;
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    parts.push(rendered);
  }
  return `Blocked by open ${parts.join(", ")}`;
}
