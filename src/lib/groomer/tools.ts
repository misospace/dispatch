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
  fetchRelatedPullRequest,
  searchRelatedWork,
  RelatedWorkNotFoundError,
} from "@/lib/github-related-work";

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
  /** Bytes charged against the exploration budget. */
  bytes: number;
  /** Repo paths this call surfaced, for the run's source list. */
  sources: string[];
  /** Warnings to surface on the exploration result, e.g. a failed lookup. */
  warnings?: string[];
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
}

export const defaultGroomerToolDeps: GroomerToolDeps = {
  searchCode: defaultSearchCode,
  readFile: defaultFetchFile,
  listDir: defaultListDir,
  fetchRelatedIssue,
  fetchRelatedPullRequest,
  fetchRelatedCommit,
  searchRelatedWork,
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
          "e.g. src/lib/prisma.ts. Long files are truncated. Pass `ref` to read " +
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
          "structured, authoritative evidence — do not infer status from prose.",
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
async function runRelatedWorkLookup(
  kind: string,
  invoke: () => Promise<unknown>,
): Promise<GroomerToolResult> {
  try {
    const evidence = await invoke();
    const content = JSON.stringify(evidence);
    const key =
      evidence &&
      typeof evidence === "object" &&
      typeof (evidence as { evidenceKey?: unknown }).evidenceKey === "string"
        ? (evidence as { evidenceKey: string }).evidenceKey
        : "";
    return {
      ok: true,
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      sources: key ? [key] : [],
    };
  } catch (err) {
    if (err instanceof RelatedWorkNotFoundError) {
      const content = JSON.stringify({ found: false, kind: err.kind, ref: err.ref });
      return {
        ok: true,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        sources: [],
        warnings: [`related-work: not found ${err.kind} ${err.ref}`],
      };
    }
    const content = JSON.stringify({ error: true });
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
  maxFileBytes: number;
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
  const fail = (message: string): GroomerToolResult => ({
    ok: false,
    content: message,
    bytes: Buffer.byteLength(message, "utf8"),
    sources: [],
  });

  try {
    switch (call.name) {
      case "search_code": {
        const query = asString(call.arguments.query).trim();
        if (!query) return fail("search_code needs a non-empty query.");
        const results = await deps.searchCode(options.repoFullName, query, options.maxSearchResults);
        if (results.length === 0) {
          return {
            ok: true,
            content: `No matches for "${query}". If you expected this to exist, it may be the thing the issue says is missing.`,
            bytes: 0,
            sources: [],
          };
        }
        const paths = results.map((r) => r.path).filter(Boolean);
        const content = `Matches for "${query}":\n${paths.map((p) => `- ${p}`).join("\n")}`;
        return { ok: true, content, bytes: Buffer.byteLength(content, "utf8"), sources: paths };
      }

      case "read_file": {
        const raw = asString(call.arguments.path).trim();
        if (!raw) return fail("read_file needs a non-empty path.");
        const normalized = normalizeRepoPath(raw);
        if ("error" in normalized) return fail(normalized.error);
        const path = normalized.path;
        if (!path) return fail("read_file needs a non-empty path.");
        const ref = options.pinnedRef ?? (asString(call.arguments.ref).trim() || undefined);
        const text = await deps.readFile(options.repoFullName, path, ref);
        if (!text) {
          return {
            ok: true,
            content: `${path} is empty or is not a file. Try list_directory on its parent.`,
            bytes: 0,
            sources: [],
          };
        }
        const { text: body, truncated } = truncate(text, options.maxFileBytes);
        const content = `${path}:\n${body}${truncated ? "\n… (truncated)" : ""}`;
        return { ok: true, content, bytes: Buffer.byteLength(content, "utf8"), sources: [path] };
      }

      case "list_directory": {
        const normalized = normalizeRepoPath(asString(call.arguments.path));
        if ("error" in normalized) return fail(normalized.error);
        const path = normalized.path;
        const ref = options.pinnedRef ?? (asString(call.arguments.ref).trim() || undefined);
        const entries = await deps.listDir(options.repoFullName, path, ref);
        if (entries.length === 0) {
          return {
            ok: true,
            content: `${path || "/"} has no entries, or is a file rather than a directory.`,
            bytes: 0,
            sources: [],
          };
        }
        const shown = entries.slice(0, options.maxDirEntries);
        const lines = shown.map((e) => `- ${e.path}${e.type === "dir" ? "/" : ""}`);
        const more = entries.length > shown.length ? `\n… ${entries.length - shown.length} more` : "";
        const content = `${path || "/"}:\n${lines.join("\n")}${more}`;
        return { ok: true, content, bytes: Buffer.byteLength(content, "utf8"), sources: [] };
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
          return {
            ok: true,
            content: `No related work found for "${query}".`,
            bytes: 0,
            sources: [],
          };
        }
        const content = JSON.stringify(hits);
        const sources = hits.map((h) => h.evidenceKey).filter(Boolean);
        return { ok: true, content, bytes: Buffer.byteLength(content, "utf8"), sources };
      }

      case "read_related_issue": {
        const number = asNumber(call.arguments.number);
        if (!number) return fail("read_related_issue needs a positive integer issue number.");
        return runRelatedWorkLookup("issue", () =>
          deps.fetchRelatedIssue(options.repoFullName, number),
        );
      }

      case "read_related_pr": {
        const number = asNumber(call.arguments.number);
        if (!number) return fail("read_related_pr needs a positive integer pull request number.");
        return runRelatedWorkLookup("pr", () =>
          deps.fetchRelatedPullRequest(options.repoFullName, number),
        );
      }

      case "read_related_commit": {
        const ref = asString(call.arguments.ref).trim();
        if (!ref) return fail("read_related_commit needs a non-empty commit SHA.");
        return runRelatedWorkLookup("commit", () =>
          deps.fetchRelatedCommit(options.repoFullName, ref),
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
