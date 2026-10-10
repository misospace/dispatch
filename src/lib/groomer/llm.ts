import { getConfiguredLanes, getClaimableLanes, getBacklogLane } from "@/lib/lane-config";
import { STATUS_LABELS, PRIORITY_LABELS } from "@/types";
import { buildGroomerSystemPrompt } from "./prompts/system-prompt";
import { buildGroomingPlanResponseSchema } from "./plan-schema";
import { renderEvidenceCatalog, type EvidenceCatalog } from "./plan-evidence";
import { sanitizeForStorage, sanitizeModelText } from "./sanitize";

export interface CallLlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  /**
   * Send `response_format` (json_schema, falling back to json_object). Set
   * false for backends that implement neither; the system prompt still
   * demands JSON and `validateGroomingPlan` still checks it. Defaults to true.
   */
  responseFormat?: boolean;
  /**
   * Findings from the repository exploration loop, appended to the prompt.
   * Optional so the grooming call still works with no exploration at all.
   */
  explorationFindings?: string;
  /** Cap on the appended findings block. Defaults to MAX_FINDINGS_BYTES. */
  maxFindingsBytes?: number;
  /**
   * The run's citable evidence. Rendered into the user turn and used to
   * enum-constrain every evidence id in the response schema.
   */
  evidenceCatalog?: EvidenceCatalog;
  /**
   * The repair turn (dispatch#1126): the model's previous answer and the
   * exact errors it failed with. Sent as an assistant turn plus a user turn
   * after the original prompt, so the model corrects its own plan with the
   * full context it was produced from.
   */
  repair?: { previousResponse: string; errors: string[] };
}

/**
 * The model answered, but not with JSON (dispatch#1126). Carries the full
 * answer so the repair turn can show the model exactly what it sent; the
 * message keeps the short prefix the run history has always recorded.
 */
export class GroomerOutputParseError extends Error {
  readonly content: string;

  constructor(content: string) {
    // The message is persisted as the run's error (Postgres rejects NUL);
    // `content` stays verbatim for the repair turn to echo back.
    super(`Failed to parse LLM response as JSON: ${sanitizeForStorage(content.slice(0, 200))}`);
    this.name = "GroomerOutputParseError";
    this.content = content;
  }
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

/**
 * JSON Schema for the groomer's output: the GroomingPlan draft
 * (dispatch#1062), sent as an OpenAI-style `json_schema` response_format. On a
 * self-hosted llama.cpp backend (via litellm) this grammar-constrains decoding
 * to the exact shape — the key to reliable output from a small model. Lanes,
 * labels and evidence ids are enums built from the configured lanes, the
 * label allowlist and this run's evidence catalog. `validateGroomingPlan`
 * still runs afterward for the cross-field readiness invariants.
 */
export function buildGroomerResponseSchema(catalog?: EvidenceCatalog): Record<string, unknown> {
  return buildGroomingPlanResponseSchema(catalog);
}

/**
 * The exploration findings ride in the same user turn as the issue context.
 * The final grooming call stays a single schema-constrained completion — the
 * grammar constraint is what makes a small model's output reliable, and mixing
 * it with tool calling is exactly what the separate exploration pass avoids.
 */
export const MAX_FINDINGS_BYTES = 4096;

function withFindings(options: CallLlmOptions): string {
  const findings = options.explorationFindings?.trim();
  if (!findings) return options.prompt;
  const limit = options.maxFindingsBytes ?? MAX_FINDINGS_BYTES;
  const buf = Buffer.from(findings, "utf8");
  if (buf.byteLength <= limit) return `${options.prompt}\n\n${findings}`;
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  const clipped = decoder.decode(buf.subarray(0, limit)).replace(/\uFFFD$/, "");
  return `${options.prompt}\n\n${clipped}\n… (findings truncated)`;
}

function buildUserContent(options: CallLlmOptions): string {
  const content = withFindings(options);
  if (!options.evidenceCatalog) return content;
  return `${content}\n\n${renderEvidenceCatalog(options.evidenceCatalog)}`;
}

/**
 * Cap on the previous answer echoed back in the repair turn. A valid plan
 * is well under it; the cap only bites on a runaway non-JSON answer.
 */
export const MAX_REPAIR_ECHO_BYTES = 32_768;

function clipUtf8(text: string, limit: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= limit) return text;
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  return `${decoder.decode(buf.subarray(0, limit)).replace(/\uFFFD$/, "")}\n… (truncated)`;
}

/**
 * The user turn that asks for a corrected plan (dispatch#1126). It informs
 * rather than constrains: the exact errors, what an evidence-reference error
 * means, and that this turn has no tools, which is what a final answer made
 * of <tool_call> text got wrong.
 */
export function buildRepairPrompt(errors: string[]): string {
  return [
    "Your previous answer could not be used as a grooming plan. Dispatch rejected it with these errors:",
    "",
    ...errors.map((error) => `- ${error}`),
    "",
    "Return the complete corrected grooming plan as a single JSON object. Fix what the errors name and keep the rest of your analysis unless a fix requires changing it.",
    'An evidence-reference error means the id is not in "Evidence you can cite", or is the wrong kind of id for that field. relatedWork[].ref and implementationBrief.dependencies[].evidenceRef take only related-work ids ("github:..."); when none fits, drop the relatedWork entry or set evidenceRef to null rather than citing another kind of id.',
    "No tools are available in this turn. Do not emit tool calls, <tool_call> tags or prose: answer with the JSON object only.",
  ].join("\n");
}

function buildMessages(options: CallLlmOptions): Array<{ role: string; content: string }> {
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserContent(options) },
  ];
  if (options.repair) {
    messages.push(
      { role: "assistant", content: clipUtf8(options.repair.previousResponse, MAX_REPAIR_ECHO_BYTES) },
      { role: "user", content: buildRepairPrompt(options.repair.errors) },
    );
  }
  return messages;
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
      messages: buildMessages(options),
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
  if (options.responseFormat === false) {
    return postChatCompletion(url, options, undefined, signal);
  }
  let response = await postChatCompletion(
    url,
    options,
    {
      type: "json_schema",
      json_schema: { name: "grooming_plan", schema: buildGroomerResponseSchema(options.evidenceCatalog) },
    },
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

/**
 * Returns the model's parsed JSON, unvalidated. The caller validates it as a
 * GroomingPlan against the same evidence catalog.
 */
export async function callGroomerLLM(options: CallLlmOptions): Promise<unknown> {
  const url = `${options.baseUrl}/chat/completions`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    // Prefer schema-constrained decoding. Fall back to plain JSON mode if the
    // backend rejects json_schema (400), so grooming never breaks on a serving
    // stack that doesn't support it; validateGroomingPlan checks content either way.
    // The call is wrapped in a bounded retry so a transient transport failure
    // (socket drop / connection reset) or a retryable 5xx from a rolling
    // litellm restart re-issues to a healthy replica instead of losing the run.
    const response = await callWithRetry(url, options, controller.signal);

    if (!response.ok) {
      const text = await response.text();
      // This provider error body is foreign text into the run's errorMessage
      // columns; sanitize it here at the source (the strip tier per #1157; the
      // columns are unbounded text, so no length cap). Postgres rejects NUL
      // and repo policy strips the other C0 controls (keeping \n/\t).
      throw new Error(`LLM API error ${response.status}: ${sanitizeModelText(text)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("Unexpected LLM response format: no message content");
    }

    const trimmed = trimJsonFences(content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new GroomerOutputParseError(trimmed);
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
