import { describe, expect, it, vi } from "vitest";
import { RelatedWorkNotFoundError } from "@/lib/github-related-work";
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
      fetchRelatedIssue: vi.fn().mockResolvedValue({}),
      fetchRelatedPullRequest: vi.fn().mockResolvedValue({}),
      fetchRelatedCommit: vi.fn().mockResolvedValue({}),
      searchRelatedWork: vi.fn().mockResolvedValue([]),
      fetchPullRequestClosingIssues: vi.fn().mockResolvedValue({ issues: [], truncated: false }),
      ...overrides,
    },
    fetchImpl: fetchImpl ?? fetchReturning({ content: "done", tool_calls: [] }),
  };
}

describe("exploreRepository", () => {
  it("strips NUL and C0 control characters from model-authored tool arguments (dispatch#1130)", async () => {
    // Tool-call arguments are model-authored and flow into persisted columns:
    // submitted findings into contextSummary (jsonb) and the search query behind
    // Issue.groomedSearchCodeQueries (text[]). A NUL must not reach either, so
    // they are stripped at the single ingestion point (parseArguments).
    const CONTROL = /[\u0000-\u0008\u000B-\u001F]/;
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "search_code", { query: "missing\u0000 symbol\u0007" })] },
      {
        content: null,
        tool_calls: [
          toolCall("2", "submit_findings", {
            files: ["src/auth/login.ts\u0000"],
            ask: "why\u0000 does login drop the return URL?",
            notes: "seen\u0001 already",
          }),
        ],
      },
    );
    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue([]) }, fetchImpl);

    const result = await exploreRepository(options, deps);

    expect(result.ask).toBe("why does login drop the return URL?");
    expect(result.files).toEqual(["src/auth/login.ts"]);
    const searchCall = result.toolCalls.find((c) => c.name === "search_code");
    expect(searchCall?.arguments).toEqual({ query: "missing symbol" });
    expect(result.ask).not.toMatch(CONTROL);
    expect(result.files.every((f) => !CONTROL.test(f))).toBe(true);
    expect(result.findings).not.toMatch(CONTROL);
  });

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
    // The broken investigation is named for the plan stage (dispatch#1452).
    expect(result.findings).toContain("the exploration backend was unavailable");
    expect(result.warnings[0]).toContain("repository exploration unavailable (400)");
  });

  it("never throws when the transport fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
    const result = await exploreRepository(options, makeDeps({}, fetchImpl));
    // The broken investigation is named for the plan stage (dispatch#1452).
    expect(result.findings).toContain("the exploration was aborted");
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

  it("records related-work queries and refs from the related-work tools", async () => {
    const fetchImpl = fetchReturning(
      {
        content: null,
        tool_calls: [
          toolCall("1", "read_related_pr", { number: 12 }),
          toolCall("2", "read_related_commit", { ref: "abc123" }),
        ],
      },
      {
        content: null,
        tool_calls: [toolCall("3", "search_related_work", { query: "sslmode" })],
      },
      {
        content: null,
        tool_calls: [
          toolCall("4", "submit_findings", {
            files: ["src/lib/prisma.ts"],
            ask: "Map libpq sslmode onto the pg driver's ssl option.",
          }),
        ],
      },
    );
    const deps = makeDeps(
      {
        fetchRelatedPullRequest: vi
          .fn()
          .mockResolvedValue({ number: 12, state: "merged", evidenceKey: "github:pr:org/repo#12" }),
        fetchRelatedCommit: vi
          .fn()
          .mockResolvedValue({ sha: "abc123", message: "Fix ssl", evidenceKey: "github:commit:org/repo@abc123" }),
        searchRelatedWork: vi
          .fn()
          .mockResolvedValue([{ evidenceKey: "github:issue:org/repo#101", title: "Original report" }]),
      },
      fetchImpl,
    );

    const result = await exploreRepository(options, deps);

    expect(result.relatedWorkQueries).toEqual(["sslmode"]);
    // Successful reads record the tool result's evidence keys, so a PR
    // number read via read_related_pr is a pull_request ref, not an issue ref.
    expect(result.relatedWorkRefs).toEqual([
      "github:pr:org/repo#12",
      "github:commit:org/repo@abc123",
      "github:issue:org/repo#101",
    ]);
    expect(result.relatedWork.map((o) => [o.key, o.kind, o.state, o.via])).toEqual([
      ["github:pr:org/repo#12", "pull_request", "merged", "read"],
      ["github:commit:org/repo@abc123", "commit", null, "read"],
      ["github:issue:org/repo#101", "issue", null, "search"],
    ]);
    // Related-work keys never leak into the repository source list, which the
    // evidence snapshot pins to the run's head SHA.
    expect(result.sources).toEqual(["src/lib/prisma.ts"]);
  });

  it("separates files actually read from search hits and submitted paths (dispatch#1062)", async () => {
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "search_code", { query: "PrismaPg" })] },
      { content: null, tool_calls: [toolCall("2", "read_file", { path: "src/lib/prisma.ts" })] },
      { content: null, tool_calls: [toolCall("3", "submit_findings", { files: ["src/lib/db.ts"], ask: "a" })] },
    );
    const deps = makeDeps(
      {
        searchCode: vi.fn().mockResolvedValue([{ path: "src/lib/prisma.ts" }, { path: "src/lib/other.ts" }]),
        readFile: vi.fn().mockResolvedValue("const adapter = new PrismaPg(url);"),
      },
      fetchImpl,
    );

    const result = await exploreRepository(options, deps);

    expect(result.sources).toEqual(["src/lib/prisma.ts", "src/lib/other.ts", "src/lib/db.ts"]);
    expect(result.readSources).toEqual(["src/lib/prisma.ts"]);
    // What the read showed the model, for close-excerpt checks (dispatch#1099).
    expect(result.readContents).toEqual([{ path: "src/lib/prisma.ts", ref: null, content: "const adapter = new PrismaPg(url);" }]);
  });

  it("never spends more than the exploration total byte budget (dispatch#1451)", async () => {
    // A ranged read charges its coordinates header and continuation footer to
    // the same budget as its content, so no answer can push the run past the
    // total budget it was given.
    const fetchImpl = fetchReturning(
      {
        content: null,
        tool_calls: [toolCall("1", "read_file", { path: "big.ts", startLine: 1, lineCount: 100 })],
      },
      {
        content: null,
        tool_calls: [toolCall("2", "read_file", { path: "big.ts", startLine: 101, lineCount: 100 })],
      },
    );
    const deps = makeDeps(
      { readFile: vi.fn().mockResolvedValue(Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n")) },
      fetchImpl,
    );

    const result = await exploreRepository({ ...options, maxTotalBytes: 1000, maxRounds: 4 }, deps);

    expect(result.bytes).toBeLessThanOrEqual(1000);
    expect(result.warnings).toContain("repository exploration hit its byte budget");
  });

  it("never spends more than the exploration total when a search fails late (dispatch#1451)", async () => {
    // A failed search answers with a bounded fallback; that answer is charged
    // against what is left of the run's byte budget, so a search failure after
    // earlier reads cannot push the run past its total.
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "read_file", { path: "big.ts" })] },
      { content: null, tool_calls: [toolCall("2", "search_code", { query: "enrich" })] },
    );
    const deps = makeDeps(
      {
        readFile: vi.fn().mockResolvedValue("y".repeat(400)),
        searchCode: vi.fn().mockRejectedValue(new Error("Code search failed for org/repo: 502")),
      },
      fetchImpl,
    );

    const result = await exploreRepository({ ...options, maxTotalBytes: 500, maxRounds: 4 }, deps);

    expect(result.bytes).toBeLessThanOrEqual(500);
    const search = result.toolCalls.find((call) => call.name === "search_code");
    expect(search?.ok).toBe(false);
    // The fallback was clamped to what the run had left, and still says the
    // search was an outage rather than an absence.
    expect(search?.preview).toContain("not evidence the code is missing");
    expect(search?.preview).not.toContain("list_directory");
  });

  it("charges empty-file answers to the exploration byte budget (dispatch#1451)", async () => {
    // An empty file answers with named, bounded content — model-visible, so
    // it consumes the run's budget like every other answer. Repeated reads
    // must decrease what is left, or they emit content for free.
    const fetchImpl = fetchReturning({
      content: null,
      tool_calls: [toolCall("1", "read_file", { path: "ghost.ts" })],
    });
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("") }, fetchImpl);

    const result = await exploreRepository({ ...options, maxTotalBytes: 100, maxRounds: 4 }, deps);

    const reads = result.toolCalls.filter((call) => call.name === "read_file");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.ok).toBe(true);
      // Charged in full: every byte the model saw is what the record reports.
      expect(read.bytes).toBe(Buffer.byteLength(read.preview, "utf8"));
    }
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.bytes).toBeLessThanOrEqual(100);
    // The budget really ran out: the charged answers exhausted it.
    expect(result.warnings).toContain("repository exploration hit its byte budget");
  });

  it("never spends more than the exploration total when a search succeeds late (dispatch#1451)", async () => {
    // A successful search renders its match list; that answer is charged
    // against what is left of the run's byte budget, so a search after earlier
    // reads cannot push the run past its total.
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "read_file", { path: "big.ts" })] },
      { content: null, tool_calls: [toolCall("2", "search_code", { query: "enrich" })] },
    );
    const deps = makeDeps(
      {
        readFile: vi.fn().mockResolvedValue("y".repeat(400)),
        searchCode: vi.fn().mockResolvedValue(
          Array.from({ length: 10 }, (_, i) => ({ path: `src/lib/deeply/nested/module-${i}.ts` })),
        ),
      },
      fetchImpl,
    );

    const result = await exploreRepository({ ...options, maxTotalBytes: 500, maxRounds: 4 }, deps);

    expect(result.bytes).toBeLessThanOrEqual(500);
    const search = result.toolCalls.find((call) => call.name === "search_code");
    expect(search?.ok).toBe(true);
    // The match list was clamped to what the run had left.
    expect(search?.bytes).toBeLessThanOrEqual(500 - result.toolCalls[0].bytes);
  });

  it("counts related-work bytes against the exploration byte budget", async () => {
    const big = { evidenceKey: "issue:org/repo#1", body: "x".repeat(300) };
    const fetchImpl = fetchReturning({
      content: null,
      tool_calls: [toolCall("1", "search_related_work", { query: "loop" })],
    });
    const deps = makeDeps({ searchRelatedWork: vi.fn().mockResolvedValue([big]) }, fetchImpl);

    const result = await exploreRepository({ ...options, maxTotalBytes: 100, maxRounds: 4 }, deps);

    expect(result.warnings).toContain("repository exploration hit its byte budget");
    expect(deps.tools.searchRelatedWork).toHaveBeenCalledTimes(1);
  });

  it("counts a related-work round against the round budget", async () => {
    const fetchImpl = fetchReturning({
      content: null,
      tool_calls: [toolCall("1", "search_related_work", { query: "loop" })],
    });
    const deps = makeDeps({ searchRelatedWork: vi.fn().mockResolvedValue([]) }, fetchImpl);

    const result = await exploreRepository({ ...options, maxRounds: 3 }, deps);

    expect(result.toolCalls).toHaveLength(3);
    expect(result.warnings).toContain(
      "repository exploration used all its rounds without submitting findings",
    );
  });

  it("surfaces a related-work not-found warning on the exploration result", async () => {
    const notFound = new RelatedWorkNotFoundError("issue", "org/repo#99");
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "read_related_issue", { number: 99 })] },
      { content: "done", tool_calls: [] },
    );
    const deps = makeDeps({ fetchRelatedIssue: vi.fn().mockRejectedValue(notFound) }, fetchImpl);

    const result = await exploreRepository(options, deps);

    expect(result.warnings).toContain("related-work: not found issue org/repo#99");
    // A not-found lookup returns ok:true with {found:false} content and empty
    // sources, so it records no ref.
    expect(result.relatedWorkRefs).toEqual([]);
    expect(result.relatedWork).toEqual([]);
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

