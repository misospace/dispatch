import { describe, expect, it } from "vitest";
import { trustedClientIp } from "./client-ip";

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("trustedClientIp", () => {
  it("takes the rightmost x-forwarded-for entry, discarding forged leftmost values", () => {
    expect(trustedClientIp(headers({ "x-forwarded-for": "forged-1, forged-2, 10.0.0.8" }))).toBe(
      "10.0.0.8"
    );
  });

  it("uses a single-entry x-forwarded-for as-is", () => {
    expect(trustedClientIp(headers({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("trims whitespace around the trusted entry", () => {
    expect(trustedClientIp(headers({ "x-forwarded-for": "9.9.9.9,  10.0.0.9  " }))).toBe(
      "10.0.0.9"
    );
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(trustedClientIp(headers({ "x-real-ip": "192.168.1.20" }))).toBe("192.168.1.20");
  });

  it("falls back to x-real-ip when every x-forwarded-for entry is blank", () => {
    expect(trustedClientIp(headers({ "x-forwarded-for": " , ", "x-real-ip": "192.168.1.21" }))).toBe(
      "192.168.1.21"
    );
  });

  it("falls back to the literal unknown bucket when no proxy header is present", () => {
    expect(trustedClientIp(headers({}))).toBe("unknown");
  });

  it("falls back to unknown when every x-forwarded-for entry is blank and x-real-ip is absent", () => {
    expect(trustedClientIp(headers({ "x-forwarded-for": " , " }))).toBe("unknown");
  });
});
