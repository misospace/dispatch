import { afterEach, describe, expect, it } from "vitest";
import {
  getBacklogLane,
  getClaimableLanes,
  getConfiguredLanes,
  getLaneById,
  getLaneIds,
  isBacklogLane,
  isClaimableLane,
  isValidLane,
  resetLaneConfig,
  setLaneConfig,
} from "./lane-config";

describe("lane-config defaults", () => {
  it("returns three default lanes", () => {
    const lanes = getConfiguredLanes();
    expect(lanes).toHaveLength(3);
    expect(lanes.map((l) => l.id)).toEqual(["normal", "escalated", "backlog"]);
  });

  it("normal and escalated are claimable, backlog is not", () => {
    expect(isClaimableLane("normal")).toBe(true);
    expect(isClaimableLane("escalated")).toBe(true);
    expect(isClaimableLane("backlog")).toBe(false);
  });

  it("getClaimableLanes returns only claimable lanes", () => {
    const claimable = getClaimableLanes();
    expect(claimable).toHaveLength(2);
    expect(claimable.map((l) => l.id)).toEqual(["normal", "escalated"]);
  });

  it("getBacklogLane returns the non-claimable lane", () => {
    const backlog = getBacklogLane();
    expect(backlog).toBeDefined();
    expect(backlog?.id).toBe("backlog");
    expect(backlog?.claimable).toBe(false);
  });

  it("isValidLane returns correct values for defaults", () => {
    expect(isValidLane("normal")).toBe(true);
    expect(isValidLane("escalated")).toBe(true);
    expect(isValidLane("backlog")).toBe(true);
    expect(isValidLane("unknown")).toBe(false);
  });

  it("isBacklogLane identifies the backlog lane", () => {
    expect(isBacklogLane("backlog")).toBe(true);
    expect(isBacklogLane("normal")).toBe(false);
    expect(isBacklogLane("escalated")).toBe(false);
    expect(isBacklogLane("unknown")).toBe(false);
  });

  it("getLaneById returns the lane or undefined", () => {
    expect(getLaneById("normal")?.title).toBe("Normal");
    expect(getLaneById("nonexistent")).toBeUndefined();
  });

  it("getLaneIds returns all configured ids", () => {
    expect(getLaneIds()).toEqual(["normal", "escalated", "backlog"]);
  });

  it("returns a deep copy (mutations do not leak)", () => {
    const lanes = getConfiguredLanes();
    lanes[0].id = "mutated";
    expect(getConfiguredLanes()[0].id).toBe("normal");
  });
});

describe("lane-config custom config", () => {
  afterEach(() => {
    resetLaneConfig();
  });

  it("accepts a single claimable lane plus backlog", () => {
    setLaneConfig({
      lanes: [
        { id: "default", title: "Default", claimable: true },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });

    expect(getConfiguredLanes()).toHaveLength(2);
    expect(isClaimableLane("default")).toBe(true);
    expect(isClaimableLane("backlog")).toBe(false);
    expect(getBacklogLane()?.id).toBe("backlog");
  });

  it("accepts multiple claimable lanes plus backlog", () => {
    setLaneConfig({
      lanes: [
        { id: "fast", title: "Fast Lane", claimable: true },
        { id: "slow", title: "Slow Lane", claimable: true },
        { id: "parked", title: "Parked", claimable: false },
      ],
    });

    expect(getClaimableLanes()).toHaveLength(2);
    expect(isClaimableLane("fast")).toBe(true);
    expect(isClaimableLane("slow")).toBe(true);
    expect(isClaimableLane("parked")).toBe(false);
    expect(getBacklogLane()?.id).toBe("parked");
  });

  it("rejects empty lane array", () => {
    expect(() => setLaneConfig({ lanes: [] })).toThrow(
      "Lane config must contain at least one lane",
    );
  });

  it("rejects duplicate lane ids", () => {
    expect(() =>
      setLaneConfig({
        lanes: [
          { id: "a", title: "A", claimable: true },
          { id: "a", title: "A dup", claimable: false },
        ],
      }),
    ).toThrow("Duplicate lane id: a");
  });

  it("rejects empty lane id", () => {
    expect(() =>
      setLaneConfig({ lanes: [{ id: "", title: "X", claimable: true }] }),
    ).toThrow("Lane id must be a non-empty string");
  });

  it("rejects missing title", () => {
    // @ts-expect-error — testing runtime validation
    expect(() => setLaneConfig({ lanes: [{ id: "x", claimable: true }] })).toThrow(
      'Lane "x" must have a non-empty title',
    );
  });

  it("rejects all non-claimable lanes", () => {
    expect(() =>
      setLaneConfig({
        lanes: [
          { id: "a", title: "A", claimable: false },
          { id: "b", title: "B", claimable: false },
        ],
      }),
    ).toThrow("Lane config must contain at least one claimable lane");
  });

  it("custom lanes are accepted by isValidLane and isClaimableLane", () => {
    setLaneConfig({
      lanes: [
        { id: "fast", title: "Fast Lane", claimable: true },
        { id: "slow", title: "Slow Lane", claimable: true },
        { id: "parked", title: "Parked", claimable: false },
      ],
    });

    expect(isValidLane("fast")).toBe(true);
    expect(isValidLane("slow")).toBe(true);
    expect(isValidLane("parked")).toBe(true);
    expect(isValidLane("normal")).toBe(false);
    expect(isClaimableLane("fast")).toBe(true);
    expect(isClaimableLane("parked")).toBe(false);
    expect(isBacklogLane("parked")).toBe(true);
    expect(isBacklogLane("fast")).toBe(false);
  });

  it("supports optional fields (description, color, defaultAgent)", () => {
    setLaneConfig({
      lanes: [
        {
          id: "custom",
          title: "Custom",
          claimable: true,
          description: "A custom lane",
          color: "#ff0000",
          defaultAgent: "custom-agent",
        },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });

    const lane = getLaneById("custom");
    expect(lane?.description).toBe("A custom lane");
    expect(lane?.color).toBe("#ff0000");
    expect(lane?.defaultAgent).toBe("custom-agent");
  });
});

describe("lane-config reset", () => {
  it("resetLaneConfig restores defaults", () => {
    setLaneConfig({
      lanes: [
        { id: "only", title: "Only", claimable: true },
      ],
    });
    expect(getConfiguredLanes()).toHaveLength(1);

    resetLaneConfig();
    expect(getConfiguredLanes()).toHaveLength(3);
    expect(getLaneIds()).toEqual(["normal", "escalated", "backlog"]);
  });
});
