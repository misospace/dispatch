import type { GroomerOutput } from "./schema";
import { getConfiguredLanes, getClaimableLanes, getBacklogLane } from "@/lib/lane-config";
import { STATUS_LABELS, PRIORITY_LABELS } from "@/types";

export interface CallLlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  timeoutMs: number;
}

const VALID_TYPE_LABELS = ["type/bug", "type/feature", "type/chore", "type/research", "type/security"];

function buildSystemPrompt(): string {
  const laneIds = getConfiguredLanes().map((lane) => lane.id).join("|");
  const claimableIds = getClaimableLanes().map((lane) => lane.id).join("|");
  const backlogLane = getBacklogLane();
  const statusLabels = STATUS_LABELS.join(", ");
  const priorityLabels = PRIORITY_LABELS.join(", ");
  const typeLabels = VALID_TYPE_LABELS.join(", ");
  return `You are an issue grooming assistant for a software project. Your job is to analyze GitHub issues and recommend labels, lane classification, and grooming actions.

Return ONLY valid JSON with this exact schema:
{
  "actionability": "ready|needs_info|blocked|backlog|already_done",
  "confidence": "high|medium|low",
  "labelsToAdd": ["status/ready", "priority/p1"],
  "labelsToRemove": ["status/backlog"],
  "lane": { "id": "${laneIds}", "confidence": "high|medium|low", "reason": "short reason" },
  "summary": "brief summary of grooming decision",
  "githubComment": "optional comment to post on the issue (omit if nothing to say)",
  "needsInfoReason": "optional reason if info is needed",
  "blockedReason": "optional reason if blocked",
  "nextGroomingAction": "optional: promote_to_ready|escalate|mark_not_ready|mark_needs_info|mark_blocked",
  "proposedTitle": "optional: rewritten title if current one is bad",
  "proposedBody": "optional: enriched body if current one is sparse"
}

Rules:
- Only add/remove labels with prefixes: status/, priority/, type/
- Valid status labels: ${statusLabels}
- Valid priority labels: ${priorityLabels}
- Valid type labels: ${typeLabels}
- Never remove agent/* labels
- Lane must be one of the configured lane ids
- When actionability is "ready", lane.id MUST be a claimable worker lane (${claimableIds})${backlogLane ? `, NEVER "${backlogLane.id}"` : ""}${backlogLane ? `. The "${backlogLane.id}" lane is non-claimable — use it only when actionability is not "ready" (needs_info/blocked/backlog/already_done). Priority (P2/P3/low) does NOT mean backlog: a low-priority but ready issue still goes to a claimable lane.` : ""}
- Be concise in summary and reason fields

Title rewriting rules:
- Only propose a new title when the current title is bad: length < 10 chars, matches generic patterns (single word like "P0", "TODO", "bug", "fix"), or is clearly just a priority/label token
- If the title is already descriptive (>= 10 chars and looks like a real sentence/phrase), omit proposedTitle
- The new title should be 10-200 chars, imperative verb form, specific and actionable
- Base the rewritten title on body content, labels, and comments

Body enrichment rules:
- Only propose an enriched body when the current body is missing, empty, or < 100 characters (excluding markdown/HTML comments)
- If the body already has substantial content, omit proposedBody
- The enriched body should add structure: brief context, what's known, suggested approach based on labels/body/comments
- Do NOT clobber existing body content — if there's any meaningful body, append rather than replace; if empty/missing, create from scratch
- Keep enriched body under 10000 characters`;
}

export async function callGroomerLLM(options: CallLlmOptions): Promise<GroomerOutput> {
  const url = `${options.baseUrl}/chat/completions`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: options.prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("Unexpected LLM response format: no message content");
    }

    const trimmed = trimJsonFences(content);
    let parsed: GroomerOutput;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Failed to parse LLM response as JSON: ${trimmed.slice(0, 200)}`);
    }

    return parsed;
  } finally {
    clearTimeout(timeoutId);
  }
}

function trimJsonFences(text: string): string {
  let result = text.trim();
  if (result.startsWith("```")) {
    const firstNewline = result.indexOf("\n");
    if (firstNewline > 0) {
      result = result.slice(firstNewline + 1);
    } else {
      result = result.slice(3);
    }
  }
  if (result.endsWith("```")) {
    result = result.slice(0, -3).trim();
  }
  return result;
}
