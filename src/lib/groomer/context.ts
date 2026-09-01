import { fetchIssueComments as fetchGitHubIssueComments } from "@/lib/github";
import type { RepositoryContextResult } from "./repository-context";

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueContextInput {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  currentLane: string | null;
  comments: IssueComment[];
  maxContextBytes?: number;
  repositoryContext?: RepositoryContextResult;
}

/**
 * Logins whose comments are this system talking to itself: the coder, the
 * reviewer, and GitHub Actions. Their comments are evidence of what the
 * automation did, never authority for what it should do next.
 */
const AUTOMATION_AUTHORS = new Set(["itsmiso-ai", "its-saffron", "its-miso", "github-actions[bot]"]);

export function isAutomationAuthor(author: string): boolean {
  const a = (author || "").toLowerCase();
  return AUTOMATION_AUTHORS.has(a) || a.endsWith("[bot]");
}

export async function fetchIssueComments(
  repoFullName: string,
  issueNumber: number,
  maxComments = 5,
): Promise<IssueComment[]> {
  const comments = await fetchGitHubIssueComments(repoFullName, issueNumber, maxComments);
  return comments.slice(0, maxComments).map((comment) => ({
    author: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
    createdAt: comment.created_at ?? "",
  }));
}

/**
 * Build a text prompt from issue context for the LLM.
 */
export async function buildIssueContext(input: IssueContextInput): Promise<string> {
  const maxBytes = input.maxContextBytes ?? 8192;

  let body = input.body ?? "(no body)";
  if (body.length > maxBytes * 0.6) {
    body = body.slice(0, Math.floor(maxBytes * 0.6)) + "\n...[truncated]";
  }

  const labelStr = input.labels.length > 0 ? input.labels.join(", ") : "(none)";
  const laneStr = input.currentLane ? `lane: ${input.currentLane}` : "lane: (not set)";

  let commentSection = "";
  if (input.comments.length > 0) {
    // Mark automation comments. The groomer writes its own grooming notes back
    // to the issue, so on the next pass it reads them as prior decisions and
    // defers again, citing itself. Four P3 chores were parked that way with
    // reasons like "deferred by maintainer" and "kept in backlog per audit
    // decision" that no maintainer had written. Without the tag the model
    // cannot tell its own past output from a human's instruction.
    const commentTexts = input.comments.map((c) => {
      const tag = isAutomationAuthor(c.author) ? " [automation — not a human decision]" : "";
      return `- ${c.author}${tag} (${c.createdAt}): ${c.body}`;
    });
    commentSection = `\n\nRecent comments:\n${commentTexts.join("\n")}`;
  }

  const repoContext = input.repositoryContext?.text
    ? `\n\n${input.repositoryContext.text}`
    : "";
  const warningSection = input.repositoryContext?.warnings.length
    ? `\n\nContext warnings:\n${input.repositoryContext.warnings.map((w) => `- ${w}`).join("\n")}`
    : "";

  return `Issue #${input.number}: ${input.title}

${laneStr}
labels: ${labelStr}

body:
${body}${commentSection}${repoContext}${warningSection}`;
}
