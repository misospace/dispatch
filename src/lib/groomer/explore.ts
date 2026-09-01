import {
  buildGroomerToolDefinitions,
  defaultGroomerToolDeps,
  executeGroomerTool,
  type GroomerToolDeps,
} from "./tools";

export interface ExploreOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  repoFullName: string;
  /** The same issue context the final grooming call receives. */
  prompt: string;
  timeoutMs: number;
  maxToolCalls: number;
  maxTotalBytes: number;
  maxSearchResults: number;
  maxFileBytes: number;
  maxDirEntries: number;
}

export interface ExploreToolRecord {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  bytes: number;
  /** Truncated for storage; the model saw the full result. */
  preview: string;
}

export interface ExploreResult {
  /** Rendered block appended to the grooming prompt. Empty when nothing was learned. */
  findings: string;
  /** Repo paths the model reported as relevant, if it called submit_findings. */
  files: string[];
  /** The model's statement of the ask in repo terms, if it called submit_findings. */
  ask: string | null;
  sources: string[];
  toolCalls: ExploreToolRecord[];
  bytes: number;
  warnings: string[];
}

export interface ExploreDeps {
  tools: GroomerToolDeps;
  fetchImpl: typeof fetch;
}

export const defaultExploreDeps: ExploreDeps = {
  tools: defaultGroomerToolDeps,
  fetchImpl: fetch,
};

const EXPLORE_SYSTEM_PROMPT = `You are orienting yourself in a GitHub repository so that an issue can be turned into a task a worker can pick up.

The issue below was written by someone reporting a problem or asking for a change. They may not know this codebase at all, so the issue probably describes symptoms rather than files. Your job is to find the code the issue is actually about.

Work like this:
- Search for distinctive strings from the issue: identifiers, environment variables, error text, config keys.
- When a search returns nothing, that is information — the thing may be what is missing.
- Read the files that look relevant. Follow what you find; a file that imports something interesting is worth opening.
- Use list_directory when you are unsure what exists, rather than guessing paths.

Call submit_findings once you can name the files a worker would change and state what the issue is asking for in this repository's own terms. Be concrete: real paths you have actually seen, never a guess.`;

const EMPTY: Omit<ExploreResult, "warnings"> = {
  findings: "",
  files: [],
  ask: null,
  sources: [],
  toolCalls: [],
  bytes: 0,
};

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") {
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function renderFindings(files: string[], ask: string | null, notes: string, records: ExploreToolRecord[]): string {
  const lines: string[] = [];
  if (ask) lines.push(`What the issue is asking for, in repo terms: ${ask}`);
  if (files.length > 0) {
    lines.push(`Files a worker will likely need to change:\n${files.map((f) => `- ${f}`).join("\n")}`);
  }
  if (notes) lines.push(`Notes: ${notes}`);
  if (lines.length === 0 && records.length > 0) {
    // The model explored but never submitted. Its reading is still worth
    // carrying forward — the paths it opened are evidence about where the
    // issue lives, even without a conclusion.
    const seen = records.flatMap((r) =>
      r.name === "read_file" && typeof r.arguments.path === "string" ? [r.arguments.path] : [],
    );
    if (seen.length > 0) {
      lines.push(`Files examined while investigating:\n${seen.map((f) => `- ${f}`).join("\n")}`);
    }
  }
  if (lines.length === 0) return "";
  return `## Repository investigation\n\n${lines.join("\n\n")}`;
}

/**
 * Let the model drive its own repository exploration, bounded by a tool-call
 * budget and a byte budget, then hand back what it learned.
 *
 * Never throws. Exploration is an enrichment step: if the backend does not
 * support tool calling, or the loop errors partway, grooming proceeds with
 * whatever was gathered (possibly nothing) rather than failing the run.
 */
export async function exploreRepository(
  options: ExploreOptions,
  deps: ExploreDeps = defaultExploreDeps,
): Promise<ExploreResult> {
  const warnings: string[] = [];
  const records: ExploreToolRecord[] = [];
  const sources: string[] = [];
  let bytes = 0;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  const messages: ChatMessage[] = [
    { role: "system", content: EXPLORE_SYSTEM_PROMPT },
    { role: "user", content: options.prompt },
  ];

  try {
    for (let turn = 0; turn < options.maxToolCalls; turn++) {
      const response = await deps.fetchImpl(`${options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          tools: buildGroomerToolDefinitions(),
          tool_choice: "auto",
          temperature: 0.1,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        warnings.push(
          `repository exploration unavailable (${response.status}); grooming without it: ${text.slice(0, 200)}`,
        );
        break;
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;
      const toolCalls = message?.tool_calls;

      if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        // The model answered in prose instead of calling a tool. Nothing more
        // to gather; keep whatever it already looked at.
        break;
      }

      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: toolCalls });

      let submitted: { files: string[]; ask: string | null; notes: string } | null = null;

      for (const toolCall of toolCalls) {
        const name = toolCall?.function?.name ?? "";
        const args = parseArguments(toolCall?.function?.arguments);

        if (name === "submit_findings") {
          const files = Array.isArray(args.files)
            ? args.files.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
            : [];
          submitted = {
            files,
            ask: typeof args.ask === "string" && args.ask.trim() ? args.ask.trim() : null,
            notes: typeof args.notes === "string" ? args.notes.trim() : "",
          };
          sources.push(...files);
          records.push({ name, arguments: args, ok: true, bytes: 0, preview: "" });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name,
            content: "Findings recorded.",
          });
          continue;
        }

        const remaining = options.maxTotalBytes - bytes;
        if (remaining <= 0) {
          warnings.push("repository exploration hit its byte budget");
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name,
            content: "Context budget exhausted. Call submit_findings with what you have.",
          });
          continue;
        }

        const result = await executeGroomerTool(
          { name, arguments: args },
          {
            repoFullName: options.repoFullName,
            maxSearchResults: options.maxSearchResults,
            maxFileBytes: Math.min(options.maxFileBytes, remaining),
            maxDirEntries: options.maxDirEntries,
          },
          deps.tools,
        );

        bytes += result.bytes;
        sources.push(...result.sources);
        records.push({
          name,
          arguments: args,
          ok: result.ok,
          bytes: result.bytes,
          preview: result.content.slice(0, 500),
        });
        messages.push({ role: "tool", tool_call_id: toolCall.id, name, content: result.content });
      }

      if (submitted) {
        return {
          findings: renderFindings(submitted.files, submitted.ask, submitted.notes, records),
          files: submitted.files,
          ask: submitted.ask,
          sources: [...new Set(sources)],
          toolCalls: records,
          bytes,
          warnings,
        };
      }
    }

    if (records.length >= options.maxToolCalls) {
      warnings.push("repository exploration hit its tool-call budget without submitting findings");
    }

    return {
      ...EMPTY,
      findings: renderFindings([], null, "", records),
      sources: [...new Set(sources)],
      toolCalls: records,
      bytes,
      warnings,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      err instanceof Error && err.name === "AbortError"
        ? `repository exploration aborted after ${options.timeoutMs}ms`
        : `repository exploration failed: ${message}`,
    );
    return {
      ...EMPTY,
      findings: renderFindings([], null, "", records),
      sources: [...new Set(sources)],
      toolCalls: records,
      bytes,
      warnings,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
