import { describe, expect, it, vi, beforeEach } from "vitest";
import { callGroomerLLM, buildGroomerResponseSchema, GroomerOutputParseError, MAX_REPAIR_ECHO_BYTES } from "./llm";
import { PLAN_LABELS } from "./plan";
import { buildEvidenceCatalog } from "./plan-evidence";
import { getLaneIds } from "@/lib/lane-config";

const catalog = buildEvidenceCatalog({
  capturedAt: "2026-09-26T00:00:00.000Z",
  repoFullName: "org/repo",
  defaultBranch: "main",
  headSha: "abc123",
  pinnedRef: "abc123",
  issue: { number: 899, title: "t", body: null, labels: [], state: "open", updatedAt: "", url: "" },
  issueFingerprint: "fp",
  comments: [],
  evidenceDigest: "d",
  warnings: [],
  sources: [{ path: "src/lib/prisma.ts", provenance: "repository", via: "read", ref: "abc123" }],
});

describe("callGroomerLLM", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("makes a POST request to the chat completions endpoint", async () => {
    let capturedUrl: string | null = null;
    let capturedBody: any = null;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"labelsToAdd":[],"labelsToRemove":[],"lane":{"id":"local","confidence":"high","reason":"test"},"summary":"ok"}' } }],
      }),
    });

    const result: any = await callGroomerLLM({
      baseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      prompt: "Classify this issue",
      timeoutMs: 10000,
    });

    capturedUrl = (global.fetch as any).mock.calls[0][0];
    capturedBody = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(capturedUrl).toBe("https://llm.example.com/chat/completions");
    expect(capturedBody.model).toBe("gpt-4o-mini");
    expect(capturedBody.response_format?.type).toBe("json_schema");
  });

  it("returns parsed JSON from LLM response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"labelsToAdd":["status/ready"],"labelsToRemove":[],"lane":{"id":"local","confidence":"high","reason":"clear task"},"summary":"ready for work"}' } }],
      }),
    });

    const result: any = await callGroomerLLM({
      baseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      prompt: "test",
      timeoutMs: 10000,
    });

    expect(result.labelsToAdd).toEqual(["status/ready"]);
    expect(result.lane.id).toBe("local");
    expect(result.summary).toBe("ready for work");
  });

  it("throws on non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(
      callGroomerLLM({
        baseUrl: "https://llm.example.com",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        prompt: "test",
        timeoutMs: 10000,
      }),
    ).rejects.toThrow(/500/);
  });

  it("throws on invalid JSON in response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "not json at all" } }],
      }),
    });

    await expect(
      callGroomerLLM({
        baseUrl: "https://llm.example.com",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        prompt: "test",
        timeoutMs: 10000,
      }),
    ).rejects.toThrow(/parse/i);
  });

  it("attributes AbortError timeouts to the requested model", async () => {
    // The raw fetch AbortError carries no model info — every timeout otherwise
    // looks identical in GroomingRun.errorMessage, so aborts can't be correlated
    // with the pool member that served them.
    const abortError = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    global.fetch = vi.fn().mockRejectedValue(abortError);

    await expect(
      callGroomerLLM({
        baseUrl: "https://llm.example.com",
        apiKey: "sk-test",
        model: "self-hosted/mac-member",
        prompt: "test",
        timeoutMs: 60000,
      }),
    ).rejects.toThrow(/self-hosted\/mac-member.*60000ms/);
  });

  it("includes authorization header", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"labelsToAdd":[],"labelsToRemove":[],"lane":{"id":"local","confidence":"high","reason":"test"},"summary":"ok"}' } }],
      }),
    });

    await callGroomerLLM({
      baseUrl: "https://llm.example.com",
      apiKey: "sk-secret-key",
      model: "gpt-4o-mini",
      prompt: "test",
      timeoutMs: 10000,
    });

    const headers = (global.fetch as any).mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer sk-secret-key");
  });

  it("sends system and user messages", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"labelsToAdd":[],"labelsToRemove":[],"lane":{"id":"local","confidence":"high","reason":"test"},"summary":"ok"}' } }],
      }),
    });

    await callGroomerLLM({
      baseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      prompt: "Classify this issue",
      timeoutMs: 10000,
    });

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
  });

  it("includes configured lane ids in the system prompt", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"labelsToAdd":[],"labelsToRemove":[],"lane":{"id":"local","confidence":"high","reason":"test"},"summary":"ok"}' } }],
      }),
    });

    await callGroomerLLM({
      baseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      prompt: "test",
      timeoutMs: 10000,
    });

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.messages[0].content).toContain("local|cloud|frontier|backlog");
  });

  it("throws on fetch error", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(
      callGroomerLLM({
        baseUrl: "https://llm.example.com",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        prompt: "test",
        timeoutMs: 10000,
      }),
    ).rejects.toThrow(/network error/);
  });

  it("trims markdown code fences from response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "```json\n{\"labelsToAdd\":[],\"labelsToRemove\":[],\"lane\":{\"id\":\"local\",\"confidence\":\"high\",\"reason\":\"test\"},\"summary\":\"ok\"}\n```" } }],
      }),
    });

    const result: any = await callGroomerLLM({
      baseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      prompt: "test",
      timeoutMs: 10000,
    });

    expect(result.lane.id).toBe("local");
  });
});

