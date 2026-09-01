import { describe, expect, it, vi, beforeEach } from "vitest";
import { callGroomerLLM, buildGroomerResponseSchema } from "./llm";
import { ALLOWED_GROOMER_LABELS } from "./schema";
import { getLaneIds } from "@/lib/lane-config";

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

    const result = await callGroomerLLM({
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

    const result = await callGroomerLLM({
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

    const result = await callGroomerLLM({
      baseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      prompt: "test",
      timeoutMs: 10000,
    });

    expect(result.lane.id).toBe("local");
  });
});

describe("buildGroomerResponseSchema", () => {
  it("requires lane/labels, forbids extra props, and constrains lane.id to configured lanes", () => {
    const schema = buildGroomerResponseSchema() as any;
    expect(schema.required).toEqual(expect.arrayContaining(["labelsToAdd", "labelsToRemove", "lane"]));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.lane.required).toEqual(["id", "confidence", "reason"]);
    const laneId = schema.properties.lane.properties.id;
    expect(laneId.enum).toEqual(getLaneIds());
    expect(laneId.enum.length).toBeGreaterThan(0);
  });

  it("enum-constrains label arrays to the validator's allowlist", () => {
    const schema = buildGroomerResponseSchema() as any;
    expect(schema.properties.labelsToAdd.items.enum).toEqual([...ALLOWED_GROOMER_LABELS]);
    expect(schema.properties.labelsToRemove.items.enum).toEqual([...ALLOWED_GROOMER_LABELS]);
    // The exact failure seen in prod: a 4B inventing "type/refactor".
    expect(schema.properties.labelsToAdd.items.enum).not.toContain("type/refactor");
  });

  it("bounds proposedTitle to the validator's 10-200 chars (or null)", () => {
    const schema = buildGroomerResponseSchema() as any;
    const title = schema.properties.proposedTitle;
    expect(title.anyOf).toEqual([
      { type: "null" },
      { type: "string", minLength: 10, maxLength: 200 },
    ]);
    const body = schema.properties.proposedBody;
    expect(body.anyOf).toEqual([{ type: "null" }, { type: "string", maxLength: 9999 }]);
  });
});

describe("callGroomerLLM response_format", () => {
  beforeEach(() => vi.restoreAllMocks());

  const okContent = () =>
    `{"labelsToAdd":[],"labelsToRemove":[],"lane":{"id":"${getLaneIds()[0]}","confidence":"high","reason":"r"}}`;

  it("sends json_schema (name + dynamic lane enum) on the first attempt", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: okContent() } }] }) });
    await callGroomerLLM({ baseUrl: "https://llm.example.com", apiKey: "k", model: "vision", prompt: "p", timeoutMs: 1000 });
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("groomer_output");
    expect(body.response_format.json_schema.schema.properties.lane.properties.id.enum).toEqual(getLaneIds());
  });

  it("falls back to json_object when the backend rejects json_schema (400)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "unsupported response_format" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: okContent() } }] }) });
    global.fetch = fetchMock as any;
    const result = await callGroomerLLM({ baseUrl: "https://llm.example.com", apiKey: "k", model: "vision", prompt: "p", timeoutMs: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).response_format.type).toBe("json_schema");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).response_format.type).toBe("json_object");
    expect(result.lane.confidence).toBe("high");
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
