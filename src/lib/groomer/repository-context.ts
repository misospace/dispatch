import type {
  GitHubCodeSearchResult,
  GitHubRepoMetadata,
} from "@/lib/github";
import { fetchRepositoryMetadata as defaultFetchRepo } from "@/lib/github";
import { searchRepositoryCode as defaultSearchCode } from "@/lib/github";
import { fetchRepositoryFileText as defaultFetchFile } from "@/lib/github";

export interface RepositoryContextInput {
  repoFullName: string;
  issueTitle: string;
  issueBody: string | null;
}

export interface RepositoryContextConfig {
  enabled: boolean;
  maxSearches: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface RepositoryContextResult {
  text: string;
  sources: string[];
  warnings: string[];
  bytes: number;
  queries: string[];
}

/** Default extensions considered text-like for repository context. */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".prisma",
  ".css",
]);

/** Common English stop words to filter from search terms. */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by",
  "for", "from", "had", "has", "have", "her", "his", "how",
  "i", "if", "in", "into", "is", "it", "its", "let",
  "may", "must", "need", "no", "not", "of", "on", "or",
  "our", "out", "re", "she", "so", "some", "than", "that",
  "the", "their", "them", "then", "there", "these", "they",
  "this", "to", "up", "us", "ve", "was", "we", "were",
  "what", "when", "which", "who", "will", "with", "you",
  "your",
]);

function isTextLike(path: string): boolean {
  const dotIdx = path.lastIndexOf(".");
  if (dotIdx === -1) return false;
  const ext = path.slice(dotIdx).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Derive unique search terms from issue title and body.
 * Returns lowercase words >= 4 chars, filtered of stop words.
 */
function deriveSearchQueries(title: string, body: string | null, maxSearches: number): string[] {
  const combined = `${title} ${body ?? ""}`;
  const words = combined.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const unique = [...new Set(words)].filter((w) => !STOP_WORDS.has(w));
  return unique.slice(0, maxSearches);
}

export interface RepositoryContextDeps {
  fetchRepo: (repoFullName: string) => Promise<GitHubRepoMetadata>;
  searchCode: (repoFullName: string, query: string, limit: number) => Promise<GitHubCodeSearchResult[]>;
  fetchFile: (repoFullName: string, path: string, ref?: string) => Promise<string>;
}

const defaultDeps: RepositoryContextDeps = {
  fetchRepo: defaultFetchRepo,
  searchCode: defaultSearchCode,
  fetchFile: defaultFetchFile,
};

/**
 * Build bounded repository context for grooming an issue.
 *
 * Fetches repo metadata and searches relevant code files based on the
 * issue title/body, enforcing byte and file count limits.
 */
export async function buildRepositoryContext(
  input: RepositoryContextInput,
  config: RepositoryContextConfig,
  deps: RepositoryContextDeps = defaultDeps,
): Promise<RepositoryContextResult> {
  const empty: RepositoryContextResult = {
    text: "",
    sources: [],
    warnings: [],
    bytes: 0,
    queries: [],
  };

  if (!config.enabled) {
    return empty;
  }

  const lines: string[] = [];
  const sources: string[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  // Fetch repo metadata (soft-fail)
  let metadata: GitHubRepoMetadata | null = null;
  try {
    metadata = await deps.fetchRepo(input.repoFullName);
  } catch (err) {
    warnings.push(`Failed to fetch repo metadata: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (metadata) {
    lines.push("Repository context:");
    lines.push(`- repo: ${metadata.fullName}`);
    lines.push(`- default branch: ${metadata.defaultBranch}`);
    if (metadata.description) {
      lines.push(`- description: ${metadata.description}`);
    }
  }

  // Derive search queries
  const queries = deriveSearchQueries(input.issueTitle, input.issueBody, config.maxSearches);
  if (queries.length === 0 && metadata) {
    return {
      text: lines.join("\n"),
      sources,
      warnings,
      bytes: Buffer.byteLength(lines.join("\n"), "utf8"),
      queries,
    };
  }

  const fetchedPaths = new Set<string>();
  const fileLines: string[] = [];

  for (const query of queries) {
    if (fetchedPaths.size >= config.maxFiles) break;

    let results: GitHubCodeSearchResult[] = [];
    try {
      results = await deps.searchCode(input.repoFullName, query, config.maxFiles);
    } catch (err) {
      warnings.push(`Code search failed for "${query}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const result of results) {
      if (fetchedPaths.size >= config.maxFiles) break;
      if (fetchedPaths.has(result.path)) continue;
      if (!isTextLike(result.path)) continue;

      fetchedPaths.add(result.path);

      let content: string = "";
      try {
        content = await deps.fetchFile(input.repoFullName, result.path, metadata?.defaultBranch);
      } catch (err) {
        warnings.push(`Failed to fetch ${result.path}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (!content) continue;

      // Enforce per-file byte limit
      const contentBytes = Buffer.byteLength(content, "utf8");
      if (contentBytes > config.maxFileBytes) {
        // Truncate to roughly the byte limit
        let truncated = content;
        while (Buffer.byteLength(truncated, "utf8") > config.maxFileBytes && truncated.length > 0) {
          truncated = truncated.slice(0, -100);
        }
        content = truncated + "\n...[truncated]";
      }

      // Enforce total byte limit
      const fileText = `File: ${result.path}\n${content}\n`;
      const fileBytes = Buffer.byteLength(fileText, "utf8");
      if (totalBytes + fileBytes > config.maxTotalBytes && totalBytes > 0) {
        continue;
      }

      fileLines.push(fileText);
      sources.push(result.path);
      totalBytes += fileBytes;
    }
  }

  const allLines = [...lines, ...fileLines];
  const text = allLines.join("\n");
  return {
    text,
    sources,
    warnings,
    bytes: Buffer.byteLength(text, "utf8"),
    queries,
  };
}
