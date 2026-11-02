import { describe, expect, it } from "vitest";
import { errorResponse, handleApiError, readJsonObjectBody } from "./api-errors";

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

describe("readJsonObjectBody", () => {
  const objectRequest = (payload: unknown) =>
    new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  it("returns the parsed body for a JSON object", async () => {
    const result = await readJsonObjectBody(objectRequest({ issueId: "abc" }));
    if (!("body" in result)) throw new Error("expected body");
    expect(result.body).toEqual({ issueId: "abc" });
  });

  it("returns a 400 'Invalid JSON body' response for malformed JSON", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      body: "{not json",
    });
    const result = await readJsonObjectBody(request);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.status).toBe(400);
    expect(await result.error.json()).toEqual({ error: "Invalid JSON body" });
  });

  it.each([null, "string", 42, true])("rejects the non-object body %s", async (payload) => {
    const result = await readJsonObjectBody(objectRequest(payload));
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.status).toBe(400);
  });

  it("accepts a JSON array by default (routes that never guarded arrays keep their behavior)", async () => {
    const result = await readJsonObjectBody(objectRequest(["a"]));
    if (!("body" in result)) throw new Error("expected body");
    expect(result.body).toEqual(["a"]);
  });

  it("rejects a JSON array when rejectArrays is set", async () => {
    const result = await readJsonObjectBody(objectRequest(["a"]), { rejectArrays: true });
    if (!("error" in result)) throw new Error("expected error");
    expect(result.error.status).toBe(400);
    expect(await result.error.json()).toEqual({ error: "Invalid JSON body" });
  });
});
