import { describe, expect, it } from "vitest";
import { jsonSafe } from "./json";

describe("jsonSafe", () => {
  it("converts BigInt values to strings", () => {
    expect(jsonSafe({ id: BigInt(123) })).toEqual({ id: "123" });
  });

  it("converts nested BigInt values in arrays and objects", () => {
    expect(jsonSafe({ runs: [{ id: BigInt(1) }, { jobs: [BigInt(2), { id: BigInt(3) }] }] })).toEqual({
      runs: [{ id: "1" }, { jobs: ["2", { id: "3" }] }],
    });
  });

  it("keeps normal JSON primitives unchanged", () => {
    expect(jsonSafe({ name: "run", count: 2, ok: true, missing: null })).toEqual({
      name: "run",
      count: 2,
      ok: true,
      missing: null,
    });
  });
});
