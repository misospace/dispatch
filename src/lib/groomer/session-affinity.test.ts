import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import {
  groomerSessionId,
  litellmSessionHeaders,
  LITELLM_SESSION_HEADER,
} from "./session-affinity";

/** What LiteLLM accepts for a session id: header-safe, at least 8 characters. */
const HEADER_SAFE = /^[A-Za-z0-9_-]{8,}$/;

function expectedDigest(id: string): string {
  return `groom-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

describe("groomerSessionId", () => {
  it("uses a run id that is already header-safe verbatim", () => {
    // A Prisma cuid is what GroomingRun.id holds, so the normal path sends the
    // run id itself: operators see the run behind the pin in LiteLLM logs.
    const runId = "ckzq8t2v10000ab12cd34ef56";
    expect(groomerSessionId(runId)).toBe(runId);
  });

  it("is stable for one run id and distinct across run ids", () => {
    const a = groomerSessionId("ckzq8t2v10000ab12cd34ef56");
    const b = groomerSessionId("ckzq8t2v10000ab12cd34ef56");
    const c = groomerSessionId("ckzq8t2v10001ab12cd34ef56");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  const unusableRunIds: Record<string, string> = {
    "shorter than the minimum": "gr-1",
    "carrying characters a header cannot hold": "run id with spaces/é",
    "longer than a header value should be": `x${"y".repeat(200)}`,
  };
  for (const [label, runId] of Object.entries(unusableRunIds)) {
    it(`derives a header-safe id when the run id is ${label}`, () => {
      const sessionId = groomerSessionId(runId);
      expect(sessionId).toMatch(HEADER_SAFE);
      expect(sessionId).not.toBe(runId);
      // Deterministic, so every call site of one run agrees without shared state.
      expect(sessionId).toBe(groomerSessionId(runId));
    });
  }

  it("derives by digest, so the fallback is the same value everywhere", () => {
    expect(groomerSessionId("gr-1")).toBe(expectedDigest("gr-1"));
    // A value the fallback produced is itself header-safe, so the pass-through
    // branch keeps it: re-deriving an id never moves a run to a new pin.
    const digest = groomerSessionId("gr-1");
    expect(groomerSessionId(digest)).toBe(digest);
  });

  it("trims the run id before judging it", () => {
    const runId = "ckzq8t2v10000ab12cd34ef56";
    expect(groomerSessionId(`  ${runId}\n`)).toBe(runId);
  });
});

describe("litellmSessionHeaders", () => {
  it("carries the id on the header LiteLLM reads natively", () => {
    expect(litellmSessionHeaders("ckzq8t2v10000ab12cd34ef56")).toEqual({
      [LITELLM_SESSION_HEADER]: "ckzq8t2v10000ab12cd34ef56",
    });
  });

  it("sends no header for a caller with no session", () => {
    // A stateless one-shot call keeps LiteLLM's normal per-request routing.
    expect(litellmSessionHeaders()).toEqual({});
    expect(litellmSessionHeaders(null)).toEqual({});
    expect(litellmSessionHeaders("")).toEqual({});
  });
});
