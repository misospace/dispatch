import type { GroomerOutput } from "./schema";
import { getConfiguredLanes } from "@/lib/lane-config";
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
  "nextGroomingAction": "optional: promote_to_ready|escalate|mark_not_ready|mark_needs_info|mark_blocked"
}

Rules:
- Only add/remove labels with prefixes: status/, priority/, type/
- Valid status labels: ${statusLabels}
- Valid priority labels: ${priorityLabels}
- Valid type labels: ${typeLabels}
- Never remove agent/* labels
- Lane must be one of the configured lane ids
- Be concise in summary and reason fields`;
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
