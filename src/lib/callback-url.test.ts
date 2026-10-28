import { describe, expect, it } from "vitest";
import { DEFAULT_CALLBACK_URL, safeCallbackUrl } from "./callback-url";

const EXTERNAL_ORIGIN_BASE = "https://dispatch.example";

function staysLocal(result: string) {
  const resolved = new URL(result, EXTERNAL_ORIGIN_BASE);
  return resolved.origin === EXTERNAL_ORIGIN_BASE;
}

describe("safeCallbackUrl", () => {
  it.each([
    [null],
    [""],
    ["   "],
    ["https://evil.example/path"],
    ["HTTP://evil.example/path"],
    ["http://evil.example"],
    ["//evil.example/path"],
    ["/\\evil.example/path"],
    ["/\\/evil.example"],
    ["/\t/evil.example"],
    ["/\n/evil.example"],
    ["/\r/evil.example"],
    ["/\v/evil.example"],
    ["/\f/evil.example"],
    ["/\x7f/evil.example"],
    [" /\t/evil.example"],
    ["\t/board"],
    ["/\tboard"],
    ["javascript:alert(1)"],
    ["board/issues"],
  ])("falls back to the default callback for %s", (input) => {
    expect(safeCallbackUrl(input)).toBe(DEFAULT_CALLBACK_URL);
  });

  it.each([
    "/board",
    "/",
    "/board/issues",
    "/board?tab=issues",
    "/board?tab=issues&lane=normal#card-7",
    "/custom/return",
    "/board%2Fissues",
    "/board?a=1&b=2",
    "/board#frag",
    "/board?redirect=%2Finside",
    "/board?x=%09//evil.example",
    "/oùt/re?ünïcode=1",
  ])("preserves valid local callback %s", (input) => {
    expect(safeCallbackUrl(input)).toBe(input);
  });

  it.each([
    "/\\evil.example/path",
    "/\t/evil.example",
    "/\r/evil.example",
    "//evil.example/path",
    "https://evil.example/path",
  ])("never returns a value that normalizes off-site (%s)", (input) => {
    const result = safeCallbackUrl(input);
    expect(staysLocal(result)).toBe(true);
  });

  it("keeps every accepted value same-origin after URL parsing", () => {
    const accepted = [
      "/board",
      "/board?tab=issues#card-7",
      "/board?x=%09//evil.example",
      "/board%2Fissues",
    ];
    for (const input of accepted) {
      expect(staysLocal(safeCallbackUrl(input))).toBe(true);
    }
  });
});
