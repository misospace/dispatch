import { describe, expect, it, vi } from "vitest";
import { exploreRepository, type ExploreDeps, type ExploreOptions } from "./explore";

const options: ExploreOptions = {
  baseUrl: "https://llm.example.com/v1",
  apiKey: "sk-test",
  model: "local-pool",
  repoFullName: "org/repo",
  prompt: "Issue #899: DATABASE_URL with sslmode=no-verify does not turn TLS on",
  timeoutMs: 60_000,
  maxRounds: 12,
  maxTotalBytes: 8192,
  maxSearchResults: 10,
  maxFileBytes: 4096,
  maxDirEntries: 60,
};

function toolCall(id: string, name: string, args: unknown) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** Build a fetch that returns each queued assistant message in turn. */
function fetchReturning(...messages: unknown[]): typeof fetch {
  let i = 0;
  return vi.fn().mockImplementation(async () => {
    const message = messages[Math.min(i, messages.length - 1)];
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message }] }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;
}

function makeDeps(overrides: Partial<ExploreDeps["tools"]> = {}, fetchImpl?: typeof fetch): ExploreDeps {
  return {
    tools: {
      searchCode: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue(""),
      listDir: vi.fn().mockResolvedValue([]),
      ...overrides,
    },
    fetchImpl: fetchImpl ?? fetchReturning({ content: "done", tool_calls: [] }),
  };
}

describe("exploreRepository", () => {
  it("runs the tools the model asks for, then returns its submitted findings", async () => {
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "search_code", { query: "PrismaPg" })] },
      { content: null, tool_calls: [toolCall("2", "read_file", { path: "src/lib/prisma.ts" })] },
      {
        content: null,
        tool_calls: [
          toolCall("3", "submit_findings", {
            files: ["src/lib/prisma.ts"],
            ask: "Map libpq sslmode onto the pg driver's ssl option.",
            notes: "PrismaPg is constructed with the bare URL.",
          }),
        ],
      },
    );
    const deps = makeDeps(
      {
        searchCode: vi.fn().mockResolvedValue([{ path: "src/lib/prisma.ts" }]),
        readFile: vi.fn().mockResolvedValue("const adapter = new PrismaPg(url);"),
      },
      fetchImpl,
    );

    const result = await exploreRepository(options, deps);

    expect(result.files).toEqual(["src/lib/prisma.ts"]);
    expect(result.ask).toContain("sslmode");
    expect(result.findings).toContain("src/lib/prisma.ts");
    expect(result.findings).toContain("What the issue is asking for");
    expect(result.toolCalls.map((c) => c.name)).toEqual([
      "search_code",
      "read_file",
      "submit_findings",
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("stops when the model answers in prose instead of calling a tool", async () => {
    const deps = makeDeps({}, fetchReturning({ content: "I have no tools to call.", tool_calls: [] }));
    const result = await exploreRepository(options, deps);
    expect(result.toolCalls).toEqual([]);
    expect(result.findings).toBe("");
  });

  it("degrades to a warning when the backend rejects tool calling", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => "tools not supported",
    }) as unknown as typeof fetch;
    const result = await exploreRepository(options, makeDeps({}, fetchImpl));
    expect(result.findings).toBe("");
    expect(result.warnings[0]).toContain("repository exploration unavailable (400)");
  });

  it("never throws when the transport fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
    const result = await exploreRepository(options, makeDeps({}, fetchImpl));
    expect(result.findings).toBe("");
    expect(result.warnings[0]).toContain("ECONNRESET");
  });

  it("reports an abort against the configured timeout", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const fetchImpl = vi.fn().mockRejectedValue(abort) as unknown as typeof fetch;
    const result = await exploreRepository(options, makeDeps({}, fetchImpl));
    expect(result.warnings[0]).toContain("aborted after 60000ms");
  });

  it("stops spending tool calls once the byte budget is gone", async () => {
    const fetchImpl = fetchReturning({
      content: null,
      tool_calls: [toolCall("1", "read_file", { path: "a.ts" })],
    });
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("y".repeat(400)) }, fetchImpl);

    const result = await exploreRepository({ ...options, maxTotalBytes: 100, maxRounds: 4 }, deps);

    expect(result.warnings).toContain("repository exploration hit its byte budget");
    expect(deps.tools.readFile).toHaveBeenCalledTimes(1);
  });

  it("stops at the tool-call budget and says so", async () => {
    const fetchImpl = fetchReturning({
      content: null,
      tool_calls: [toolCall("1", "search_code", { query: "loop" })],
    });
    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue([{ path: "a.ts" }]) }, fetchImpl);

    const result = await exploreRepository({ ...options, maxRounds: 3 }, deps);

    expect(result.toolCalls).toHaveLength(3);
    expect(result.warnings).toContain(
      "repository exploration used all its rounds without submitting findings",
    );
  });

  it("keeps the files it read when the model never submits findings", async () => {
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "read_file", { path: "src/lib/prisma.ts" })] },
      { content: "giving up", tool_calls: [] },
    );
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("code") }, fetchImpl);

    const result = await exploreRepository(options, deps);

    expect(result.findings).toContain("Files examined while investigating");
    expect(result.findings).toContain("src/lib/prisma.ts");
  });

  it("survives a tool call with unparseable arguments", async () => {
    const fetchImpl = fetchReturning(
      {
        content: null,
        tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{not json" } }],
      },
      { content: "done", tool_calls: [] },
    );
    const result = await exploreRepository(options, makeDeps({}, fetchImpl));
    expect(result.toolCalls[0].ok).toBe(false);
  });
});