describe("callGroomerLLM transient retry", () => {
  const baseOptions = {
    baseUrl: "https://llm.example.com",
    apiKey: "sk-test",
    model: "gpt-4o-mini",
    prompt: "test",
    timeoutMs: 10000,
  };

  function okResponse() {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ labelsToAdd: [], labelsToRemove: [], lane: { id: "local", confidence: "high", reason: "r" } }) } }],
      }),
      text: async () => "",
    };
  }

  function socketDropError() {
    const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    return Object.assign(new TypeError("fetch failed"), { cause });
  }

  function connResetError() {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return Object.assign(new TypeError("fetch failed"), { cause });
  }

  function serverError(status: number) {
    return { ok: false, status, text: async () => `HTTP ${status}` };
  }

  it("retries a transient socket drop and succeeds on a later attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(socketDropError())
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const promise = callGroomerLLM(baseOptions);
    await vi.advanceTimersByTimeAsync(5000);
    const result: any = await promise;

    expect(result.lane.id).toBe("local");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries an ECONNRESET transport failure and succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connResetError())
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const promise = callGroomerLLM(baseOptions);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries a retryable 5xx and succeeds on a later attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(serverError(503))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const promise = callGroomerLLM(baseOptions);
    await vi.advanceTimersByTimeAsync(5000);
    const result: any = await promise;

    expect(result.lane.id).toBe("local");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not retry a non-retryable 4xx and fails immediately", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(serverError(400));
    vi.stubGlobal("fetch", fetchMock);

    const promise = callGroomerLLM(baseOptions);
    promise.catch(() => {}); // avoid an unhandled rejection while timers advance
    // 5000ms is well past the 500ms first-retry backoff, so if a 400 were
    // (wrongly) retried we'd see a third fetch by now.
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).rejects.toThrow(/400/);

    // A 400 is a real client error — no retry. The only two fetches are the
    // initial json_schema call and the deliberate json_object fallback (which
    // is a downgrade, not a retry); a retry would push this past 2.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("exhausts the retry cap and still fails when every attempt drops", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(socketDropError());
    vi.stubGlobal("fetch", fetchMock);

    const promise = callGroomerLLM(baseOptions);
    promise.catch(() => {}); // avoid an unhandled rejection while timers advance
    await vi.advanceTimersByTimeAsync(60000);
    await expect(promise).rejects.toThrow(/fetch failed/);

    // Bounded: 3 total attempts (1 initial + 2 retries), then it gives up.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not retry a non-transient fetch error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    const promise = callGroomerLLM(baseOptions);
    promise.catch(() => {}); // avoid an unhandled rejection while timers advance
    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).rejects.toThrow(/network error/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

describe("buildGroomerResponseSchema", () => {
  it("is the GroomingPlan schema: sections required, extras forbidden, lanes from config", () => {
    const schema = buildGroomerResponseSchema() as any;
    expect(schema.required).toEqual(["verdict", "implementationBrief", "mutations", "decomposition", "relatedWork"]);
    expect(schema.additionalProperties).toBe(false);
    const lane = schema.properties.verdict.properties.lane;
    expect(lane.required).toEqual(["id", "confidence", "reason"]);
    expect(lane.properties.id.enum).toEqual(getLaneIds());
    expect(lane.properties.id.enum.length).toBeGreaterThan(0);
  });

  it("enum-constrains label arrays to the plan allowlist", () => {
    const schema = buildGroomerResponseSchema() as any;
    const mutations = schema.properties.mutations.properties;
    expect(mutations.labelsToAdd.items.enum).toEqual([...PLAN_LABELS]);
    expect(mutations.labelsToRemove.items.enum).toEqual([...PLAN_LABELS]);
    // The exact failure seen in prod: a 4B inventing "type/refactor".
    expect(mutations.labelsToAdd.items.enum).not.toContain("type/refactor");
  });

  it("bounds proposedTitle to 10-200 chars (or null) and proposedBody to 9999", () => {
    const schema = buildGroomerResponseSchema() as any;
    const mutations = schema.properties.mutations.properties;
    expect(mutations.proposedTitle.anyOf).toEqual([
      { type: "null" },
      { type: "string", minLength: 10, maxLength: 200 },
    ]);
    expect(mutations.proposedBody.anyOf).toEqual([{ type: "null" }, { type: "string", minLength: 1, maxLength: 9999 }]);
  });

  it("constrains evidence ids to the catalog it is given", () => {
    const schema = buildGroomerResponseSchema(catalog) as any;
    expect(schema.properties.verdict.properties.evidenceRefs.items.enum).toEqual(["issue", "repo:src/lib/prisma.ts"]);
  });
});

describe("callGroomerLLM response_format", () => {
  beforeEach(() => vi.restoreAllMocks());

  const okContent = () =>
    `{"verdict":{"lane":{"id":"${getLaneIds()[0]}","confidence":"high","reason":"r"}}}`;

  it("sends json_schema (name + dynamic lane enum) on the first attempt", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: okContent() } }] }) });
    await callGroomerLLM({ baseUrl: "https://llm.example.com", apiKey: "k", model: "vision", prompt: "p", timeoutMs: 1000 });
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("grooming_plan");
    expect(body.response_format.json_schema.schema.properties.verdict.properties.lane.properties.id.enum).toEqual(getLaneIds());
  });

  it("falls back to json_object when the backend rejects json_schema (400)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "unsupported response_format" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: okContent() } }] }) });
    global.fetch = fetchMock as any;
    const result: any = await callGroomerLLM({ baseUrl: "https://llm.example.com", apiKey: "k", model: "vision", prompt: "p", timeoutMs: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).response_format.type).toBe("json_schema");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).response_format.type).toBe("json_object");
    expect(result.verdict.lane.confidence).toBe("high");
  });

  it("omits response_format entirely when responseFormat is false", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: okContent() } }] }) });
    global.fetch = fetchMock as any;
    const result: any = await callGroomerLLM({ baseUrl: "https://llm.example.com", apiKey: "k", model: "vision", prompt: "p", timeoutMs: 1000, responseFormat: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("response_format");
    expect(result.verdict.lane.confidence).toBe("high");
  });
});

