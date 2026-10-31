// Imported from the concrete module rather than the "@/lib/github" barrel:
// suites that partially mock the barrel would otherwise leave these undefined
// at module load and fail before any test runs.
import {
  fetchRepositoryFileText as defaultFetchFile,
  listRepositoryDirectory as defaultListDir,
  searchRepositoryCode as defaultSearchCode,
} from "@/lib/github-code-search";
import {
  fetchRelatedCommit,
  fetchRelatedIssue,
  fetchPullRequestClosingIssues,
  fetchRelatedPullRequest,
  searchRelatedWork,
  RelatedWorkNotFoundError,
} from "@/lib/github-related-work";
import type { RelatedWorkObservation } from "./evidence-snapshot";

/**
 * Read-only repository tools the groomer drives itself.
 *
 * Grooming used to receive one pre-computed briefing assembled from three
 * keyword searches picked by word order, which meant it could never open a
 * file it had not been handed. These tools let it look, then look again based
 * on what it found. The related-work tools extend the same bounded, read-only
 * exploration to GitHub history: the issues, PRs, and commits the issue names.
 * Nothing here writes: the groomer reads the repository and reports, and every
 * mutation still goes through the existing run pipeline.
 */

export const GROOMER_TOOL_NAMES = [
  "search_code",
  "read_file",
  "list_directory",
  "search_related_work",
  "read_related_issue",
  "read_related_pr",
  "read_related_commit",
  "submit_findings",
] as const;

export type GroomerToolName = (typeof GROOMER_TOOL_NAMES)[number];

export interface GroomerToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface GroomerToolResult {
  ok: boolean;
  /** Rendered for the model as the tool message content. */
  content: string;
  /**
   * Bytes charged against the exploration budget. An empty successful search
   * keeps `bytes: 0` — the freshness layer reads it as the negative-evidence
   * sentinel (dispatch#1091) — and charges its rendered answer through
   * `chargedBytes` instead (dispatch#1451).
   */
  bytes: number;
  /**
   * Bytes actually charged against the run budget when they differ from
   * `bytes` (an empty search keeps `bytes: 0` as the freshness
   * negative-evidence sentinel while its rendered answer is charged here,
   * dispatch#1451). Everything else leaves it unset.
   */
  chargedBytes?: number;
  /** Repo paths this call surfaced, for the run's source list. */
  sources: string[];
  /** GitHub issue/PR/commit state a related-work call observed (not repo paths). */
  relatedWork?: RelatedWorkObservation[];
  /** Warnings to surface on the exploration result, e.g. a failed lookup. */
  warnings?: string[];
  /**
   * read_file only: the text the model was shown and the ref it was read at
   * (null for the default branch), so close excerpts can be checked against
   * exactly what was read (dispatch#1099). A bounded range read carries only
   * the lines that were shown, verbatim; the header and continuation
   * coordinates are rendering, not evidence content.
   */
  file?: { path: string; ref: string | null; content: string };
  /**
   * The result the model was shown was clipped, so the model saw a prefix,
   * not the whole result (dispatch#1452): read_file to maxFileBytes,
   * list_directory to maxDirEntries, and the related-work tools when the
   * JSON payload was reduced to fit the caller's budget (dispatch#1468).
   * The answers that showed nothing leave it unset.
   */
  truncated?: boolean;
  /**
   * read_file / list_directory: the answer showed the whole path content
   * (a full read or a range that reached EOF) or the complete directory
   * listing, so the run established what that path holds and an earlier
   * truncation fact for it can retire (dispatch#1451). An answer that
   * showed nothing — unreadable/empty file, past-the-end coordinate,
   * budget-exhausted notice, empty listing — never claims this: showing
   * nothing establishes nothing, and a clipped read already carries
   * `truncated` (review of dispatch#1451).
   */
  established?: boolean;
  /**
   * read_file only: the line coordinates the answer showed (1-based,
   * inclusive). Answers that showed nothing — unreadable/empty file,
   * past-the-end coordinate, budget-exhausted notice — leave it unset
   * (dispatch#1451).
   */
  shownRange?: { start: number; end: number; totalLines: number; eof: boolean };
}

export interface GroomerToolDeps {
  searchCode: (repoFullName: string, query: string, limit: number) => Promise<{ path: string }[]>;
  readFile: (repoFullName: string, path: string, ref?: string) => Promise<string>;
  listDir: (
    repoFullName: string,
    path: string,
    ref?: string,
  ) => Promise<{ path: string; type: "file" | "dir"; size: number | null }[]>;
  fetchRelatedIssue: typeof fetchRelatedIssue;
  fetchRelatedPullRequest: typeof fetchRelatedPullRequest;
  fetchRelatedCommit: typeof fetchRelatedCommit;
  searchRelatedWork: typeof searchRelatedWork;
  fetchPullRequestClosingIssues: typeof fetchPullRequestClosingIssues;
}

export const defaultGroomerToolDeps: GroomerToolDeps = {
  searchCode: defaultSearchCode,
  readFile: defaultFetchFile,
  listDir: defaultListDir,
  fetchRelatedIssue,
  fetchRelatedPullRequest,
  fetchRelatedCommit,
  searchRelatedWork,
  fetchPullRequestClosingIssues,
};