describe("exploreRepository bounds model-supplied findings", () => {
  it("caps the file list, path length, ask and notes", async () => {
    const fetchImpl = fetchReturning({
      content: null,
      tool_calls: [
        toolCall("1", "submit_findings", {
          files: [
            ...Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`),
            "x".repeat(1000),
          ],
          ask: "a".repeat(9000),
          notes: "n".repeat(9000),
        }),
      ],
    });

    const result = await exploreRepository(options, makeDeps({}, fetchImpl));

    expect(result.files).toHaveLength(20);
    expect(result.files.every((f) => f.length <= 301)).toBe(true);
    expect(result.ask!.length).toBeLessThanOrEqual(2001);
    expect(result.findings.length).toBeLessThan(12_000);
  });

  it("drops non-string entries from files", async () => {
    const fetchImpl = fetchReturning({
      content: null,
      tool_calls: [
        toolCall("1", "submit_findings", { files: ["src/a.ts", 42, null, "  "], ask: "do the thing" }),
      ],
    });
    const result = await exploreRepository(options, makeDeps({}, fetchImpl));
    expect(result.files).toEqual(["src/a.ts"]);
  });
});

describe("exploreRepository round-limit warning", () => {
  it("tells the model to submit when it is nearly out of rounds", async () => {
    const calls: string[][] = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body.messages.map((m: { role: string }) => m.role));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            { message: { content: null, tool_calls: [toolCall("1", "search_code", { query: "x" })] } },
          ],
        }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue([{ path: "a.ts" }]) }, fetchImpl);
    await exploreRepository({ ...options, maxRounds: 4 }, deps);

    const sent = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      JSON.parse((c[1] as RequestInit).body as string),
    );
    const nudges = sent.flatMap((b) =>
      b.messages.filter(
        (m: { role: string; content?: string }) =>
          m.role === "user" && typeof m.content === "string" && m.content.includes("round(s) left"),
      ),
    );
    expect(nudges.length).toBeGreaterThan(0);
    expect(nudges[0].content).toContain("submit_findings");
  });

  it("does not nudge before the final rounds", async () => {
    const fetchImpl = fetchReturning({
      content: null,
      tool_calls: [toolCall("1", "search_code", { query: "x" })],
    });
    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue([{ path: "a.ts" }]) }, fetchImpl);
    await exploreRepository({ ...options, maxRounds: 12 }, deps);

    const first = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit)
        .body as string,
    );
    expect(
      first.messages.some(
        (m: { content?: string }) => typeof m.content === "string" && m.content.includes("round(s) left"),
      ),
    ).toBe(false);
  });

  it("does not warn about rounds when the model stopped on its own", async () => {
    const deps = makeDeps({}, fetchReturning({ content: "nothing to do", tool_calls: [] }));
    const result = await exploreRepository({ ...options, maxRounds: 12 }, deps);
    expect(result.warnings).not.toContain(
      "repository exploration used all its rounds without submitting findings",
    );
  });
});