describe("exploreRepository pinned ref", () => {
  it("pins file reads to the snapshot SHA, ignoring a conflicting model-supplied ref", async () => {
    const fetchImpl = fetchReturning(
      {
        content: null,
        tool_calls: [
          toolCall("1", "read_file", { path: "src/lib/prisma.ts", ref: "refs/heads/other" }),
        ],
      },
      { content: "done", tool_calls: [] },
    );
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("code") }, fetchImpl);

    await exploreRepository({ ...options, pinnedRef: "deadbeef" }, deps);

    expect(deps.tools.readFile).toHaveBeenCalledWith("org/repo", "src/lib/prisma.ts", "deadbeef");
  });

  it("records each read's content at the pinned ref, even when the model never submits", async () => {
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "read_file", { path: "src/a.ts" }), toolCall("2", "read_file", { path: "missing.ts" })] },
      { content: "done", tool_calls: [] },
    );
    const readFile = vi.fn().mockImplementation(async (_repo: string, path: string) => (path === "src/a.ts" ? "export const a = 1;" : ""));
    const deps = makeDeps({ readFile }, fetchImpl);

    const result = await exploreRepository({ ...options, pinnedRef: "deadbeef" }, deps);

    expect(result.readContents).toEqual([{ path: "src/a.ts", ref: "deadbeef", content: "export const a = 1;" }]);
  });
});

