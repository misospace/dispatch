import { ALLOWED_GROOMER_LABELS, type GroomerOutput } from "./schema";
import { getConfiguredLanes, getClaimableLanes, getBacklogLane, getLaneIds } from "@/lib/lane-config";
import { STATUS_LABELS, PRIORITY_LABELS } from "@/types";
import { buildGroomerSystemPrompt } from "./prompts/system-prompt";

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
  const claimableLanes = getClaimableLanes();
  const defaultLane = claimableLanes.find((l) => l.role === "default") ?? claimableLanes[0];
  const escalationLane = claimableLanes.find((l) => l.role === "escalation");
  const laneGuide = claimableLanes
    .map((l) => `  - "${l.id}"${l.role ? ` (${l.role})` : ""}: ${l.description ?? l.title ?? l.id}`)
    .join("\n");
  const statusLabels = STATUS_LABELS.join(", ");
  const priorityLabels = PRIORITY_LABELS.join(", ");
  const typeLabels = VALID_TYPE_LABELS.join(", ");

  return buildGroomerSystemPrompt({
    laneIds,
    claimableIds,
    backlogLaneId: backlogLane?.id ?? "",
    laneGuide,
    defaultLaneId: defaultLane.id,
    escalationLaneId: escalationLane?.id ?? "",
    statusLabels,
    priorityLabels,
    typeLabels,
  });
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
          notReadyReason: { type: "string" },
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
  } catch (err) {
    // Attribute timeouts to the model so aborts can be correlated with pool
    // members. The raw AbortError message is "This operation was aborted" and
    // carries no model info; without this wrapper, every timeout looks the
    // same in the GroomingRun.errorMessage column.
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Groomer LLM call to model '${options.model}' aborted after ${options.timeoutMs}ms timeout`,
      );
    }
    throw err;
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
