import { describe, expect, it, vi } from "vitest";
import {
  extractLessonFromFixOutcome,
  lessonAlreadyCovered,
  readConfig,
  type ExtractLessonInput,
  type LessonOutcome,
} from "./lesson-feed";

/**
 * Run `fn` with the given env vars set (or deleted when the value is
 * undefined), restoring the previous values afterwards. Keeps the
 * readConfig precedence tests hermetic regardless of the CI environment.
 */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<unknown>,
): Promise<unknown> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

type PlannedResponse = { verdict: "no_lesson" | "lesson"; text?: string };

interface CallRecord {
  body: any;
  responseFormat: any;
}

function makeFetcher(planned: PlannedResponse, opts: { status?: number } = {}) {
  const calls: CallRecord[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({
      body,
      responseFormat: body.response_format,
    });
    const status = opts.status ?? 200;
    return new Response(
      JSON.stringify({
        id: "fake",
        object: "chat.completion",
        created: 0,
        model: body.model ?? "test",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify({ verdict: planned.verdict, text: planned.text }) },
            finish_reason: "stop",
          },
        ],
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  };
  return { fetcher, calls };
}

const baseInput: ExtractLessonInput = {
  repo: "org/foo",
  reason: "build broken on main",
  feedback: [
    "attempt 1 failed: TypeError in src/baz.ts:42",
    "attempt 2 failed: same TypeError after my fix",
  ],
};

describe("extractLessonFromFixOutcome", () => {
  it("returns no_lesson below the ≥2-attempt threshold without calling the model", async () => {
    const { fetcher, calls } = makeFetcher({ verdict: "no_lesson" });
    const out = await extractLessonFromFixOutcome(
      { ...baseInput, feedback: ["only one failure"] },
      { fetcher, apiKey: "test" },
    );
    expect(out).toEqual({ kind: "no_lesson" } satisfies LessonOutcome);
    expect(calls).toHaveLength(0);
  });

  it("uses json_schema as the primary response_format (groomer pattern)", async () => {
    const { fetcher, calls } = makeFetcher({ verdict: "no_lesson" });
    await extractLessonFromFixOutcome(baseInput, { fetcher, apiKey: "test" });
    expect(calls).toHaveLength(1);
    expect(calls[0].responseFormat?.type).toBe("json_schema");
  });

  it("returns lesson when the model emits verdict=lesson with checkable text", async () => {
    const { fetcher } = makeFetcher({
      verdict: "lesson",
      text: "assert_eq is 2-arg; omitting the name is a parse error that drops the whole test file.",
    });
    const out = await extractLessonFromFixOutcome(baseInput, { fetcher, apiKey: "test" });
    expect(out.kind).toBe("lesson");
    if (out.kind === "lesson") {
      expect(out.text).toMatch(/assert_eq/);
    }
  });

  it("treats verdict=no_lesson from the model as no_lesson (the common case)", async () => {
    const { fetcher } = makeFetcher({ verdict: "no_lesson" });
    const out = await extractLessonFromFixOutcome(baseInput, { fetcher, apiKey: "test" });
    expect(out).toEqual({ kind: "no_lesson" });
  });

  it("rejects empty or overlong lesson text (signal guard)", async () => {
    const first = makeFetcher({ verdict: "lesson", text: "" });
    let out = await extractLessonFromFixOutcome(baseInput, { fetcher: first.fetcher, apiKey: "test" });
    expect(out).toEqual({ kind: "no_lesson" });

    const second = makeFetcher({ verdict: "lesson", text: "x".repeat(601) });
    out = await extractLessonFromFixOutcome(baseInput, { fetcher: second.fetcher, apiKey: "test" });
    expect(out).toEqual({ kind: "no_lesson" });
  });

  it("falls back to json_object and still returns a lesson when the endpoint rejects json_schema with 400", async () => {
    let attempt = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      attempt++;
      if (body.response_format?.type === "json_schema" && attempt === 1) {
        return new Response("bad schema", { status: 400 });
      }
      const payload = { verdict: "lesson", text: "fallback path still works" } as PlannedResponse;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const out = await extractLessonFromFixOutcome(baseInput, { fetcher, apiKey: "test" });
    expect(out.kind).toBe("lesson");
  });

  it("swallows non-2xx responses and returns no_lesson", async () => {
    const { fetcher } = makeFetcher({ verdict: "lesson" }, { status: 500 });
    const out = await extractLessonFromFixOutcome(baseInput, { fetcher, apiKey: "test" });
    expect(out).toEqual({ kind: "no_lesson" });
  });

  it("returns no_lesson when no API key is available", async () => {
    const { fetcher } = makeFetcher({ verdict: "lesson" });
    const out = await extractLessonFromFixOutcome(baseInput, { fetcher }); // no apiKey
    expect(out).toEqual({ kind: "no_lesson" });
  });
});

