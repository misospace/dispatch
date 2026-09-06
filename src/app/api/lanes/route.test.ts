import { describe, expect, it, afterEach, vi } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";
import { resetLaneConfig, setLaneConfig } from "@/lib/lane-config";
import { GET } from "./route";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

afterEach(() => {
  resetLaneConfig();
});

const url = "http://localhost/api/lanes";

describe("GET /api/lanes", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await GET(new Request(url));
    expect(res.status).toBe(401);
  });

  it("returns the shipped default topology when nothing is configured", async () => {
    resetLaneConfig();
    const res = await GET(authedRequest(url));
    expect(res.status).toBe(200);

    const lanes = await res.json();
    expect(lanes.map((l: { id: string }) => l.id).sort()).toEqual(["backlog", "default"]);

    const def = lanes.find((l: { id: string }) => l.id === "default");
    expect(def.claimable).toBe(true);
    expect(def.role).toBe("default");

    const backlog = lanes.find((l: { id: string }) => l.id === "backlog");
    expect(backlog.claimable).toBe(false);
  });

  it("reflects an injected topology rather than any hardcoded lane set", async () => {
    // The point of the endpoint: a deployment's own lane names come back, and
    // dispatch contributes none of its own. If someone reintroduces literals
    // like "local"/"frontier" into dispatch, this fails.
    setLaneConfig({
      lanes: [
        { id: "tier-a", title: "Tier A", claimable: true, role: "default" },
        { id: "tier-b", title: "Tier B", claimable: true },
        { id: "tier-c", title: "Tier C", claimable: true, role: "escalation" },
        { id: "parked", title: "Parked", claimable: false },
      ],
    });

    const lanes = await (await GET(authedRequest(url))).json();
    expect(lanes.map((l: { id: string }) => l.id)).toEqual(["tier-a", "tier-b", "tier-c", "parked"]);

    const roles = Object.fromEntries(
      lanes.map((l: { id: string; role?: string }) => [l.id, l.role ?? null]),
    );
    expect(roles).toEqual({
      "tier-a": "default",
      "tier-b": null,
      "tier-c": "escalation",
      parked: null,
    });
  });

  it("carries claimable so a consumer can pick which lanes to poll", async () => {
    setLaneConfig({
      lanes: [
        { id: "work", title: "Work", claimable: true, role: "default" },
        { id: "shelf", title: "Shelf", claimable: false },
      ],
    });
    const lanes = await (await GET(authedRequest(url))).json();
    expect(lanes.filter((l: { claimable: boolean }) => l.claimable).map((l: { id: string }) => l.id)).toEqual([
      "work",
    ]);
  });

  it("does not alias the module-level config", async () => {
    setLaneConfig({
      lanes: [{ id: "solo", title: "Solo", claimable: true, role: "default" }],
    });
    const lanes = await (await GET(authedRequest(url))).json();
    lanes[0].id = "mutated";

    const again = await (await GET(authedRequest(url))).json();
    expect(again[0].id).toBe("solo");
  });
});
