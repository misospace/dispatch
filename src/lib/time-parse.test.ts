import { describe, expect, it } from "vitest";
import { toIso, toMillis } from "./time-parse";

describe("toMillis", () => {
  it("passes a Date through its epoch millis", () => {
    const date = new Date("2026-11-01T00:00:00.000Z");
    expect(toMillis(date)).toBe(date.getTime());
  });

  it("passes a numeric millis value through", () => {
    expect(toMillis(1735689600000)).toBe(1735689600000);
    expect(toMillis(0)).toBe(0);
    expect(toMillis(-1)).toBe(-1);
  });

  it("parses an ISO string", () => {
    expect(toMillis("2026-11-01T00:00:00.000Z")).toBe(new Date("2026-11-01T00:00:00.000Z").getTime());
  });

  it("yields null for absent values", () => {
    expect(toMillis(null)).toBeNull();
    expect(toMillis(undefined)).toBeNull();
  });

  it("yields null for unparseable values", () => {
    expect(toMillis("not a date")).toBeNull();
    expect(toMillis(Number.NaN)).toBeNull();
  });
});

describe("toIso", () => {
  it("formats epoch millis as an ISO string", () => {
    expect(toIso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(toIso(new Date("2026-11-01T12:34:56.789Z").getTime())).toBe("2026-11-01T12:34:56.789Z");
  });

  it("is the inverse of toMillis for Date inputs", () => {
    const date = new Date("2026-06-15T08:00:00.123Z");
    expect(toIso(toMillis(date) as number)).toBe(date.toISOString());
  });
});