describe("readConfig (env precedence, issue #913)", () => {
  it("prefers DISPATCH_LLM_* over OPENAI_* for apiKey and baseUrl", async () => {
    await withEnv(
      {
        DISPATCH_LLM_API_KEY: "dispatch-key",
        DISPATCH_LLM_BASE_URL: "https://dispatch.example/v1",
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: "https://openai.example/v1",
      },
      () => {
        const cfg = readConfig();
        expect(cfg.apiKey).toBe("dispatch-key");
        expect(cfg.baseUrl).toBe("https://dispatch.example/v1");
      },
    );
  });

  it("falls back to OPENAI_* when DISPATCH_LLM_* is unset", async () => {
    await withEnv(
      {
        DISPATCH_LLM_API_KEY: undefined,
        DISPATCH_LLM_BASE_URL: undefined,
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: "https://openai.example/v1",
      },
      () => {
        const cfg = readConfig();
        expect(cfg.apiKey).toBe("openai-key");
        expect(cfg.baseUrl).toBe("https://openai.example/v1");
      },
    );
  });

  it("treats whitespace-only env values as unset", async () => {
    await withEnv(
      {
        DISPATCH_LLM_API_KEY: "  ",
        DISPATCH_LLM_BASE_URL: "\t",
        DISPATCH_LESSON_FEED_MODEL: " ",
        DISPATCH_GROOMER_MODEL: "\n",
        OPENAI_API_KEY: " ",
        OPENAI_BASE_URL: "\t",
        OPENAI_MODEL: "\n",
      },
      () => {
        expect(readConfig()).toEqual({
          apiKey: "",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
        });
      },
    );
  });

  it("resolves model as DISPATCH_LESSON_FEED_MODEL > DISPATCH_GROOMER_MODEL > OPENAI_MODEL > gpt-4o-mini", async () => {
    await withEnv(
      {
        DISPATCH_LESSON_FEED_MODEL: "lesson-model",
        DISPATCH_GROOMER_MODEL: "groomer-model",
        OPENAI_MODEL: "openai-model",
      },
      () => {
        expect(readConfig().model).toBe("lesson-model");
      },
    );
    await withEnv(
      {
        DISPATCH_LESSON_FEED_MODEL: undefined,
        DISPATCH_GROOMER_MODEL: "groomer-model",
        OPENAI_MODEL: "openai-model",
      },
      () => {
        expect(readConfig().model).toBe("groomer-model");
      },
    );
    await withEnv(
      {
        DISPATCH_LESSON_FEED_MODEL: undefined,
        DISPATCH_GROOMER_MODEL: undefined,
        OPENAI_MODEL: "openai-model",
      },
      () => {
        expect(readConfig().model).toBe("openai-model");
      },
    );
    await withEnv(
      {
        DISPATCH_LESSON_FEED_MODEL: undefined,
        DISPATCH_GROOMER_MODEL: undefined,
        OPENAI_MODEL: undefined,
      },
      () => {
        expect(readConfig().model).toBe("gpt-4o-mini");
      },
    );
  });

  it("defaults baseUrl to the OpenAI endpoint when neither var is set", async () => {
    await withEnv(
      {
        DISPATCH_LLM_BASE_URL: undefined,
        OPENAI_BASE_URL: undefined,
      },
      () => {
        expect(readConfig().baseUrl).toBe("https://api.openai.com/v1");
      },
    );
  });

  it("returns an empty apiKey when no key is configured anywhere", async () => {
    await withEnv(
      {
        DISPATCH_LLM_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      },
      () => {
        expect(readConfig().apiKey).toBe("");
      },
    );
  });

  it("fires a one-time warning when the legacy OPENAI_* path is in use", async () => {
    // Fresh module instance so the one-shot `legacyFallbackWarned` guard is
    // reset, independent of any earlier test in this file.
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("./lesson-feed");
    await withEnv(
      {
        DISPATCH_LLM_API_KEY: undefined,
        OPENAI_API_KEY: "openai-key",
      },
      () => {
        mod.readConfig();
        mod.readConfig();
      },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/OPENAI_.*DISPATCH_LLM_API_KEY/);
    warn.mockRestore();
  });

  it("warns when a DISPATCH key falls back to legacy base or model settings", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("./lesson-feed");
    await withEnv(
      {
        DISPATCH_LLM_API_KEY: "dispatch-key",
        OPENAI_BASE_URL: "https://legacy.example/v1",
        OPENAI_MODEL: "legacy-model",
      },
      () => {
        mod.readConfig();
      },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/OPENAI_BASE_URL.*OPENAI_MODEL/);
    warn.mockRestore();
  });

  it("does not warn when DISPATCH_LLM_API_KEY is the active key", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("./lesson-feed");
    await withEnv(
      {
        DISPATCH_LLM_API_KEY: "dispatch-key",
        OPENAI_API_KEY: "openai-key",
      },
      () => {
        mod.readConfig();
      },
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("extractLessonFromFixOutcome (missing-key early return, issue #913)", () => {
  it("returns no_lesson and makes no fetch call when no key is configured", async () => {
    const { fetcher, calls } = makeFetcher({ verdict: "lesson", text: "should not be used" });
    const out = await withEnv(
      {
        DISPATCH_LLM_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      },
      async () => {
        return extractLessonFromFixOutcome(baseInput, { fetcher });
      },
    );
    expect(out).toEqual({ kind: "no_lesson" });
    expect(calls).toHaveLength(0);
  });

  it("uses the DISPATCH_LLM_API_KEY from the environment when no apiKey option is passed", async () => {
    const { fetcher, calls } = makeFetcher({ verdict: "no_lesson" });
    const out = await withEnv(
      {
        DISPATCH_LLM_API_KEY: "dispatch-key",
        OPENAI_API_KEY: undefined,
      },
      async () => {
        return extractLessonFromFixOutcome(baseInput, { fetcher });
      },
    );
    expect(out).toEqual({ kind: "no_lesson" });
    expect(calls).toHaveLength(1);
  });
});

describe("lessonAlreadyCovered", () => {
  it("returns false when no existing AGENTS.md is provided", () => {
    expect(lessonAlreadyCovered(undefined, "anything")).toBe(false);
  });

  it("returns true when the lesson's distinctive tokens all appear in the file", () => {
    const existing = "## Tips\n- assert_eq takes the file path, not just two values.\n";
    expect(
      lessonAlreadyCovered(existing, "assert_eq takes the file path, not just two values."),
    ).toBe(true);
  });

  it("returns false when none of the distinctive tokens appear", () => {
    const existing = "## Tips\n- run tests with `bun test`\n";
    expect(lessonAlreadyCovered(existing, "assert_eq arity trap drops the file")).toBe(false);
  });
});
