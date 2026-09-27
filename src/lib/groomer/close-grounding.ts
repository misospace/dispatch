/**
 * Grounding for already_done closes (dispatch#1099).
 *
 * The #1063 close policy asked for high confidence and at least one close
 * citation read at the pinned head. That was satisfied mechanically by real
 * files that had nothing to do with the issue being closed: a CHANGELOG entry
 * for a sibling issue and a module that sibling added. Nothing checked that
 * the evidence established THIS issue's acceptance.
 *
 * An already_done close must now ground every acceptance criterion of the
 * issue in a repository file read at the pinned head, with an excerpt that
 * occurs verbatim in that file's content as fetched (whitespace-normalised
 * exact substring) and is specific enough to mean something, and, if the
 * issue names expected files, at least one grounded citation among them.
 *
 * A merged pull request into the default branch whose GitHub closing
 * reference is this exact issue is recorded as corroboration but never
 * satisfies the close alone: such a PR closes the issue on merge, so finding
 * the issue still open usually means someone reopened it. Evidence about
 * other issues (sibling, parent or dependent PRs, changelog entries, excerpts
 * that cite another issue) likewise corroborates at most. The same checks
 * run in plan validation and again at apply time.
 */

import type { CloseCriterionEvidence } from "./plan";
import type { EvidenceCatalog, EvidenceCatalogEntry } from "./plan-evidence";

// ─── Pinned read content ──────────────────────────────────────────────────────

/**
 * Content of repository files read at the snapshot's pinned head SHA during
 * this run, kept only so close excerpts can be checked. It lives for one run,
 * is never rendered or persisted, and is bounded: the reads it holds are
 * already bounded by the exploration and repository-context byte budgets, and
 * the store caps itself as well.
 */
export interface PinnedReadContent {
  headSha: string | null;
  /** Path to whitespace-normalised content, as read at `headSha`. */
  files: ReadonlyMap<string, string>;
}

export interface PinnedRead {
  path: string;
  /** The ref the file was read at; only reads at the head SHA are kept. */
  ref: string | null;
  content: string;
}

/** Hard cap on pinned content retained per run, after normalisation. */
export const MAX_PINNED_CONTENT_BYTES = 1_000_000;

export const EMPTY_PINNED_CONTENT: PinnedReadContent = { headSha: null, files: new Map() };

/**
 * Whitespace normalisation for excerpt matching: every run of whitespace
 * (spaces, tabs, newlines) becomes one space, and the ends are trimmed. The
 * comparison after that is an exact, case-sensitive substring match, so an
 * excerpt may re-wrap or re-indent the lines it quotes but may not change a
 * single other character.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Build the run's pinned content store. Reads at any other ref, or when the
 * run has no pinned head, are dropped. When a path was read more than once
 * (the same file, truncated differently) the longest read is kept.
 */
export function collectPinnedReadContent(
  headSha: string | null,
  reads: PinnedRead[],
  maxBytes = MAX_PINNED_CONTENT_BYTES,
): PinnedReadContent {
  const files = new Map<string, string>();
  if (!headSha) return { headSha: null, files };
  let total = 0;
  for (const read of reads) {
    if (read.ref !== headSha || !read.path || !read.content) continue;
    const normalized = normalizeWhitespace(read.content);
    const existing = files.get(read.path);
    if (existing !== undefined && existing.length >= normalized.length) continue;
    const delta = Buffer.byteLength(normalized, "utf8") - (existing ? Buffer.byteLength(existing, "utf8") : 0);
    if (total + delta > maxBytes) continue;
    files.set(read.path, normalized);
    total += delta;
  }
  return { headSha, files };
}

// ─── Parsing the issue body ───────────────────────────────────────────────────

const KNOWN_EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs mts cts py pyi sh bash zsh fish ps1 go rs rb java kt kts scala swift m mm c h cc cpp hpp cs fs " +
    "php pl lua r jl dart ex exs erl hrl elm clj hs ml nim zig sol gd tscn tres vue svelte astro html htm css scss sass " +
    "less md mdx rst txt adoc json jsonc json5 yml yaml toml ini cfg conf env xml csv tsv sql prisma graphql gql proto " +
    "tf tfvars hcl nix lock gradle properties dockerfile mk cmake bzl bazel ipynb"
  ).split(" "),
);

const KNOWN_EXTENSIONLESS = new Set([
  "Dockerfile",
  "Containerfile",
  "Makefile",
  "Justfile",
  "Procfile",
  "Gemfile",
  "Rakefile",
  "Brewfile",
  "Taskfile",
  "Vagrantfile",
  "LICENSE",
  "CODEOWNERS",
]);

