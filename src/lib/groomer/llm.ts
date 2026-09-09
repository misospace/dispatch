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
  /**
   * Findings from the repository exploration loop, appended to the prompt.
   * Optional so the grooming call still works with no exploration at all.
   */
  explorationFindings?: string;
  /** Cap on the appended findings block. Defaults to MAX_FINDINGS_BYTES. */
  maxFindingsBytes?: number;
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

/**
 * The exploration findings ride in the same user turn as the issue context.
 * The final grooming call stays a single schema-constrained completion — the
 * grammar constraint is what makes a small model's output reliable, and mixing
 * it with tool calling is exactly what the separate exploration pass avoids.
 */
export const MAX_FINDINGS_BYTES = 4096;

function buildUserContent(options: CallLlmOptions): string {
  const findings = options.explorationFindings?.trim();
  if (!findings) return options.prompt;
  const limit = options.maxFindingsBytes ?? MAX_FINDINGS_BYTES;
  const buf = Buffer.from(findings, "utf8");
  if (buf.byteLength <= limit) return `${options.prompt}\n\n${findings}`;
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  const clipped = decoder.decode(buf.subarray(0, limit)).replace(/\uFFFD$/, "");
  return `${options.prompt}\n\n${clipped}\n… (findings truncated)`;
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
        { role: "user", content: buildUserContent(options) },
      ],
      response_format: responseFormat,
      temperature: 0.1,
    }),
    signal,
  });
}

/**
 * HTTP statuses that indicate a transient upstream failure worth retrying.
 * A rolling litellm restart surfaces as a 502/503/504 from the Service while
 * a pod is terminating; a 500 is a generic backend hiccup. 4xx (including the
 * `400 response_format` class) is a real client error and must NOT be retried.
 */
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

/** Bounded retry cap: 3 total attempts (1 initial + 2 retries). */
const MAX_ATTEMPTS = 3;

/** Base delay for exponential backoff: 500ms, 1000ms between attempts. */
const BASE_BACKOFF_MS = 500;

/**
 * True when a rejected fetch is a transient transport failure worth retrying.
 *
 * undici surfaces a dropped socket as `TypeError: fetch failed` with a
 * `cause` carrying the underlying code (`UND_ERR_SOCKET`, `ECONNRESET`,
 * `ECONNREFUSED`, `EPIPE`). A rolling litellm restart that terminates the pod
 * mid-stream is exactly this shape. Timeouts (`AbortError`) and other errors
 * are NOT transient — retrying them would just burn time.
 */
function isTransientFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;

  const cause = (err as { cause?: unknown }).cause;
  const causeCode =
    cause instanceof Error ? ((cause as { code?: string }).code ?? "") : "";
  const causeName = cause instanceof Error ? cause.name : "";
  const causeMessage = cause instanceof Error ? cause.message : "";

  const codes = [causeCode, causeName, err.message, causeMessage].join(" ");
  return (
    /UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|EPIPE/i.test(codes) ||
    (err.name === "TypeError" && /fetch failed/i.test(err.message))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One logical attempt: prefer schema-constrained decoding, and if the backend
 * rejects `json_schema` (400) fall back to plain JSON mode. The fallback is a
 * deliberate downgrade, not a retry — a 400 from the fallback is a real error.
 */
async function attemptChatCompletion(
  url: string,
  options: CallLlmOptions,
  signal: AbortSignal,
): Promise<Response> {
  let response = await postChatCompletion(
    url,
    options,
    { type: "json_schema", json_schema: { name: "groomer_output", schema: buildGroomerResponseSchema() } },
    signal,
  );
  if (response.status === 400) {
    response = await postChatCompletion(url, options, { type: "json_object" }, signal);
  }
  return response;
}

/**
 * Issue the chat-completion attempt with a bounded retry on transient
 * failures only.
 *
 * Retries when the fetch rejects with a transient transport error (socket
 * drop / connection reset) or resolves with a retryable 5xx, up to
 * `MAX_ATTEMPTS` with short exponential backoff. Since litellm is a
 * 3-replica Service, a retried request re-resolves to a healthy pod. A
 * non-retryable 4xx (e.g. `400 response_format`) is returned immediately so
 * the caller's existing error handling runs.
 */
async function callWithRetry(
  url: string,
  options: CallLlmOptions,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await attemptChatCompletion(url, options, signal);
    } catch (err) {
      // Transport-level failure (socket drop, connection reset, ...).
      if (!isTransientFetchError(err) || attempt === MAX_ATTEMPTS) throw err;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) {
      return response;
    }
    // Retryable 5xx — release the body so the socket can be reused, then back off.
    await response.body?.cancel().catch(() => {});
    await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
  }
  // Unreachable: the loop always returns or throws.
  throw new Error("callWithRetry: unreachable");
}

export async function callGroomerLLM(options: CallLlmOptions): Promise<GroomerOutput> {
  const url = `${options.baseUrl}/chat/completions`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    // Prefer schema-constrained decoding. Fall back to plain JSON mode if the
    // backend rejects json_schema (400), so grooming never breaks on a serving
    // stack that doesn't support it; validateGroomerOutput repairs content either way.
    // The call is wrapped in a bounded retry so a transient transport failure
    // (socket drop / connection reset) or a retryable 5xx from a rolling
    // litellm restart re-issues to a healthy replica instead of losing the run.
    const response = await callWithRetry(url, options, controller.signal);

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
