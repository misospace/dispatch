import { describe, expect, it, vi, beforeEach } from "vitest";
import { callGroomerLLM } from "./llm";

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
    expect(capturedBody.response_format?.type).toBe("json_object");
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