/**
 * Whether a token names a repository file. Deliberately conservative: a
 * path with a directory needs a file extension (or a well-known
 * extensionless name); a bare file name needs a known source/config
 * extension, so `config.enabled` or `resolve_platform()` never count.
 */
export function asRepoFilePath(raw: string): string | null {
  let token = raw.trim();
  // Line anchors are not part of the path: `src/a.ts:42`, `src/a.ts#L10-L20`.
  token = token.replace(/#L\d+(?:-L?\d+)?$/, "").replace(/:\d+(?:[-:]\d+)?$/, "");
  while (token.startsWith("./")) token = token.slice(2);
  if (!token || token.length > 300) return null;
  if (!/^[A-Za-z0-9_.@+\-/]+$/.test(token)) return null;
  if (token.startsWith("/") || token.startsWith("-") || token.endsWith("/")) return null;
  const segments = token.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  const name = segments[segments.length - 1];
  if (KNOWN_EXTENSIONLESS.has(name)) return token;
  if (/^\.[A-Za-z][\w.-]*$/.test(name)) return token; // dotfiles: .gitignore, .env.example
  const ext = /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(name)?.[1];
  if (!ext) return null;
  if (segments.length > 1) return token;
  return KNOWN_EXTENSIONS.has(ext.toLowerCase()) ? token : null;
}

function backtickedTokens(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
/**
 * A label line: a short title, then a colon (inside or outside bold), then
 * an optional remainder. `Expected files:`, `**Expected files:**`,
 * `**Expected files**: \`a.ts\``. A sentence with punctuation is not a label.
 */
const LABEL_LINE = /^\s*(?:\*\*|__)?([A-Za-z][A-Za-z0-9 /()'-]{0,60}?)\s*(?::\s*(?:\*\*|__)|(?:\*\*|__)\s*:|:)\s*(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;

/**
 * The lines of every section whose title matches `title`: a markdown heading
 * (`## Expected files`) running to the next heading, or a label line
 * (`Expected files:`) running to the next heading, the next label line, or
 * the first blank line after its content. A label line's own remainder
 * (`Expected files: \`a.ts\``) is part of its section.
 */
function sectionLines(body: string, title: RegExp): string[] {
  const out: string[] = [];
  let mode: "none" | "heading" | "label" = "none";
  let seenContent = false;
  for (const line of body.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      mode = title.test(heading[1].replace(/[*_`:]/g, "").trim()) ? "heading" : "none";
      seenContent = false;
      continue;
    }
    const label = LIST_ITEM.test(line) ? null : LABEL_LINE.exec(line);
    if (label && title.test(label[1].trim())) {
      mode = "label";
      seenContent = false;
      if (label[2].trim()) {
        out.push(label[2]);
        seenContent = true;
      }
      continue;
    }
    if (mode === "label") {
      if (!line.trim()) {
        if (seenContent) mode = "none";
        continue;
      }
      if (label) {
        mode = "none";
        continue;
      }
    }
    if (mode !== "none") {
      out.push(line);
      if (line.trim()) seenContent = true;
    }
  }
  return out;
}

const EXPECTED_FILES_TITLE = /^(?:expected|affected|target)\s+files?\b/i;
const ACCEPTANCE_TITLE = /^acceptance(?:\s+criteria)?\b/i;

function uniquePaths(paths: Array<string | null>): string[] {
  return [...new Set(paths.filter((p): p is string => p !== null))];
}

/**
 * The files the issue says the work touches (dispatch#1099). An "Expected
 * files" section (heading or label, the groomer's own brief format) is
 * authoritative when present: its backticked paths, or a list item's leading
 * path. Without one, the explicit backticked repository paths anywhere in the
 * body are the issue's named files. Anything that does not look like a file
 * path is ignored.
 */
export function parseExpectedFiles(body: string | null | undefined): string[] {
  if (!body) return [];
  const section = sectionLines(body, EXPECTED_FILES_TITLE);
  if (section.length > 0) {
    const found: Array<string | null> = [];
    for (const line of section) {
      const ticks = backtickedTokens(line);
      if (ticks.length > 0) {
        found.push(...ticks.map(asRepoFilePath));
      } else {
        const item = LIST_ITEM.exec(line)?.[1] ?? line.trim();
        found.push(asRepoFilePath(item.split(/\s+/)[0] ?? ""));
      }
    }
    const paths = uniquePaths(found);
    if (paths.length > 0) return paths;
  }
  return uniquePaths(backtickedTokens(body).map(asRepoFilePath));
}

/**
 * The issue's acceptance criteria: the list items (checkboxes or bullets) of
 * its "Acceptance criteria" sections. Empty when the issue states none in a
 * form that can be enumerated.
 */
export function parseAcceptanceCriteria(body: string | null | undefined): string[] {
  if (!body) return [];
  const items = sectionLines(body, ACCEPTANCE_TITLE)
    .map((line) => LIST_ITEM.exec(line)?.[1]?.trim())
    .filter((item): item is string => !!item);
  return [...new Set(items)];
}

/** Criterion text comparison: case, emphasis/backticks, spacing and a trailing stop are ignored. */
export function normalizeCriterion(text: string): string {
  return normalizeWhitespace(text.replace(/[`*_~]/g, "").toLowerCase()).replace(/[.;:,!]+$/, "");
}

// ─── The close check ──────────────────────────────────────────────────────────

/** What the catalog carries for close grounding; not rendered as evidence ids. */
export interface CloseGroundingContext {
  /** `owner/repo#N` of the issue being groomed. */
  issueKey: string;
  expectedFiles: string[];
  acceptanceCriteria: string[];
  pinnedContent: PinnedReadContent;
}

const CHANGELOG_NAME = /^(?:changelog|changes|history|news|release[-_ ]?notes|releases)$/i;

function isChangelog(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return CHANGELOG_NAME.test(name.replace(/\.[^.]*$/, ""));
}

function repoPathOf(entry: EvidenceCatalogEntry): string {
  return entry.id.startsWith("repo:") ? entry.id.slice("repo:".length) : entry.id;
}

/** Issue/PR numbers an excerpt refers to other than this issue. */
function otherIssueRefs(excerpt: string, issueKey: string): string[] {
  const hash = issueKey.lastIndexOf("#");
  const repo = issueKey.slice(0, hash).toLowerCase();
  const number = issueKey.slice(hash + 1);
  const refs = new Set<string>();
  for (const m of excerpt.matchAll(/(?<!&)#(\d+)\b/g)) {
    if (m[1] !== number) refs.add(`#${m[1]}`);
  }
  for (const m of excerpt.matchAll(/([\w.-]+\/[\w.-]+)#(\d+)\b/g)) {
    if (m[1].toLowerCase() !== repo || m[2] !== number) refs.add(`${m[1]}#${m[2]}`);
  }
  for (const m of excerpt.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g)) {
    if (m[1].toLowerCase() !== repo || m[2] !== number) refs.add(`${m[1]}#${m[2]}`);
  }
  return [...refs];
}

export interface CloseGroundingResult {
  /** Field-path prefixed reasons the close is not grounded; empty means it is. */
  errors: string[];
  /** The cited merged PR whose closing reference is this issue, if any. */
  closingPullRequest: string | null;
}

/**
 * A cited merged PR into the default branch whose GitHub closing reference is
 * this issue. Corroboration only: it is reported, never a substitute for
 * grounded criteria.
 */
function closingPullRequestOf(refs: string[], catalog: EvidenceCatalog, byId: Map<string, EvidenceCatalogEntry>): string | null {
  const key = catalog.grounding.issueKey.toLowerCase();
  const branch = catalog.binding.defaultBranch;
  for (const id of refs) {
    const entry = byId.get(id);
    if (!entry || entry.subject !== "related_work" || entry.provenance !== "github_pull_request") continue;
    const closes = (entry.closes ?? []).map((k) => k.toLowerCase());
    if (entry.state === "merged" && !!branch && entry.baseRef === branch && closes.includes(key)) return id;
  }
  return null;
}

/** Shortest excerpt, after whitespace normalisation, that may ground a criterion. */
export const MIN_EXCERPT_CHARS = 24;

/**
 * Words that carry no meaning of their own in an excerpt: language keywords
 * and literals common across the languages the groomer reads. An excerpt made
 * only of these, punctuation, brackets and numbers could match nearly any
 * file, so it grounds nothing. Deliberately short: any identifier, string or
 * name that is not listed here makes the excerpt specific enough.
 */
const TRIVIAL_WORDS = new Set(
  (
    "import from export default return returns nil null none undefined true false const let var val function func fn " +
    "def class struct interface type enum impl trait pub mod use package module require if else elif then fi for foreach " +
    "while do done end in of is not and or async await yield new this self super public private protected static final " +
    "void int string bool boolean try catch except finally throw throws raise pass break continue case switch match " +
    "when with as go defer select lambda echo local set get err error ok"
  ).split(" "),
);

/**
 * Why an excerpt is too generic to ground anything, or null when it is
 * specific enough. Relevance is still the model's judgement; this only makes
 * trivial matches impossible.
 */
export function trivialExcerptReason(excerpt: string): string | null {
  const normalized = normalizeWhitespace(excerpt);
  if (normalized.length < MIN_EXCERPT_CHARS) {
    return `is ${normalized.length} characters after collapsing whitespace; quote at least ${MIN_EXCERPT_CHARS} so the match is specific`;
  }
  const words = normalized.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  if (words.every((word) => TRIVIAL_WORDS.has(word.toLowerCase()))) {
    return "is only punctuation, brackets, numbers or common keywords; quote something specific to this change";
  }
  return null;
}

/**
 * Check an already_done close's grounding against the run's catalog and
 * pinned content. Deterministic: the same close and catalog give the same
 * errors in the same order. A cited closing PR is reported in
 * `closingPullRequest` but satisfies nothing: every criterion must be
 * grounded either way.
 */
export function evaluateCloseGrounding(
  close: { evidenceRefs: string[]; criteria: CloseCriterionEvidence[] },
  catalog: EvidenceCatalog,
): CloseGroundingResult {
  const errors: string[] = [];
  const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const { grounding } = catalog;
  const content = grounding.pinnedContent;
  const pinnedHead = catalog.binding.headSha;
  const expected = new Set(grounding.expectedFiles);

  const grounded: Array<{ index: number; path: string }> = [];
  close.criteria.forEach((c, i) => {
    const at = `mutations.close.criteria[${i}]`;
    const entry = byId.get(c.evidenceRef);
    if (!entry || entry.subject !== "repository") {
      errors.push(`${at}.evidenceRef: "${c.evidenceRef}" must be a repository evidence reference`);
      return;
    }
    const path = repoPathOf(entry);
    if (!entry.pinned || !pinnedHead) {
      errors.push(`${at}.evidenceRef: ${path} was not read at the pinned head SHA`);
      return;
    }
    const text = content.headSha === pinnedHead ? content.files.get(path) : undefined;
    if (text === undefined) {
      errors.push(`${at}.evidenceRef: the content of ${path} as read at the pinned head is not available to check the excerpt against`);
      return;
    }
    if (isChangelog(path) && !expected.has(path)) {
      errors.push(
        `${at}.evidenceRef: ${path} is a changelog or release-notes file; it records other work and cannot ground this issue's criteria`,
      );
      return;
    }
    const trivial = trivialExcerptReason(c.excerpt);
    if (trivial) {
      errors.push(`${at}.excerpt: ${trivial}`);
      return;
    }
    const excerpt = normalizeWhitespace(c.excerpt);
    if (!text.includes(excerpt)) {
      errors.push(
        `${at}.excerpt: not found verbatim in ${path} as read at ${pinnedHead.slice(0, 12)} (exact substring after collapsing whitespace); quote the file, do not paraphrase`,
      );
      return;
    }
    const others = otherIssueRefs(c.excerpt, grounding.issueKey);
    if (others.length > 0) {
      errors.push(
        `${at}.excerpt: refers to ${others.join(", ")}; evidence about other issues can corroborate but cannot ground this issue's criteria`,
      );
      return;
    }
    grounded.push({ index: i, path });
  });

  const closingPullRequest = closingPullRequestOf(close.evidenceRefs, catalog, byId);
  const complete =
    "already_done must ground every acceptance criterion of this issue in a file read at the pinned head, with a verbatim excerpt; related work, including a merged PR that closes this issue, only corroborates";
  if (close.criteria.length === 0) {
    errors.push(`mutations.close.criteria: ${complete}`);
    return { errors, closingPullRequest };
  }

  if (grounding.acceptanceCriteria.length > 0) {
    const covered = new Set(grounded.map((g) => normalizeCriterion(close.criteria[g.index].criterion)));
    const missing = grounding.acceptanceCriteria.filter((criterion) => !covered.has(normalizeCriterion(criterion)));
    if (missing.length > 0) {
      const shown = missing.slice(0, 5).map((m) => `"${m}"`).join(", ") + (missing.length > 5 ? `, +${missing.length - 5} more` : "");
      errors.push(`mutations.close.criteria: ${complete}; not grounded: ${shown}`);
    }
  }

  if (expected.size > 0 && !grounded.some((g) => expected.has(g.path))) {
    errors.push(
      `mutations.close.criteria: the issue names expected files (${[...expected].join(", ")}); at least one grounded citation must be one of them`,
    );
  }

  return { errors, closingPullRequest };
}
