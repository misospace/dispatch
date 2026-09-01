// Imported from the concrete module rather than the "@/lib/github" barrel:
// suites that partially mock the barrel would otherwise leave these undefined
// at module load and fail before any test runs.
import {
  fetchRepositoryFileText as defaultFetchFile,
  listRepositoryDirectory as defaultListDir,
  searchRepositoryCode as defaultSearchCode,
} from "@/lib/github-code-search";

/**
 * Read-only repository tools the groomer drives itself.
 *
 * Grooming used to receive one pre-computed briefing assembled from three
 * keyword searches picked by word order, which meant it could never open a
 * file it had not been handed. These tools let it look, then look again based
 * on what it found. Nothing here writes: the groomer reads the repository and
 * reports, and every mutation still goes through the existing run pipeline.
 */

export const GROOMER_TOOL_NAMES = [
  "search_code",
  "read_file",
  "list_directory",
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
}

export interface GroomerToolDeps {
  searchCode: (repoFullName: string, query: string, limit: number) => Promise<{ path: string }[]>;
  readFile: (repoFullName: string, path: string, ref?: string) => Promise<string>;
  listDir: (
    repoFullName: string,
    path: string,
    ref?: string,
  ) => Promise<{ path: string; type: "file" | "dir"; size: number | null }[]>;
}

export const defaultGroomerToolDeps: GroomerToolDeps = {
  searchCode: defaultSearchCode,
  readFile: defaultFetchFile,
  listDir: defaultListDir,
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
          "e.g. src/lib/prisma.ts. Long files are truncated.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", description: "Path from the repository root" },
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

export interface ExecuteToolOptions {
  repoFullName: string;
  maxSearchResults: number;
  maxFileBytes: number;
  maxDirEntries: number;
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
        const text = await deps.readFile(options.repoFullName, path);
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
        const entries = await deps.listDir(options.repoFullName, path);
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