describe("exploreRepository investigation gaps (dispatch#1452)", () => {
  it("reports clean gaps when the investigation completes", async () => {
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "read_file", { path: "src/a.ts" })] },
      { content: null, tool_calls: [toolCall("2", "submit_findings", { files: ["src/a.ts"], ask: "do the thing" })] },
    );
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("code") }, fetchImpl);

    const result = await exploreRepository(options, deps);

    expect(result.gaps).toEqual({
      explorationRan: true,
      toolFailures: [],
      truncatedReads: [],
      budgetExhausted: false,
      roundsExhausted: false,
      aborted: false,
      unavailable: false,
    });
    expect(result.toolCalls[0].truncated).toBe(false);
    expect(result.toolCalls[1].truncated).toBe(false);
    expect(result.findings).not.toContain("## Investigation gaps");
  });

  it("does not report exhausted rounds when the model submits on the final round", async () => {
    // The last round is the one the model is told to wrap up on, and it is
    // also the round the loop is allowed to end on. A submission there is a
    // completed investigation: no fact may turn it into an incomplete one
    // (dispatch#1452), or a clean human question would be misread as a
    // broken investigation.
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "search_code", { query: "x" })] },
      { content: null, tool_calls: [toolCall("2", "submit_findings", { files: ["src/a.ts"], ask: "do the thing" })] },
    );
    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue([{ path: "a.ts" }]) }, fetchImpl);

    const result = await exploreRepository({ ...options, maxRounds: 2 }, deps);

    expect(result.ask).toBe("do the thing");
    expect(result.gaps.roundsExhausted).toBe(false);
    expect(result.gaps.toolFailures).toEqual([]);
    expect(result.gaps.budgetExhausted).toBe(false);
    expect(result.findings).not.toContain("## Investigation gaps");
  });

  it("names a failed tool call in the gaps and in the findings", async () => {
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "read_file", { path: "missing.ts" })] },
      { content: "done", tool_calls: [] },
    );
    const deps = makeDeps({ readFile: vi.fn().mockRejectedValue(new Error("404 Not Found")) }, fetchImpl);

    const result = await exploreRepository(options, deps);

    expect(result.gaps.toolFailures).toEqual(["read_file"]);
    expect(result.gaps.truncatedReads).toEqual([]);
    expect(result.toolCalls[0].truncated).toBe(false);
    expect(result.findings).toContain("## Investigation gaps");
    expect(result.findings).toContain("- read_file failed");
  });

  it("names a truncated read in the gaps, the record and the findings", async () => {
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "read_file", { path: "src/big.ts" })] },
      { content: "done", tool_calls: [] },
    );
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("y".repeat(500)) }, fetchImpl);

    const result = await exploreRepository({ ...options, maxFileBytes: 100 }, deps);

    expect(result.gaps.truncatedReads).toEqual(["src/big.ts"]);
    expect(result.gaps.toolFailures).toEqual([]);
    expect(result.toolCalls[0].truncated).toBe(true);
    expect(result.findings).toContain("- the read of src/big.ts was truncated");
  });

  it("a continuation that reaches EOF retires the truncated-read gap (dispatch#1451)", async () => {
    // 11 one-byte lines (22 bytes): with maxFileBytes 10 the head read shows
    // its head and names the continuation line, the next read is truncated
    // again, and the last one reaches the end of the file.
    const body = "y\n".repeat(11);
    const deps = makeDeps(
      { readFile: vi.fn().mockResolvedValue(body) },
      fetchReturning(
        { content: null, tool_calls: [toolCall("1", "read_file", { path: "src/big.ts" })] },
        {
          content: null,
          tool_calls: [
            toolCall("2", "read_file", { path: "src/big.ts", startLine: 6 }),
            toolCall("3", "read_file", { path: "src/big.ts", startLine: 11 }),
            toolCall("4", "submit_findings", { files: ["src/big.ts"], ask: "do the thing" }),
          ],
        },
      ),
    );

    const result = await exploreRepository({ ...options, maxFileBytes: 10 }, deps);

    // The continuation reached the end of the file: the run did establish
    // what the file holds, so the stale truncation fact is retired and the
    // findings must not name the read as truncated.
    expect(result.gaps.truncatedReads).toEqual([]);
    expect(result.toolCalls[0].truncated).toBe(true);
    expect(result.toolCalls[1].truncated).toBe(true);
    expect(result.toolCalls[2].truncated).toBe(false);
    expect(result.findings).not.toContain("was truncated");
  });

  it("flags an exhausted byte budget in the gaps and the findings", async () => {
    const fetchImpl = fetchReturning({
      content: null,
      tool_calls: [toolCall("1", "read_file", { path: "a.ts" })],
    });
    const deps = makeDeps({ readFile: vi.fn().mockResolvedValue("y".repeat(400)) }, fetchImpl);

    const result = await exploreRepository({ ...options, maxTotalBytes: 100, maxRounds: 4 }, deps);

    expect(result.gaps.budgetExhausted).toBe(true);
    expect(result.gaps.roundsExhausted).toBe(true);
    expect(result.findings).toContain("the byte budget ended this investigation");
  });

  it("flags exhausted rounds in the gaps and the findings", async () => {
    const fetchImpl = fetchReturning({
      content: null,
      tool_calls: [toolCall("1", "search_code", { query: "loop" })],
    });
    const deps = makeDeps({ searchCode: vi.fn().mockResolvedValue([{ path: "a.ts" }]) }, fetchImpl);

    const result = await exploreRepository({ ...options, maxRounds: 3 }, deps);

    expect(result.gaps.roundsExhausted).toBe(true);
    expect(result.gaps.budgetExhausted).toBe(false);
    expect(result.findings).toContain("all rounds were used without submitted findings");
  });

  it("flags an unavailable backend in the gaps and the findings", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => "tools not supported",
    }) as unknown as typeof fetch;
    const result = await exploreRepository(options, makeDeps({}, fetchImpl));

    expect(result.gaps.unavailable).toBe(true);
    expect(result.gaps.aborted).toBe(false);
    expect(result.findings).toContain("the exploration backend was unavailable");
  });

  it("flags an aborted exploration in the gaps and the findings", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const fetchImpl = vi.fn().mockRejectedValue(abort) as unknown as typeof fetch;
    const result = await exploreRepository(options, makeDeps({}, fetchImpl));

    expect(result.gaps.aborted).toBe(true);
    expect(result.findings).toContain("the exploration was aborted");
  });

  it("sanitizes and bounds the model-authored tool name entering the gap facts (dispatch#1452)", async () => {
    const nasty = `search\u0000code${"\u0001".repeat(3)}${"x".repeat(200)}`;
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", nasty, {})] },
      { content: "done", tool_calls: [] },
    );
    const result = await exploreRepository(options, makeDeps({}, fetchImpl));

    expect(result.gaps.toolFailures).toHaveLength(1);
    const [token] = result.gaps.toolFailures;
    expect(token).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);    // clampText keeps `max` characters plus a trailing ellipsis.
    expect(token.length).toBeLessThanOrEqual(81);
    expect(token.startsWith("searchcode")).toBe(true);
  });

  it("keeps a tool failure whose model-authored name sanitizes to nothing, under a fixed token", async () => {
    // The call did fail: that is the fact the verdict is resolved against.
    // The model-authored name cannot be persisted, so the failure is recorded
    // under a fixed token instead of being dropped (dispatch#1452).
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "\u0000\u0001", {})] },
      { content: "done", tool_calls: [] },
    );
    const result = await exploreRepository(options, makeDeps({}, fetchImpl));

    expect(result.gaps.toolFailures).toEqual(["unknown_tool"]);
  });

  it("records a clipped directory listing as a truncated read", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ path: `src/f${i}.ts`, type: "file" as const, size: 1 }));
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "list_directory", { path: "src" })] },
      { content: "done", tool_calls: [] },
    );
    const deps = makeDeps({ listDir: vi.fn().mockResolvedValue(entries) }, fetchImpl);

    const result = await exploreRepository({ ...options, maxDirEntries: 2 }, deps);

    expect(result.gaps.truncatedReads).toEqual(["src"]);
    expect(result.gaps.toolFailures).toEqual([]);
    expect(result.toolCalls[0].truncated).toBe(true);
    expect(result.findings).toContain("- the read of src was truncated");
  });

  it("names the repository root when its listing was clipped", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ path: `d${i}/`, type: "dir" as const, size: null }));
    const fetchImpl = fetchReturning(
      { content: null, tool_calls: [toolCall("1", "list_directory", { path: "" })] },
      { content: "done", tool_calls: [] },
    );
    const deps = makeDeps({ listDir: vi.fn().mockResolvedValue(entries) }, fetchImpl);

    const result = await exploreRepository({ ...options, maxDirEntries: 2 }, deps);

    expect(result.gaps.truncatedReads).toEqual(["the repository root"]);
    expect(result.findings).toContain("- the read of the repository root was truncated");
  });
});