describe("callGroomerLLM exploration findings", () => {
  const baseOptions = {
    baseUrl: "https://llm.example.com/v1",
    apiKey: "sk-test",
    model: "local-pool",
    prompt: "Issue #899: sslmode=no-verify does not turn TLS on",
    timeoutMs: 60_000,
  };

  function okResponse() {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ labelsToAdd: [], labelsToRemove: [], lane: { id: "local", confidence: "high", reason: "r" } }) } }],
      }),
      text: async () => "",
    };
  }

  function userContentFrom(fetchMock: ReturnType<typeof vi.fn>): string {
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    return body.messages.find((m: { role: string }) => m.role === "user").content;
  }

  it("appends findings to the user turn", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    await callGroomerLLM({
      ...baseOptions,
      explorationFindings: "## Repository investigation\n\nFiles: src/lib/prisma.ts",
    });
    const content = userContentFrom(fetchMock);
    expect(content).toContain("Issue #899");
    expect(content).toContain("src/lib/prisma.ts");
    vi.unstubAllGlobals();
  });

  it("sends the prompt unchanged when there are no findings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    await callGroomerLLM(baseOptions);
    expect(userContentFrom(fetchMock)).toBe(baseOptions.prompt);
    vi.unstubAllGlobals();
  });

  it("ignores whitespace-only findings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    await callGroomerLLM({ ...baseOptions, explorationFindings: "   \n  " });
    expect(userContentFrom(fetchMock)).toBe(baseOptions.prompt);
    vi.unstubAllGlobals();
  });

  it("appends the evidence catalog and constrains evidence ids to it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    await callGroomerLLM({ ...baseOptions, explorationFindings: "findings", evidenceCatalog: catalog });
    const content = userContentFrom(fetchMock);
    expect(content.indexOf("findings")).toBeLessThan(content.indexOf("## Evidence you can cite"));
    expect(content).toContain("- repo:src/lib/prisma.ts");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.response_format.json_schema.schema.properties.verdict.properties.evidenceRefs.items.enum).toEqual([
      "issue",
      "repo:src/lib/prisma.ts",
    ]);
    vi.unstubAllGlobals();
  });

  it("still constrains the final call with the response schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    await callGroomerLLM({ ...baseOptions, explorationFindings: "findings" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.tools).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("callGroomerLLM findings cap", () => {
  function okResponse2() {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ labelsToAdd: [], labelsToRemove: [], lane: { id: "local", confidence: "high", reason: "r" } }) } }],
      }),
      text: async () => "",
    };
  }

  it("truncates findings past the byte cap so the final call stays bounded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse2());
    vi.stubGlobal("fetch", fetchMock);
    await callGroomerLLM({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "sk-test",
      model: "local-pool",
      prompt: "issue",
      timeoutMs: 60_000,
      explorationFindings: "z".repeat(50_000),
      maxFindingsBytes: 1000,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const content = body.messages.find((m: { role: string }) => m.role === "user").content;
    expect(content).toContain("(findings truncated)");
    expect(content.length).toBeLessThan(2000);
    vi.unstubAllGlobals();
  });
});

