import { fetchIssueComments as fetchGitHubIssueComments } from "@/lib/github";

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
    const commentTexts = input.comments.map(
      (c) => `- ${c.author} (${c.createdAt}): ${c.body}`,
    );
    commentSection = `\n\nRecent comments:\n${commentTexts.join("\n")}`;
  }

  return `Issue #${input.number}: ${input.title}

${laneStr}
labels: ${labelStr}

body:
${body}${commentSection}`;
}
