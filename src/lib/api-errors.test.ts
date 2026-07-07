import { describe, expect, it } from "vitest";
import { errorResponse, handleApiError } from "./api-errors";

describe("api-errors helpers", () => {
  it("builds a structured JSON error response with the canonical shape", async () => {
    const res = errorResponse("boom");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "boom" });
  });

  it("respects a custom status code", async () => {
    const res = errorResponse("nope", 418);
    expect(res.status).toBe(418);
    const body = await res.json();
    expect(body).toEqual({ error: "nope" });
  });

  it("handleApiError logs and returns a matching 500 response", async () => {
    const err = new Error("kaboom");
    const res = handleApiError("do the thing", err);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Failed to do the thing" });
  });

  it("handleApiError accepts a non-Error value and still returns a response", async () => {
    const res = handleApiError("save the record", "stringy failure");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Failed to save the record" });
  });
});
