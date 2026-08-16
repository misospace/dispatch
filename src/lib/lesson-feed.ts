/**
 * Feed repo-specific lessons learned from pr-fix/tombstone outcomes back into
 * AGENTS.md. Closes the loop that today only preserves burned-attempt lessons
 * when a human hand-writes them (e.g. windowstead#321's `assert_eq` arity trap,
 * pinchflat's sqlean/app path gotchas).
 *
 * Trigger: a PrFixQueueItem reaching FIXED after ≥2 feedback entries (a proxy
 * for "≥2 attempts" — feedback is appended per re-enqueue in enqueuePrFixItem),
 * or a workload ending BLOCKED/tombstoned. The model returns either
 * `no_lesson` (the common case — same bar as the groomer's binary ready/backlog)
 * or a 1-3 sentence, checkable gotcha. Dedupe + PR-opening live downstream.
 *
 * The LLM call mirrors src/lib/groomer/llm.ts: a raw fetch against an
 * OpenAI-compatible /chat/completions endpoint with `response_format:
 * json_schema`, falling back to `json_object` on a 400. We never import the
 * `openai` SDK — the rest of the repo doesn't, and adding a dep for one call
 * shape isn't justified.
 */

export type LessonOutcome =
  | { kind: "no_lesson" }
  | { kind: "lesson"; text: string };

export interface ExtractLessonInput {
  repo: string;
  reason: string;
  /** Appended per re-enqueue in enqueuePrFixItem; length is the attempts proxy. */
  feedback: string[];
  /** Final fix diff; may be empty when lessons come from a tombstoned workload. */
  fixDiff?: string;
  /** Optional existing AGENTS.md excerpt for cheap dedupe hint. */
  existingAgentsMd?: string;
}

const LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: {
      type: "string",
      enum: ["no_lesson", "lesson"],
      description:
        "no_lesson unless something non-obvious about THIS repo burned ≥2 attempts. Prefer no_lesson.",
    },
    text: {
      type: "string",
      description:
        "If verdict=lesson: 1-3 sentences capturing the checkable gotcha. Cite file/symbol when possible.",
    },
  },
  required: ["verdict"],
} as const;

const LESSON_SYSTEM_PROMPT = [
  "You extract repo-specific gotchas from pr-fix attempts.",
  "Output a tiny JSON object following the provided schema.",
  "Default to no_lesson — only emit a lesson when the same feedback burned ≥2 attempts AND",
  "the lesson would change a future coder's approach. Vague tips like \"be careful\" do not qualify.",
  "A good lesson is checkable: it references a specific symbol, file, or constraint and predicts the failure shape.",
  'Bad: "the test harness is tricky". Good: "assert_eq is 2-arg; omitting the name is a parse error that drops the whole test file."',
].join(" ");

export interface LessonFeedOptions {
  /** Override the model (tests + future ops). */
  model?: string;
  /** Override the OpenAI-compatible base URL (tests + OSS endpoints). */
  baseUrl?: string;
  /** Override the API key (tests). */
  apiKey?: string;
  /** Fetch override — only used by tests. */
  fetcher?: typeof fetch;
  /** Per-call timeout in ms; the model call is short so default is generous. */
  timeoutMs?: number;
}

function readConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  };
}

/**
 * Extract a repo-specific lesson from a resolved pr-fix outcome.
 *
 * Safe-by-default: any failure (missing creds, schema mismatch, etc.) returns
 * `no_lesson` rather than throwing — the feed is advisory and must never block
 * the lifecycle of the queue item that triggered it.
 */
export async function extractLessonFromFixOutcome(
  input: ExtractLessonInput,
  options: LessonFeedOptions = {},
): Promise<LessonOutcome> {
  const attempts = input.feedback.length;
  if (attempts < 2) return { kind: "no_lesson" };

  const cfg = readConfig();
  const apiKey = options.apiKey ?? cfg.apiKey;
  const baseUrl = options.baseUrl ?? cfg.baseUrl;
  const model = options.model ?? cfg.model;
  if (!apiKey) return { kind: "no_lesson" };

  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const userPayload = JSON.stringify({
    repo: input.repo,
    attempts,
    reason: input.reason,
    feedback: input.feedback,
    fixDiff: input.fixDiff ?? "",
    existingAgentsMdHints: input.existingAgentsMd ?? "",
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await postChatCompletion(fetcher, url, apiKey, model, userPayload, {
      type: "json_schema",
      json_schema: { name: "lesson_outcome", schema: LESSON_SCHEMA as any, strict: true },
    }, controller.signal);

    // Some endpoints reject json_schema with a 400; fall back to json_object so
    // the feed still works (mirrors lib/groomer/llm.ts).
    if (response.status === 400) {
      response = await postChatCompletion(fetcher, url, apiKey, model, userPayload, {
        type: "json_object",
      }, controller.signal);
    }

    if (!response.ok) return { kind: "no_lesson" };

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return { kind: "no_lesson" };
    const cleaned = trimJsonFences(raw);
    const parsed = JSON.parse(cleaned) as { verdict?: string; text?: string };
    if (parsed.verdict !== "lesson") return { kind: "no_lesson" };
    const text = (parsed.text ?? "").trim();
    if (text.length === 0 || text.length > 600) return { kind: "no_lesson" };
    return { kind: "lesson", text };
  } catch {
    return { kind: "no_lesson" };
  } finally {
    clearTimeout(timeoutId);
  }
}

function postChatCompletion(
  fetcher: typeof fetch,
  url: string,
  apiKey: string,
  model: string,
  userContent: string,
  responseFormat: unknown,
  signal: AbortSignal,
): Promise<Response> {
  return fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: LESSON_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: responseFormat,
      temperature: 0,
    }),
    signal,
  });
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

/** Cheap textual dedupe hint for the future PR-opener to use. */
export function lessonAlreadyCovered(existingAgentsMd: string | undefined, text: string): boolean {
  if (!existingAgentsMd) return false;
  const needle = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 4)
    .slice(0, 6);
  if (needle.length === 0) return false;
  const haystack = existingAgentsMd.toLowerCase();
  return needle.every((t) => haystack.includes(t));
}
