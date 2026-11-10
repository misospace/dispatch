import { describe, expect, it } from "vitest";
import { isForeignKeyViolation, isUniqueViolation } from "./prisma-errors";

describe("isUniqueViolation", () => {
  it("matches a P2002 known-request error", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
  });

  it("matches a PrismaClientKnownRequestError-shaped instance without instanceof narrowing", () => {
    const error = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    expect(isUniqueViolation(error)).toBe(true);
  });

  it.each(["P2003", "P2025", "p2002", "P2002 ", ""])("does not match the other code %j", (code) => {
    expect(isUniqueViolation({ code })).toBe(false);
  });

  it.each([
    null,
    undefined,
    "P2002",
    42,
    true,
    [],
    {},
    new Error("plain error without code"),
    { code: 2002 },
  ])("does not match the non-object or malformed value %j", (value) => {
    expect(isUniqueViolation(value)).toBe(false);
  });
});

describe("isForeignKeyViolation", () => {
  it("matches a P2003 known-request error", () => {
    expect(isForeignKeyViolation({ code: "P2003" })).toBe(true);
  });

  it.each(["P2002", "P2025", "p2003", ""])("does not match the other code %j", (code) => {
    expect(isForeignKeyViolation({ code })).toBe(false);
  });

  it.each([
    null,
    undefined,
    "P2003",
    42,
    true,
    [],
    {},
    new Error("plain error without code"),
    { code: 2003 },
  ])("does not match the non-object or malformed value %j", (value) => {
    expect(isForeignKeyViolation(value)).toBe(false);
  });
});