/** OpenAI-style tool definitions sent with each exploration turn. */
export function buildGroomerToolDefinitions(): Record<string, unknown>[] {
  return [
    {
      type: "function",
      function: {
        name: "search_code",
        description:
          "Search this repository's code for a string. Use short, distinctive terms " +
          "(an identifier, an env var, an error message). Returns matching file paths.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", description: "Search term, e.g. PrismaPg or DATABASE_URL" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a file from this repository by its full path from the repo root, " +
          "e.g. src/lib/prisma.ts. Long files are truncated; when the output says " +
          "it continues at line N, call read_file again with startLine=N to read " +
          "the next section. Pass `ref` to read " +
          "a specific branch or SHA; without it, the repository's default branch " +
          "is used. Pass the default branch when verifying whether an issue's " +
          "premise still holds against the current `main`.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", description: "Path from the repository root" },
            ref: {
              type: "string",
              description:
                "Branch, tag, or commit SHA. Omit for the repository's default " +
                "branch; supply explicitly when verifying that a file/symbol " +
                "still exists on `main`.",
            },
            startLine: {
              type: "integer",
              minimum: 1,
              description:
                "1-based first line to read. Use it with the \"continues at line N\" " +
                "hint to finish reading a truncated file, e.g. to reach the tail " +
                "of a long file a previous read cut off.",
            },
            lineCount: {
              type: "integer",
              minimum: 1,
              description:
                `Maximum number of lines to return, capped at ${MAX_READ_LINES}; the per-file byte ` +
                "limit may cut earlier (the output says where to continue). Omit " +
                "to read from the start up to the byte limit.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_directory",
        description:
          "List the entries in a directory of this repository. Pass an empty string " +
          "for the repository root. Use this to orient yourself before guessing paths.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", description: "Directory path from the repo root, or \"\" for root" },
            ref: {
              type: "string",
              description: "Branch, tag, or commit SHA. Omit for the repository's default branch.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_related_work",
        description:
          "Search this repository's GitHub issues and pull requests for related work. " +
          "Read-only evidence about the project's history, bounded server-side. Use this " +
          "only as a fallback, after reading any issue, PR, or commit the issue itself names. " +
          "Each result's open/closed/merged state is authoritative.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", description: "Search term, e.g. an identifier or error message" },
            type: {
              type: "string",
              enum: ["issue", "pr", "all"],
              description: "Kind of work to search. Defaults to all.",
            },
            state: {
              type: "string",
              enum: ["open", "closed", "all"],
              description: "State filter. Defaults to all.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_related_issue",
        description:
          "Read a GitHub issue in this repository by number. Read-only evidence about the " +
          "project's history: title, body, labels, recent comments, and its state. The " +
          "open/closed state is structured, authoritative evidence — do not infer status from prose. " +
          "GitHub's issue endpoint also serves pull-request numbers, so use read_related_pr " +
          "for a PR's authoritative merged state.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["number"],
          properties: {
            number: { type: "integer", description: "Issue number in this repository" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_related_pr",
        description:
          "Read a pull request in this repository by number. Read-only evidence about the " +
          "project's history: title, body, and its state. The open/closed/merged state is " +
          "structured, authoritative evidence — do not infer status from prose. A merged PR " +
          "also lists `closingIssues`: the issues GitHub records it as closing.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["number"],
          properties: {
            number: { type: "integer", description: "Pull request number in this repository" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_related_commit",
        description:
          "Read a commit in this repository by SHA. Read-only evidence about the " +
          "repository's history: message, author, and date.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["ref"],
          properties: {
            ref: { type: "string", description: "Commit SHA (full or short)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "submit_findings",
        description:
          "Call this when you have seen enough. Report the files a worker will need " +
          "to change and what the issue is actually asking for, in this repository's terms.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["files", "ask"],
          properties: {
            files: {
              type: "array",
              items: { type: "string" },
              description: "Repo paths a worker will most likely need to change",
            },
            ask: {
              type: "string",
              description: "The concrete change this issue is asking for, in repo terms",
            },
            notes: {
              type: "string",
              description: "Anything else a worker needs to know before starting",
            },
          },
        },
      },
    },
  ];
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  // Cut back to a character boundary. A raw byte slice can land mid-sequence
  // and leave a replacement character just before the truncation marker.
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  const cut = decoder.decode(buf.subarray(0, maxBytes)).replace(/\uFFFD$/, "");
  return { text: cut, truncated: true };
}

/**
 * Cut a summary to a byte budget, marking the cut so the model can see that
 * the line ends there instead of reading it as the whole upstream error.
 */
function cutWithMarker(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "…";
  const room = maxBytes - Buffer.byteLength(marker, "utf8");
  if (room <= 0) return truncate(text, maxBytes).text;
  return `${truncate(text, room).text}${marker}`;
}

/**
 * The answer a failed code search gives the model (dispatch#1451): the search
 * failed, that is an outage and not evidence the code is missing, and what to
 * do instead.
 *
 * It is charged against the budget the caller has left, so a search failure
 * late in a run cannot push the run past its total byte budget. When that
 * budget is tight the upstream summary and the fallback instructions give way
 * first; the outage signal does not, because an answer the model can misread
 * as absence is worse than a short one. The signal is added as whole clauses
 * only, so a tight answer never ends mid-clause.
 */
function buildSearchOutageAnswer(
  summary: string,
  cap: number,
): { content: string; fallbackOffered: boolean } {
  const limit = Math.max(cap, 0);
  const prefix = "search_code failed:";
  const signal = "This is a search outage or timeout, not evidence the code is missing";
  const noRetry = "— repeating the search will not help.";
  const fallback =
    "Finish the investigation with bounded local reads: list_directory the directories " +
    "the issue names, then read_file the specific paths (use startLine/lineCount to reach " +
    "sections of a long file).";
  const join = (parts: string[]) => parts.filter((part) => part.length > 0).join(" ");
  const size = (parts: string[]) => Buffer.byteLength(join(parts), "utf8");

  if (size([prefix, signal]) <= limit) {
    // Room for the full answer: the upstream summary and the fallback
    // instructions are what give way when the budget is tight.
    let remaining = limit - size([prefix, signal]);
    const tail: string[] = [];
    const noRetryCost = 1 + Buffer.byteLength(noRetry, "utf8");
    if (remaining >= noRetryCost) {
      tail.push(noRetry);
      remaining -= noRetryCost;
    }
    const fallbackCost = 1 + Buffer.byteLength(fallback, "utf8");
    if (remaining >= fallbackCost) {
      tail.push(fallback);
      remaining -= fallbackCost;
    }
    // Whatever is left is the upstream summary's, and it is the first to go.
    const summaryRoom = Math.min(200, remaining - 1);
    const shortSummary = summaryRoom > 0 ? cutWithMarker(summary, summaryRoom) : "";
    return {
      content: join([prefix, shortSummary, signal, ...tail]),
      fallbackOffered: tail.includes(fallback),
    };
  }

  // Not enough room for the full answer: whole clauses only, most important
  // first. The word "outage" is the one that must survive — an answer that
  // says neither outage nor absence is worse than a short one (dispatch#1451).
  // When even the prefix does not fit alongside it, the signal is the whole
  // answer and the context gives way: cutting "search_code failed: outage"
  // from the front would leave a prefix fragment that says nothing and could
  // be read as a garbled absence.
  if (size([prefix, "outage"]) <= limit) {
    const parts = [prefix, "outage"];
    for (const clause of ["— not evidence the code is missing", noRetry]) {
      if (size([...parts, clause]) > limit) break;
      parts.push(clause);
    }
    return { content: join(parts), fallbackOffered: false };
  }
  // Whole fallback answers, largest first: the outage signal itself is what
  // must survive, and context (the prefix) only comes back as room remains.
  const candidates = ["search outage", "outage"];
  const best = candidates.find((candidate) => Buffer.byteLength(candidate, "utf8") <= limit);
  return { content: best ?? truncate("outage", limit).text, fallbackOffered: false };
}

/**
 * How much of the model's own query is echoed back in an answer. A query is
 * model-authored and can be arbitrarily long; the answer only needs enough of
 * it to be recognizable.
 */
const MAX_ECHOED_QUERY_BYTES = 200;

/**
 * The answer a successful empty search gives the model (dispatch#1451): the
 * thing is not in the repository.
 *
 * It is the negative-evidence signal — the freshness layer reads a successful
 * search with zero bytes as possible absence (dispatch#1091) — so it is
 * charged as zero bytes. The wording still fits the budget the caller has
 * left: a tight budget shortens the answer instead of overrunning it, and the
 * "no matches" signal survives every budget that can carry it.
 */
function buildNoMatchAnswer(query: string, cap: number): string {
  const limit = Math.max(cap, 0);
  const echo = cutWithMarker(query, MAX_ECHOED_QUERY_BYTES);
  const candidates = [
    `No matches for "${echo}". If you expected this to exist, it may be the thing the issue says is missing.`,
    `No matches for "${echo}".`,
    "No matches.",
  ];
  for (const candidate of candidates) {
    if (Buffer.byteLength(candidate, "utf8") <= limit) return candidate;
  }
  return truncate(candidates[candidates.length - 1], limit).text;
}

/**
 * The answer a read past the end of the file gives (dispatch#1451): the
 * coordinate is beyond the file, so nothing was shown.
 *
 * It is bounded by the budget the caller has left. The "past the end" signal
 * comes first in the fallback ladder, because that is the part the model
 * needs; the path is what gives way when the budget is tight.
 */
function buildPastEndAnswer(
  path: string,
  startLine: number,
  totalLines: number,
  cap: number,
): string {
  const limit = Math.max(cap, 0);
  const signal = `startLine ${startLine} is past the end of the file (${totalLines} line(s))`;
  const candidates = [`${path}: ${signal}.`, `${signal}.`, signal];
  for (const candidate of candidates) {
    if (Buffer.byteLength(candidate, "utf8") <= limit) return candidate;
  }
  return truncate(signal, limit).text;
}

/**
 * The answer a read of something that is not a readable file gives: it is
 * empty or not a file, and the way out is the parent directory. Bounded by
 * the budget the caller has left, like every other answer.
 */
function buildUnreadableFileAnswer(path: string, cap: number): string {
  const limit = Math.max(cap, 0);
  const candidates = [
    `${path} is empty or is not a file. Try list_directory on its parent.`,
    `${path} is empty or not a file.`,
  ];
  for (const candidate of candidates) {
    if (Buffer.byteLength(candidate, "utf8") <= limit) return candidate;
  }
  return truncate(candidates[candidates.length - 1], limit).text;
}

/**
 * The answer a directory listing with nothing in it gives. Bounded by the
 * budget the caller has left, like every other answer.
 */
function buildEmptyDirectoryAnswer(path: string, cap: number): string {
  const limit = Math.max(cap, 0);
  const label = path || "/";
  const candidates = [
    `${label} has no entries, or is a file rather than a directory.`,
    `${label} has no entries.`,
  ];
  for (const candidate of candidates) {
    if (Buffer.byteLength(candidate, "utf8") <= limit) return candidate;
  }
  return truncate(candidates[candidates.length - 1], limit).text;
}

/**
 * The answer a related-work search with no hits gives the model. The echoed
 * query is model-authored and unbounded, so it carries the same clamp the
 * search_code no-match answer applies, and the wording shortens to a fixed
 * signal the budget can still carry (dispatch#1468). Unlike the search_code
 * empty answer this is not the freshness negative-evidence sentinel — nothing
 * keys on a related-work zero-byte answer — so it is charged in full.
 */
function buildNoRelatedWorkAnswer(query: string, cap: number): string {
  const limit = Math.max(cap, 0);
  const echo = cutWithMarker(query, MAX_ECHOED_QUERY_BYTES);
  const candidates = [`No related work found for "${echo}".`, "No related work found."];
  for (const candidate of candidates) {
    if (Buffer.byteLength(candidate, "utf8") <= limit) return candidate;
  }
  return truncate(candidates[candidates.length - 1], limit).text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The fields a reduced related-work answer always keeps (dispatch#1468): the
 * structured identity and state the evidence snapshot records — kind, state,
 * merged, closes — plus the coordinates that name the item. Everything else
 * is prose: shortened first, then dropped, so a tight budget reduces the
 * payload structurally instead of slicing the rendered JSON mid-string.
 */
const RELATED_WORK_AUTHORITATIVE_KEYS = new Set([
  "kind",
  "number",
  "sha",
  "state",
  "merged",
  "closingIssues",
  "closingIssuesTruncated",
  "baseRef",
  "headRef",
  "mergeCommitSha",
  "mergedAt",
  "updatedAt",
  "committedAt",
  "htmlUrl",
  "evidenceKey",
  "source",
]);

/** How much of one prose field survives the shortening rung. */
const MAX_REDUCED_PROSE_BYTES = 200;

/**
 * The rendered JSON of a payload, or null when it does not fit the cap.
 * `JSON.stringify(undefined)` (a deps adapter that resolved no body) renders
 * nothing rather than throwing: the caller treats null as "does not fit".
 */
function jsonWithinCap(value: unknown, cap: number): string | null {
  const text = JSON.stringify(value);
  if (typeof text !== "string") return null;
  return Buffer.byteLength(text, "utf8") <= cap ? text : null;
}

/**
 * Reduce one related-work object to its authoritative fields, with prose
 * either shortened to {@link MAX_REDUCED_PROSE_BYTES} ("shortened") or gone
 * ("omitted"). Comments are counted, not kept: their bodies are the biggest
 * prose in a payload, and the tool descriptions already teach that comment
 * prose is never status. Context like `labels` and `repoFullName` gives way
 * with the prose — the repository is already named by the call, and no
 * snapshot field is derived from those.
 */
function reduceRelatedWorkObject(
  value: Record<string, unknown>,
  prose: "shortened" | "omitted",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "comments") {
      if (Array.isArray(item) && item.length > 0) out.commentsOmitted = item.length;
      continue;
    }
    if (RELATED_WORK_AUTHORITATIVE_KEYS.has(key)) {
      out[key] = item;
      continue;
    }
    if (prose === "shortened" && typeof item === "string" && item) {
      out[key] = cutWithMarker(item, MAX_REDUCED_PROSE_BYTES);
    }
  }
  return out;
}

/**
 * A single related-work read answer bounded by the budget the caller has
 * left (dispatch#1468). The payload is JSON evidence, so the reduction is
 * structural — authoritative fields (kind, state, merged, closes) survive,
 * comments are counted, prose is shortened and then dropped — and every
 * rung stays valid JSON. Returns null when not even the reduced payload
 * fits; the caller then says the budget is spent inside the budget.
 */
function fitRelatedWorkEvidence(
  evidence: unknown,
  cap: number,
): { content: string; reduced: boolean } | null {
  const full = jsonWithinCap(evidence, cap);
  if (full !== null) return { content: full, reduced: false };
  if (!isRecord(evidence)) return null;
  for (const prose of ["shortened", "omitted"] as const) {
    const reduced = reduceRelatedWorkObject(evidence, prose);
    reduced.prose =
      prose === "shortened" ? "shortened for the byte budget" : "omitted for the byte budget";
    const text = jsonWithinCap(reduced, cap);
    if (text !== null) return { content: text, reduced: true };
  }
  return null;
}

/**
 * A related-work hit list bounded by the budget the caller has left
 * (dispatch#1468). The full list first; then the authoritative reduction of
 * every hit; then the hits that fit under a wrapper naming the ones that did
 * not — a cut list must read as a spent budget, never as absence (the same
 * rule search_code's match list follows). Returns null when not even one
 * reduced hit fits alongside the wrapper.
 */
function fitRelatedWorkHits(
  hits: readonly { evidenceKey?: string; kind?: string }[],
  cap: number,
): { content: string; shown: number; reduced: boolean } | null {
  const full = jsonWithinCap(hits, cap);
  if (full !== null) return { content: full, shown: hits.length, reduced: false };
  const reduced = hits.map((hit) =>
    isRecord(hit) ? reduceRelatedWorkObject(hit, "omitted") : hit,
  );
  const all = jsonWithinCap(reduced, cap);
  if (all !== null) return { content: all, shown: hits.length, reduced: true };
  const wrapper = (shown: number) => ({
    hits: reduced.slice(0, shown),
    resultsOmitted: hits.length - shown,
    budget: "byte budget exhausted: more related-work results exist than are shown",
  });
  // The wrapper grows with every hit shown, so the first fit descending from
  // the longest list is the longest list that fits.
  for (let shown = hits.length - 1; shown >= 1; shown -= 1) {
    const text = jsonWithinCap(wrapper(shown), cap);
    if (text !== null) return { content: text, shown, reduced: true };
  }
  return null;
}

/**
 * A list answer (search matches, directory entries) bounded by the budget the
 * caller has left: a header, the entries that fit, and a marker naming what
 * was left out.
 *
 * The whole answer is charged against that budget, so a list the model asked
 * for cannot push the run past its total byte budget (dispatch#1451). The
 * entries that did not fit are named rather than silently dropped, so the
 * model can narrow its own next call instead of believing it saw everything.
 */
interface BoundedListOptions {
  header: string;
  items: string[];
  /** How one entry is rendered on its own line. */
  renderItem: (item: string) => string;
  /** The marker naming the entries that did not fit. */
  omitted: (count: number) => string;
  /** The answer when not even the header fits the budget. */
  exhausted: string;
  cap: number;
  /**
   * How many entries exist in total, when the caller already capped the list
   * by some other rule (the directory-entry cap). The marker then names every
   * entry the model did not see, not just the ones the byte budget dropped.
   */
  total?: number;
}

function renderBoundedList(options: BoundedListOptions): { content: string; shown: string[] } {
  const limit = Math.max(options.cap, 0);
  if (limit === 0) return { content: "", shown: [] };
  const total = options.total ?? options.items.length;

  const assemble = (lines: string[], omittedCount: number): string => {
    const head = lines.length > 0 ? `${options.header}\n${lines.join("\n")}` : options.header;
    return omittedCount > 0 ? `${head}\n${options.omitted(omittedCount)}` : head;
  };

  if (Buffer.byteLength(assemble([], 0), "utf8") > limit) {
    // Not even the header fits: say so inside the budget instead of
    // overrunning it.
    return { content: truncate(options.exhausted, limit).text, shown: [] };
  }

  // Reserve room for the marker, so the answer can say what it left out. The
  // marker for the count actually left out is no longer than this one, so the
  // reservation is safe.
  const reserve = Buffer.byteLength(options.omitted(total), "utf8") + 1;
  const lines: string[] = [];
  const shown: string[] = [];
  let used = Buffer.byteLength(`${options.header}\n`, "utf8");
  for (const item of options.items) {
    const line = options.renderItem(item);
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost + reserve > limit) break;
    lines.push(line);
    shown.push(item);
    used += cost;
  }
  let content = assemble(lines, total - shown.length);
  // The assembled answer is measured exactly: drop an entry if it still does
  // not fit.
  while (Buffer.byteLength(content, "utf8") > limit && lines.length > 0) {
    lines.pop();
    shown.pop();
    content = assemble(lines, total - shown.length);
  }
  if (Buffer.byteLength(content, "utf8") > limit) {
    // Even the header and the marker do not fit together: say the budget is
    // spent instead of overrunning it.
    return { content: truncate(options.exhausted, limit).text, shown: [] };
  }
  return { content, shown };
}

/**
 * Hard cap on the lines one ranged read_file call may return (dispatch#1451).
 * The per-file byte budget still applies and usually cuts earlier; this bounds
 * the request even for files made of many tiny lines.
 */
export const MAX_READ_LINES = 500;

/**
 * Parse a line-range argument: undefined when absent or blank (the model may
 * send ""), null when present but not a positive whole number. Anything that
 * is not a number or a string is rejected rather than silently read as
 * absent — a garbled argument should teach the model, not change behavior.
 */
function asLineNumber(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 1 ? value : null;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * A trailing newline is a line terminator, not an empty final line. One
 * definition of "line" for both the EOF check and the range render.
 */
function fileLines(text: string): string[] {
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

/**
 * A rendered line-range answer: what the model sees, and the verbatim file
 * content it saw. The coordinates header and the continuation footer are
 * rendering, never evidence.
 */
interface LineRangeRender {
  /** Header + body + footer, charged against the caller's byte budget. */
  content: string;
  /** Verbatim file content shown (the #1099 evidence identity). */
  body: string;
  /** Last file line shown. */
  lastShown: number;
  totalLines: number;
  hasMore: boolean;
  /** The requested line count was above the cap and was clamped. */
  clamped: boolean;
  /** The line shown was cut by the byte budget. */
  lineTooLarge: boolean;
  /** Nothing could be shown: the budget could not even carry the framing. */
  budgetExhausted: boolean;
}

/**
 * Render the lines a range covers, charged against `budget` bytes. Lines are
 * whole (never mid-character or mid-line) unless a single line is larger than
 * the whole budget — then it is cut like the head read, and the caller says so
 * in the footer.
 */
function renderRangeBody(
  lines: string[],
  startLine: number,
  count: number,
  budget: number,
): { body: string; lastShown: number; hasMore: boolean; lineTooLarge: boolean } {
  const totalLines = lines.length;
  const bodyLines: string[] = [];
  let usedBytes = 0;
  for (let i = startLine - 1; i < startLine - 1 + count && i < totalLines; i++) {
    const cost = Buffer.byteLength(lines[i], "utf8") + (bodyLines.length > 0 ? 1 : 0);
    if (usedBytes + cost > budget) break;
    bodyLines.push(lines[i]);
    usedBytes += cost;
  }
  if (bodyLines.length === 0) {
    // Not even the first requested line fits the byte budget. Show as much of
    // it as fits (matching the head-read truncation) and continue past it, so
    // a huge single line can never wedge continuation on the same startLine.
    const cut = truncate(lines[startLine - 1] ?? "", Math.max(budget, 0));
    return {
      body: cut.text,
      lastShown: startLine,
      hasMore: cut.truncated || startLine < totalLines,
      lineTooLarge: cut.truncated,
    };
  }
  const lastShown = startLine - 1 + bodyLines.length;
  return {
    body: bodyLines.join("\n"),
    lastShown,
    hasMore: lastShown < totalLines,
    lineTooLarge: false,
  };
}

/** The coordinates header of a ranged read: the path and the lines it covers. */
function rangeHeader(
  path: string,
  startLine: number,
  lastShown: number,
  totalLines: number,
  clamped: boolean,
): string {
  let header = `${path} (lines ${startLine}-${lastShown} of ${totalLines}`;
  if (clamped) header += `, line count capped at ${MAX_READ_LINES}`;
  return `${header}):`;
}

/** The continuation footer of a ranged read: where the next read starts. */
function rangeFooter(
  lastShown: number,
  totalLines: number,
  hasMore: boolean,
  lineTooLarge: boolean,
): string {
  if (lineTooLarge) {
    return lastShown < totalLines
      ? `\n… (line ${lastShown} exceeds the byte limit; continues at line ${lastShown + 1})`
      : `\n… (line ${lastShown} exceeds the byte limit)`;
  }
  if (hasMore) return `\n… continues at line ${lastShown + 1} (pass startLine=${lastShown + 1})`;
  return "\n… end of file";
}

/**
 * Render a bounded line-range slice of a file (dispatch#1451). The request is
 * capped at MAX_READ_LINES lines, lines are whole (never mid-character or
 * mid-line), and the slice carries its coordinates plus a continuation hint so
 * a known path can be finished reading instead of only ever showing its head.
 *
 * The whole answer — coordinates header, content and continuation footer — is
 * charged against `totalCap` bytes, not just the content: exploration passes
 * its *remaining* total budget as that cap, so an answer that added its
 * framing after the content was charged would push the run past the budget it
 * was given. `bodyCap` separately bounds the file content shown.
 *
 * The returned `body` is verbatim file content — the header and footer are
 * rendering, not evidence — so close-excerpt grounding (#1099) keeps working.
 */
function renderLineRange(
  path: string,
  text: string,
  startLine: number,
  lineCount: number,
  bodyCap: number,
  totalCap: number,
): LineRangeRender {
  const lines = fileLines(text);
  const totalLines = lines.length;
  // The advertised cap is a real cap: a model asking for more lines than the
  // cap allows gets MAX_READ_LINES of them, and the header says so.
  const count = Math.min(lineCount, MAX_READ_LINES);
  const clamped = lineCount > MAX_READ_LINES;

  let budget = Math.min(bodyCap, totalCap);
  let rendered = renderRangeBody(lines, startLine, count, budget);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const header = rangeHeader(path, startLine, rendered.lastShown, totalLines, clamped);
    const footer = rangeFooter(
      rendered.lastShown,
      totalLines,
      rendered.hasMore,
      rendered.lineTooLarge,
    );
    const framingBytes =
      Buffer.byteLength(header, "utf8") + Buffer.byteLength(footer, "utf8");
    const used = framingBytes + 1 + Buffer.byteLength(rendered.body, "utf8");
    if (used <= totalCap) {
      return {
        content: `${header}\n${rendered.body}${footer}`,
        body: rendered.body,
        lastShown: rendered.lastShown,
        totalLines,
        hasMore: rendered.hasMore,
        clamped,
        lineTooLarge: rendered.lineTooLarge,
        budgetExhausted: false,
      };
    }
    // The framing does not fit alongside the content: give the content the
    // room the framing leaves and render again. That room is strictly
    // smaller than the content it replaces, so the content shrinks and the
    // loop converges (the content is cut on line boundaries, so it drops a
    // whole line at a time).
    const room = totalCap - framingBytes - 1;
    if (room <= 0) break;
    budget = Math.min(budget, room);
    rendered = renderRangeBody(lines, startLine, count, budget);
  }
  // Even the framing alone does not fit the budget: say so inside the budget
  // instead of overrunning it. Nothing was shown, so no path is claimed read.
  const note = truncate(
    `byte budget exhausted: ${path} lines ${startLine}+ of ${totalLines} not shown; stop reading this file.`,
    Math.max(totalCap, 0),
  );
  return {
    content: note.text,
    body: "",
    lastShown: startLine - 1,
    totalLines,
    hasMore: true,
    clamped,
    lineTooLarge: false,
    budgetExhausted: true,
  };
}

/**
 * Paths come from the model, so they can be anything. These are read through
 * GitHub's repo-scoped contents API rather than a filesystem, and the tools may
 * already read any file in the repo, so a `..` segment crosses no privilege
 * boundary — it just produces a 404. Rejecting these up front turns a wasted
 * round trip into an immediate, readable error the model can act on.
 */
export function normalizeRepoPath(raw: string): { path: string } | { error: string } {
  const path = raw.trim();
  if (/[\u0000-\u001F\u007F]/.test(path)) {
    return { error: "Path contains control characters. Use a plain path from the repository root." };
  }
  if (path.startsWith("/")) {
    return { error: `Path "${path}" is absolute. Use a path relative to the repository root, e.g. src/lib/prisma.ts.` };
  }
  const segments = path.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (segments.includes("..")) {
    return { error: `Path "${path}" contains "..". Use a direct path from the repository root.` };
  }
  return { path: segments.join("/") };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const s = asString(value).trim();
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

/**
 * Shared shape for the read_related_* tools: one bounded fetch, the result
 * rendered as compact JSON, and conservative degradation on failure. A 404 is
 * an answer, not an error; anything else is a warning plus an empty result,
 * so a flaky lookup never ends the grooming run.
 */
function toRelatedWorkObservation(
  value: unknown,
  fallbackKind: RelatedWorkObservation["kind"],
  via: RelatedWorkObservation["via"],
): RelatedWorkObservation | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.evidenceKey !== "string" || !v.evidenceKey) return null;
  const kind =
    v.kind === "issue" || v.kind === "pull_request" || v.kind === "commit" ? v.kind : fallbackKind;
  const state =
    kind !== "commit" && (v.state === "open" || v.state === "closed" || v.state === "merged")
      ? v.state
      : null;
  const closes = Array.isArray(v.closingIssues)
    ? v.closingIssues.filter((key): key is string => typeof key === "string")
    : undefined;
  return {
    key: v.evidenceKey,
    kind,
    state,
    url: typeof v.htmlUrl === "string" && v.htmlUrl ? v.htmlUrl : null,
    via,
    observedAt: new Date().toISOString(),
    ...(kind === "pull_request" && via === "read" && closes !== undefined ? { closes } : {}),
    ...(kind === "pull_request" && via === "read" && typeof v.baseRef === "string" ? { baseRef: v.baseRef } : {}),
  };
}

/** Closing references fetched per merged PR read; bounded like the other related-work reads. */
const MAX_CLOSING_ISSUES = 10;

/**
 * Add GitHub's closing references to a merged PR read (dispatch#1099), so
 * the plan and its history show whether the PR closes THIS issue or another
 * one. It corroborates an already_done close; it never satisfies one. Only
 * merged PRs need it, so an open or closed PR costs no extra call. A failed lookup leaves the references unknown (never "none") and
 * warns; the PR read itself still succeeds.
 */
async function withClosingIssues(
  evidence: unknown,
  repoFullName: string,
  deps: GroomerToolDeps,
): Promise<{ evidence: unknown; warnings: string[] }> {
  const pr = evidence as { kind?: unknown; state?: unknown; number?: unknown } | null;
  if (!pr || pr.kind !== "pull_request" || pr.state !== "merged" || typeof pr.number !== "number") {
    return { evidence, warnings: [] };
  }
  try {
    const closing = await deps.fetchPullRequestClosingIssues(repoFullName, pr.number, { maxResults: MAX_CLOSING_ISSUES });
    return {
      evidence: { ...(evidence as object), closingIssues: closing.issues, closingIssuesTruncated: closing.truncated },
      warnings: [],
    };
  } catch {
    return { evidence, warnings: [`related-work: closing references lookup failed for ${repoFullName}#${pr.number}`] };
  }
}

/** Commit refs the model may pass: a SHA, tag, or branch name, bounded. */
const COMMIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_COMMIT_REF_LENGTH = 100;

async function runRelatedWorkLookup(
  kind: RelatedWorkObservation["kind"],
  invoke: () => Promise<unknown>,
  enrich:
    | ((evidence: unknown) => Promise<{ evidence: unknown; warnings: string[] }>)
    | undefined,
  /** The budget the caller has left; every answer is charged inside it (dispatch#1468). */
  totalCap: number,
): Promise<GroomerToolResult> {
  try {
    const read = await invoke();
    const { evidence, warnings } = enrich ? await enrich(read) : { evidence: read, warnings: [] };
    const fitted = fitRelatedWorkEvidence(evidence, totalCap);
    if (fitted === null) {
      // Not even the authoritative reduction fits: the lookup succeeded, but
      // showing nothing establishes nothing, so no observation is recorded —
      // the same rule a budget-exhausted read_file follows. The answer still
      // says so inside the budget instead of overrunning it.
      const content = truncate(
        "byte budget exhausted: the related-work evidence was not shown.",
        Math.max(totalCap, 0),
      ).text;
      return {
        ok: true,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        sources: [],
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    const content = fitted.content;
    const observation = toRelatedWorkObservation(evidence, kind, "read");
    return {
      ok: true,
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      sources: [],
      relatedWork: observation ? [observation] : [],
      // A reduced payload is a clipped answer: the model saw a prefix of the
      // evidence, not the whole of it (#1452's fact, dispatch#1468).
      ...(fitted.reduced ? { truncated: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    if (err instanceof RelatedWorkNotFoundError) {
      // A 404 is an answer, so it stays valid JSON while it can; the
      // identity-bearing fields give way in order as the budget tightens
      // (dispatch#1468).
      const content =
        jsonWithinCap({ found: false, kind: err.kind, ref: err.ref }, totalCap) ??
        jsonWithinCap({ found: false, kind: err.kind }, totalCap) ??
        jsonWithinCap({ found: false }, totalCap) ??
        truncate("not found", Math.max(totalCap, 0)).text;
      return {
        ok: true,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        sources: [],
        warnings: [`related-work: not found ${err.kind} ${err.ref}`],
      };
    }
    const content =
      jsonWithinCap({ error: true }, totalCap) ??
      truncate("lookup failed", Math.max(totalCap, 0)).text;
    return {
      ok: false,
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      sources: [],
      warnings: [`related-work: ${kind} lookup failed`],
    };
  }
}

export interface ExecuteToolOptions {
  repoFullName: string;
  maxSearchResults: number;
  /** Cap on the file content one read may show. */
  maxFileBytes: number;
  /**
   * Cap on the whole answer one call may return, framing included. Exploration
   * passes the budget it has left here, so an answer that added its framing
   * after the content was charged cannot push the run past that budget
   * (dispatch#1451). Defaults to maxFileBytes when not given.
   */
  maxTotalBytesRemaining?: number;
  maxDirEntries: number;
  /**
   * When set, every read_file / list_directory read is forced to this ref
   * (the snapshot SHA captured at the start of the grooming run) and any
   * model-supplied `ref` is ignored.
   */
  pinnedRef?: string;
}

/**
 * Run one tool call. Never throws: a failed call comes back as an `ok: false`
 * result so the model can read the error and try something else, rather than
 * ending the grooming run. A groomer that dies because it guessed a bad path
 * is worse than one that is told the path was bad.
 */
export async function executeGroomerTool(
  call: GroomerToolCall,
  options: ExecuteToolOptions,
  deps: GroomerToolDeps = defaultGroomerToolDeps,
): Promise<GroomerToolResult> {
  // The budget this call may answer within: what the caller has left of its
  // total. Every answer — content included, framing and fallback alike — is
  // charged against it, so no answer can push the caller past that budget
  // (dispatch#1451).
  const totalCap = Math.max(options.maxTotalBytesRemaining ?? options.maxFileBytes, 0);
  const fail = (message: string): GroomerToolResult => {
    const text = cutWithMarker(message, totalCap);
    return {
      ok: false,
      content: text,
      bytes: Buffer.byteLength(text, "utf8"),
      sources: [],
    };
  };

  try {
    switch (call.name) {
      case "search_code": {
        const query = asString(call.arguments.query).trim();
        if (!query) return fail("search_code needs a non-empty query.");
        let results: { path: string }[];
        try {
          results = await deps.searchCode(options.repoFullName, query, options.maxSearchResults);
        } catch (err) {
          // A failed or timed-out search is an outage, not absence (dispatch#1451):
          // the model must not read it as "the code is missing", and blindly
          // retrying global search burns the round budget. Offer the bounded
          // fallback instead: named paths and directory listings through the
          // existing read capability, which stays under the same byte budgets.
          // Upstream bodies can be a full HTML page; collapse to one short
          // line under the same 200-byte fence summarizeErrorBody puts on
          // upstream bodies in github-code-search: the fence is bytes, not
          // characters, so a body of multi-byte characters cannot carry more
          // bytes than the fence allows.
          //
          // The whole answer is charged against the budget the caller has
          // left, so a search failure late in a run cannot push that run past
          // its total byte budget (dispatch#1451).
          const summary = truncate(
            (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim(),
            200,
          ).text;
          const content = buildSearchOutageAnswer(summary, totalCap);
          return {
            ok: false,
            content: content.content,
            bytes: Buffer.byteLength(content.content, "utf8"),
            sources: [],
            warnings: [
              content.fallbackOffered
                ? "search_code unavailable; offered bounded directory/file fallback"
                : "search_code unavailable; byte budget left no room for the fallback",
            ],
          };
        }
        if (results.length === 0) {
          const content = buildNoMatchAnswer(query, totalCap);
          return {
            ok: true,
            content,
            // The negative-evidence signal: the freshness layer reads a
            // successful search with zero bytes as possible absence
            // (dispatch#1091), so this answer carries no evidence bytes. It
            // is still bounded by the budget the caller has left. That bound
            // is enforced through `chargedBytes` (dispatch#1451): the run
            // pays for the answer it was shown, and the freshness layer
            // keeps reading this call as `bytes === 0`.
            bytes: 0,
            chargedBytes: Buffer.byteLength(content, "utf8"),
            sources: [],
          };
        }
        // A successful search is charged against the budget the caller has
        // left, like every other answer (dispatch#1451): a long match list
        // late in a run must not push the run past its total byte budget.
        const paths = results.map((r) => r.path).filter(Boolean);
        const list = renderBoundedList({
          header: `Matches for "${cutWithMarker(query, MAX_ECHOED_QUERY_BYTES)}":`,
          items: paths,
          renderItem: (path) => `- ${path}`,
          // The matches that did not fit are named, and the reason is named
          // too: the model must read the cut as a spent budget, never as
          // absence.
          omitted: (count) =>
            `… ${count} match${count === 1 ? "" : "es"} not shown (byte budget exhausted)`,
          exhausted: "byte budget exhausted: the search results were not shown; stop searching.",
          cap: totalCap,
        });
        if (!list.content) {
          // No budget left to answer with. The call did not deliver, so it is
          // not an absence: a successful search that found matches must never
          // read as the negative-evidence signature (`ok && bytes === 0`).
          return { ok: false, content: "", bytes: 0, sources: [] };
        }
        return {
          ok: true,
          content: list.content,
          bytes: Buffer.byteLength(list.content, "utf8"),
          // Only the paths the model actually saw are surfaced: a path the
          // answer left out was never shown to anyone.
          sources: list.shown,
        };
      }

      case "read_file": {
        const raw = asString(call.arguments.path).trim();
        if (!raw) return fail("read_file needs a non-empty path.");
        const normalized = normalizeRepoPath(raw);
        if ("error" in normalized) return fail(normalized.error);
        const path = normalized.path;
        if (!path) return fail("read_file needs a non-empty path.");
        const startLineArg = asLineNumber(call.arguments.startLine);
        if (startLineArg === null) {
          return fail("read_file startLine must be a whole number ≥ 1.");
        }
        const lineCountArg = asLineNumber(call.arguments.lineCount);
        if (lineCountArg === null) {
          return fail("read_file lineCount must be a whole number ≥ 1.");
        }
        const ref = options.pinnedRef ?? (asString(call.arguments.ref).trim() || undefined);
        const text = await deps.readFile(options.repoFullName, path, ref);
        if (!text) {
          // The answer names the path and the way out, so it is model-visible
          // content and is charged against the budget the caller has left
          // like every other answer (dispatch#1451): repeated reads of empty
          // files must consume the run's budget, not emit for free.
          const content = buildUnreadableFileAnswer(path, totalCap);
          return {
            ok: true,
            content,
            bytes: Buffer.byteLength(content, "utf8"),
            sources: [],
          };
        }
        // Bounded range read (dispatch#1451): line coordinates, continuation
        // metadata, and verbatim content for the evidence identity. Without
        // range arguments the call behaves exactly as before.
        //
        // Budgets: the file content shown is capped by maxFileBytes, and the
        // whole answer — header and footer included — by the budget the caller
        // has left (totalCap). Exploration passes that remainder as
        // maxTotalBytesRemaining; without it the file cap is the only bound.
        if (startLineArg !== undefined || lineCountArg !== undefined) {
          const startLine = startLineArg ?? 1;
          const totalLines = fileLines(text).length;
          if (startLine > totalLines) {
            // Nothing was shown, so the path is not reported as read: an
            // answered coordinate is not fetch evidence. The answer is still
            // charged against the budget the caller has left (dispatch#1451):
            // a path can be long, and the answer must not overrun the budget.
            const content = buildPastEndAnswer(path, startLine, totalLines, totalCap);
            return {
              ok: true,
              content,
              bytes: Buffer.byteLength(content, "utf8"),
              sources: [],
            };
          }
          const range = renderLineRange(
            path,
            text,
            startLine,
            lineCountArg ?? MAX_READ_LINES,
            options.maxFileBytes,
            totalCap,
          );
          if (range.budgetExhausted) {
            // The budget could not carry the framing, so nothing was shown:
            // no path is claimed read and no evidence is recorded.
            return {
              ok: true,
              content: range.content,
              bytes: Buffer.byteLength(range.content, "utf8"),
              sources: [],
            };
          }
          return {
            ok: true,
            content: range.content,
            bytes: Buffer.byteLength(range.content, "utf8"),
            sources: [path],
            file: { path, ref: ref ?? null, content: range.body },
            // A range that stops short of EOF is a truncated read too
            // (dispatch#1452): the footer names the continuation, and if the
            // model never takes it the gap fact must stand. A range that
            // reaches EOF ("end of file") leaves the fact unset, so a
            // completed continuation can retire an earlier truncation.
            truncated: range.hasMore || undefined,
            // A range that reached EOF showed the requested tail whole: the
            // run established what the file holds from there on (and the
            // head was already read for the model to be here), so an
            // earlier truncation fact may retire.
            established: !range.hasMore,
            // The coordinates the answer showed, so retirement can check it
            // continued from what the run had already shown (dispatch#1451).
            shownRange: {
              start: startLine,
              end: range.lastShown,
              totalLines: range.totalLines,
              eof: !range.hasMore,
            },
          };
        }
        // Head read: the path prefix and the continuation marker are charged
        // to the same budget as the content, so the whole answer stays inside
        // what the caller allowed (dispatch#1451).
        const prefix = `${path}:\n`;
        const prefixBytes = Buffer.byteLength(prefix, "utf8");
        const headCap = Math.min(options.maxFileBytes, totalCap - prefixBytes);
        if (headCap <= 0) {
          const note = truncate(
            `byte budget exhausted: ${path} not shown; stop reading this file.`,
            Math.max(totalCap, 0),
          );
          return {
            ok: true,
            content: note.text,
            bytes: Buffer.byteLength(note.text, "utf8"),
            sources: [],
          };
        }
        const { text: body, truncated } = truncate(text, headCap);
        if (!truncated) {
          const content = `${prefix}${body}`;
          const totalLines = fileLines(text).length;
          return {
            ok: true,
            content,
            bytes: Buffer.byteLength(content, "utf8"),
            sources: [path],
            file: { path, ref: ref ?? null, content: body },
            truncated: false,
            // The whole file was shown: the run established what it holds.
            established: true,
            shownRange: { start: 1, end: totalLines, totalLines, eof: true },
          };
        }
        // The truncation marker names the line to continue from, so a known
        // path can be finished reading instead of only ever showing its head
        // (dispatch#1451). Substring "(truncated)" stays for existing readers.
        // The cut usually lands mid-line; naming the line it landed in (not
        // the next one) means a ranged continuation re-reads that line whole.
        // A cut inside the first line is the exception: that line will never
        // fit the byte cap whole, so the marker names the limit and advances
        // past it — matching the ranged footer — instead of sending the
        // continuation back over the same oversized line. A continuation
        // always advances and never wedges.
        // Reserve room for the marker so it does not push the answer past the
        // budget the caller allowed; the "exceeds the byte limit" wording is
        // the longest shape, so reserving for it covers every marker.
        const totalLines = fileLines(text).length;
        const markerAllowance = Buffer.byteLength(
          `\n… (truncated) line 1 exceeds the byte limit; call again with startLine=${"9".repeat(
            String(totalLines).length,
          )}`,
          "utf8",
        );
        const truncatedCap = Math.min(
          options.maxFileBytes,
          totalCap - prefixBytes - markerAllowance,
        );
        if (truncatedCap <= 0) {
          const note = truncate(
            `byte budget exhausted: ${path} not shown; stop reading this file.`,
            Math.max(totalCap, 0),
          );
          return {
            ok: true,
            content: note.text,
            bytes: Buffer.byteLength(note.text, "utf8"),
            sources: [],
          };
        }
        const cut = truncate(text, truncatedCap).text;
        const shownLines = cut.split("\n").length;
        const firstLine = fileLines(text)[0] ?? "";
        const firstLineBytes = Buffer.byteLength(firstLine, "utf8");
        const marker =
          shownLines > 1
            ? `\n… (truncated) to continue, call again with startLine=${shownLines}`
            : Buffer.byteLength(cut, "utf8") < firstLineBytes
              ? totalLines > 1
                ? `\n… (truncated) line 1 exceeds the byte limit; call again with startLine=2`
                : `\n… (truncated) line 1 exceeds the byte limit; no further lines`
              : totalLines > 1
                ? `\n… (truncated) to continue, call again with startLine=2`
                : `\n… (truncated) no further lines`;
        const content = `${prefix}${cut}${marker}`;
        // Line 1-based accounting of what the cut actually showed whole
        // (dispatch#1451): a cut that fell on a newline shows the lines before
        // it whole and the split's empty tail is not a line; a partial last
        // line was not shown whole. A cut inside an oversized line 1 exceeds
        // every budget this run has, and the past-it continuation
        // (startLine=2) must stay continuous.
        const shownEnd =
          cut === firstLine
            ? 1
            : cut.includes("\n")
              ? cut.split("\n").length - 1
              : 1;
        return {
          ok: true,
          content,
          bytes: Buffer.byteLength(content, "utf8"),
          sources: [path],
          file: { path, ref: ref ?? null, content: cut },
          // Genuinely cut by the byte cap: the head the model saw is not the
          // whole file (dispatch#1452), and a continuation read can retire
          // the fact later.
          truncated,
          shownRange: { start: 1, end: shownEnd, totalLines, eof: false },
        };
      }

      case "list_directory": {
        const normalized = normalizeRepoPath(asString(call.arguments.path));
        if ("error" in normalized) return fail(normalized.error);
        const path = normalized.path;
        const ref = options.pinnedRef ?? (asString(call.arguments.ref).trim() || undefined);
        const entries = await deps.listDir(options.repoFullName, path, ref);
        if (entries.length === 0) {
          // Same as an empty file: the answer is model-visible content and is
          // charged against the budget the caller has left (dispatch#1451).
          const content = buildEmptyDirectoryAnswer(path, totalCap);
          return {
            ok: true,
            content,
            bytes: Buffer.byteLength(content, "utf8"),
            sources: [],
          };
        }
        // A listing is charged against the budget the caller has left, like
        // every other answer (dispatch#1451): a directory of long paths must
        // not push the run past its total byte budget. The entries that did
        // not fit are named, so the model knows the list was cut.
        const dirTypes = new Map(entries.map((entry) => [entry.path, entry.type]));
        const list = renderBoundedList({
          header: `${path || "/"}:`,
          items: entries.slice(0, options.maxDirEntries).map((entry) => entry.path),
          renderItem: (entryPath) => `- ${entryPath}${dirTypes.get(entryPath) === "dir" ? "/" : ""}`,
          omitted: (count) => `… ${count} more`,
          exhausted: "byte budget exhausted: the directory listing was not shown; stop listing.",
          cap: totalCap,
          total: entries.length,
        });
        return {
          ok: true,
          content: list.content,
          bytes: Buffer.byteLength(list.content, "utf8"),
          sources: [],
          // The listing was clipped whenever the model did not see every
          // entry — by the entry cap or by the byte budget (dispatch#1452).
          truncated: list.shown.length < entries.length,
          // A listing that showed every entry of a non-empty directory
          // established what it holds. The empty-directory answer showed no
          // entries, so it claims nothing (dispatch#1451 review).
          established: entries.length > 0 && list.shown.length === entries.length,
        };
      }

      case "search_related_work": {
        const query = asString(call.arguments.query).trim();
        if (!query) return fail("search_related_work needs a non-empty query.");
        const typeRaw = asString(call.arguments.type).trim();
        const stateRaw = asString(call.arguments.state).trim();
        const type: "issue" | "pr" | "all" =
          typeRaw === "issue" || typeRaw === "pr" || typeRaw === "all" ? typeRaw : "all";
        const state: "open" | "closed" | "all" =
          stateRaw === "open" || stateRaw === "closed" || stateRaw === "all" ? stateRaw : "all";
        let hits;
        try {
          hits = await deps.searchRelatedWork(options.repoFullName, query, {
            type,
            state,
            maxResults: options.maxSearchResults,
          });
        } catch {
          // Upstream error bodies (fetchPaginated) can be a full HTML page and may
          // contain non-repo text; never surface them to the model or the persisted
          // preview. Degrade to a generic, bounded hint instead.
          return fail(
            "search_related_work failed: upstream search is unavailable right now. Try a narrower repo-scoped query or an explicit #issue/PR reference.",
          );
        }
        if (hits.length === 0) {
          // Bounded by the budget the caller has left and charged in full
          // (dispatch#1468): the model sees this answer, so it spends the
          // run's budget; only search_code's empty answer is the zero-byte
          // negative-evidence sentinel.
          const content = buildNoRelatedWorkAnswer(query, totalCap);
          return {
            ok: true,
            content,
            bytes: Buffer.byteLength(content, "utf8"),
            sources: [],
          };
        }
        // The hit list is JSON evidence, so a tight budget reduces it
        // structurally (authoritative fields first, prose and whole hits
        // after, under a marker naming what was cut) instead of pushing the
        // run past the budget the caller passed (dispatch#1468).
        const fitted = fitRelatedWorkHits(hits, totalCap);
        if (fitted === null) {
          // The search found work but not one result fits the budget left.
          // The answer says so inside the budget — like a cut search_code
          // list, a successful search that found matches must never read as
          // absence, and it never takes the `ok && bytes === 0` signature.
          const content = truncate(
            "byte budget exhausted: related work was found but no result fit the budget. More results exist — this is not an absence.",
            totalCap,
          ).text;
          return {
            ok: false,
            content,
            bytes: Buffer.byteLength(content, "utf8"),
            sources: [],
          };
        }
        // Only the hits the model actually saw are recorded: an answer that
        // left a result out establishes nothing about it (the rule search_code
        // sources already follow, dispatch#1451/#1468).
        const relatedWork = hits
          .slice(0, fitted.shown)
          .map((hit) =>
            toRelatedWorkObservation(hit, hit.kind === "pull_request" ? "pull_request" : "issue", "search"),
          )
          .filter((observation): observation is RelatedWorkObservation => observation !== null);
        return {
          ok: true,
          content: fitted.content,
          bytes: Buffer.byteLength(fitted.content, "utf8"),
          sources: [],
          relatedWork,
          // The list was cut or its hits reduced: the model saw a prefix
          // (dispatch#1468).
          ...(fitted.reduced ? { truncated: true } : {}),
        };
      }

      case "read_related_issue": {
        const number = asNumber(call.arguments.number);
        if (!number) return fail("read_related_issue needs a positive integer issue number.");
        return runRelatedWorkLookup(
          "issue",
          () => deps.fetchRelatedIssue(options.repoFullName, number),
          (evidence) => withClosingIssues(evidence, options.repoFullName, deps),
          totalCap,
        );
      }

      case "read_related_pr": {
        const number = asNumber(call.arguments.number);
        if (!number) return fail("read_related_pr needs a positive integer pull request number.");
        return runRelatedWorkLookup(
          "pull_request",
          () => deps.fetchRelatedPullRequest(options.repoFullName, number),
          (evidence) => withClosingIssues(evidence, options.repoFullName, deps),
          totalCap,
        );
      }

      case "read_related_commit": {
        const ref = asString(call.arguments.ref).trim();
        if (!ref) return fail("read_related_commit needs a non-empty commit SHA.");
        if (ref.length > MAX_COMMIT_REF_LENGTH || !COMMIT_REF_PATTERN.test(ref) || ref.includes("..")) {
          return fail("read_related_commit needs a commit SHA (or tag/branch name) of letters, digits, '.', '_', '/', '-'.");
        }
        return runRelatedWorkLookup(
          "commit",
          () => deps.fetchRelatedCommit(options.repoFullName, ref),
          undefined,
          totalCap,
        );
      }

      default:
        return fail(
          `Unknown tool "${call.name}". Available: ${GROOMER_TOOL_NAMES.join(", ")}.`,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`${call.name} failed: ${message}`);
  }
}
