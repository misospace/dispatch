import { describe, expect, it } from "vitest";
import {
  extractLessonFromFixOutcome,
  lessonAlreadyCovered,
  type ExtractLessonInput,
  type LessonOutcome,
} from "./lesson-feed";

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
