import { ALLOWED_GROOMER_LABELS, type GroomerOutput } from "./schema";
import { getConfiguredLanes, getClaimableLanes, getBacklogLane, getLaneIds } from "@/lib/lane-config";
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
- Keep enriched body under 10000 characters

Comment rules:
- githubComment is posted verbatim to GitHub and any @username token will be auto-linkified into a live mention that notifies that account — NEVER include @username mentions in githubComment
- Address roles in plain words (e.g. "the reviewer", "the assignee", "maintainers") instead of using @-mentions
- If quoting code, identifiers, or example usernames, wrap them in backticks so GitHub does not linkify them`;
}

const CONFIDENCE_ENUM = ["high", "medium", "low"] as const;

/**
 * JSON Schema for the groomer's output, used as an OpenAI-style `json_schema`
 * response_format. On a self-hosted llama.cpp backend (via litellm) this
 * grammar-constrains decoding to the exact shape — the key to reliable output
 * from a small model. `lane.id` is a dynamic enum built from the configured
 * lanes so the model can only emit a real lane, never a hallucinated one.
 * `validateGroomerOutput` still runs afterward as the safety net (and handles
 * enum alias canonicalization), so this is belt-and-suspenders.
 */
export function buildGroomerResponseSchema(): Record<string, unknown> {
  const laneIds = getLaneIds();
  const confidence = { type: "string", enum: [...CONFIDENCE_ENUM] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["labelsToAdd", "labelsToRemove", "lane"],
    properties: {
      actionability: { type: "string", enum: ["ready", "needs_info", "blocked", "backlog", "already_done"] },
      confidence,
      // Enum-constrained to the validator's allowlist so the model cannot
      // invent labels (a 4B happily emits "type/refactor" otherwise).
      labelsToAdd: { type: "array", items: { type: "string", enum: [...ALLOWED_GROOMER_LABELS] } },
      labelsToRemove: { type: "array", items: { type: "string", enum: [...ALLOWED_GROOMER_LABELS] } },
      lane: {
        type: "object",
        additionalProperties: false,
        required: ["id", "confidence", "reason"],
        properties: {
          id: laneIds.length > 0 ? { type: "string", enum: laneIds } : { type: "string" },
          confidence,
          reason: { type: "string" },
        },
      },
      summary: { type: "string" },
      githubComment: { type: "string" },
      needsInfoReason: { type: "string" },
      blockedReason: { type: "string" },
      nextGroomingAction: {
        type: "string",
        enum: ["promote_to_ready", "escalate", "mark_not_ready", "mark_needs_info", "mark_blocked"],
      },
      // The validator requires 10-200 chars (or omitted/null). Without the
      // bounds in the grammar a small model emits "" instead of omitting.
      proposedTitle: { anyOf: [{ type: "null" }, { type: "string", minLength: 10, maxLength: 200 }] },
      proposedBody: { anyOf: [{ type: "null" }, { type: "string", maxLength: 9999 }] },
    },
  };
}

function postChatCompletion(
  url: string,
  options: CallLlmOptions,
  responseFormat: unknown,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
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
      response_format: responseFormat,
      temperature: 0.1,
    }),
    signal,
  });
}

export async function callGroomerLLM(options: CallLlmOptions): Promise<GroomerOutput> {
  const url = `${options.baseUrl}/chat/completions`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    // Prefer schema-constrained decoding. Fall back to plain JSON mode if the
    // backend rejects json_schema (400), so grooming never breaks on a serving
    // stack that doesn't support it; validateGroomerOutput repairs content either way.
    let response = await postChatCompletion(
      url,
      options,
      { type: "json_schema", json_schema: { name: "groomer_output", schema: buildGroomerResponseSchema() } },
      controller.signal,
    );
    if (response.status === 400) {
      response = await postChatCompletion(url, options, { type: "json_object" }, controller.signal);
    }

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