describe("callGroomerLLM repair turn (dispatch#1126)", () => {
  const baseOptions = {
    baseUrl: "https://llm.example.com/v1",
    apiKey: "sk-test",
    model: "local-pool",
    prompt: "Issue #1126: groomer plans fail on reference formats",
    timeoutMs: 60_000,
  };

  function respondWith(content: string) {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => "",
    });
  }

  it("keeps the whole answer on a parse failure, with the short message history already records", async () => {
    const answer = `Let me read the key files first. <tool_call>{"name":"read_file"}</tool_call> ${"x".repeat(400)}`;
    vi.stubGlobal("fetch", respondWith(answer));
    const err = await callGroomerLLM(baseOptions).catch((e: unknown) => e);
    vi.unstubAllGlobals();

    expect(err).toBeInstanceOf(GroomerOutputParseError);
    expect((err as GroomerOutputParseError).content).toBe(answer);
    expect((err as Error).message).toBe(`Failed to parse LLM response as JSON: ${answer.slice(0, 200)}`);
  });

  it("sends the previous answer as an assistant turn and the errors as a user turn", async () => {
    const fetchMock = respondWith("{}");
    vi.stubGlobal("fetch", fetchMock);
    await callGroomerLLM({
      ...baseOptions,
      evidenceCatalog: catalog,
      repair: {
        previousResponse: '{"relatedWork":[{"ref":"comment:9"}]}',
        errors: ['relatedWork[0].ref: "comment:9" must be a related-work evidence reference'],
      },
    });
    vi.unstubAllGlobals();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(body.messages[1].content).toContain("Issue #1126");
    expect(body.messages[2].content).toBe('{"relatedWork":[{"ref":"comment:9"}]}');
    const repair = body.messages[3].content;
    expect(repair).toContain('- relatedWork[0].ref: "comment:9" must be a related-work evidence reference');
    expect(repair).toContain("No tools are available in this turn");
    expect(repair).toContain('related-work ids ("github:...")');
    // The repair is still schema-constrained to this run's catalog.
    expect(body.response_format?.type).toBe("json_schema");
  });

  it("bounds a runaway previous answer", async () => {
    const fetchMock = respondWith("{}");
    vi.stubGlobal("fetch", fetchMock);
    await callGroomerLLM({ ...baseOptions, repair: { previousResponse: "y".repeat(MAX_REPAIR_ECHO_BYTES * 2), errors: ["e"] } });
    vi.unstubAllGlobals();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[2].content.length).toBeLessThan(MAX_REPAIR_ECHO_BYTES + 32);
    expect(body.messages[2].content).toMatch(/… \(truncated\)$/);
  });
});
