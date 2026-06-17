import { afterEach, describe, expect, it } from "vitest";
import {
  classifyLaneFromSignals,
  getDefaultClaimableLane,
  getEscalationLane,
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

describe("lane-config classification helpers", () => {
  afterEach(() => {
    resetLaneConfig();
  });

  describe("getDefaultClaimableLane", () => {
    it("returns the lane with role=default by default config", () => {
      expect(getDefaultClaimableLane()?.id).toBe("normal");
    });

    it("returns the first claimable lane when no role is set", () => {
      setLaneConfig({
        lanes: [
          { id: "fast", title: "Fast", claimable: true },
          { id: "slow", title: "Slow", claimable: true },
          { id: "parked", title: "Parked", claimable: false },
        ],
      });
      expect(getDefaultClaimableLane()?.id).toBe("fast");
    });

    it("prefers explicit role=default over first claimable", () => {
      setLaneConfig({
        lanes: [
          { id: "fast", title: "Fast", claimable: true },
          { id: "default-lane", title: "Default", claimable: true, role: "default" },
          { id: "parked", title: "Parked", claimable: false },
        ],
      });
      expect(getDefaultClaimableLane()?.id).toBe("default-lane");
    });
  });

  describe("getEscalationLane", () => {
    it("returns the lane with role=escalation by default config", () => {
      expect(getEscalationLane()?.id).toBe("escalated");
    });

    it("falls back to default claimable when no escalation role exists", () => {
      setLaneConfig({
        lanes: [
          { id: "default", title: "Default", claimable: true },
          { id: "backlog", title: "Backlog", claimable: false },
        ],
      });
      expect(getEscalationLane()?.id).toBe("default");
    });

    it("returns explicit escalation lane when configured", () => {
      setLaneConfig({
        lanes: [
          { id: "normal", title: "Normal", claimable: true, role: "default" },
          { id: "senior-review", title: "Senior Review", claimable: true, role: "escalation" },
          { id: "backlog", title: "Backlog", claimable: false },
        ],
      });
      expect(getEscalationLane()?.id).toBe("senior-review");
    });
  });

  describe("classifyLaneFromSignals", () => {
    it("maps backlog signals to the non-claimable lane", () => {
      expect(
        classifyLaneFromSignals({ isBacklog: true, isEscalation: false }),
      ).toBe("backlog");
    });

    it("maps escalation signals to the escalation lane", () => {
      expect(
        classifyLaneFromSignals({ isBacklog: false, isEscalation: true }),
      ).toBe("escalated");
    });

    it("maps default signals to the default claimable lane", () => {
      expect(
        classifyLaneFromSignals({ isBacklog: false, isEscalation: false }),
      ).toBe("normal");
    });

    it("with single claimable lane: all actionable goes to that lane", () => {
      setLaneConfig({
        lanes: [
          { id: "work", title: "Work", claimable: true },
          { id: "backlog", title: "Backlog", claimable: false },
        ],
      });
      expect(
        classifyLaneFromSignals({ isBacklog: false, isEscalation: false }),
      ).toBe("work");
      // High-complexity falls back to same lane since no escalation role
      expect(
        classifyLaneFromSignals({ isBacklog: false, isEscalation: true }),
      ).toBe("work");
      expect(
        classifyLaneFromSignals({ isBacklog: true, isEscalation: false }),
      ).toBe("backlog");
    });

    it("with single claimable lane and escalation role: maps correctly", () => {
      setLaneConfig({
        lanes: [
          { id: "work", title: "Work", claimable: true, role: "default" },
          { id: "expert", title: "Expert", claimable: true, role: "escalation" },
          { id: "backlog", title: "Backlog", claimable: false },
        ],
      });
      expect(
        classifyLaneFromSignals({ isBacklog: false, isEscalation: false }),
      ).toBe("work");
      expect(
        classifyLaneFromSignals({ isBacklog: false, isEscalation: true }),
      ).toBe("expert");
      expect(
        classifyLaneFromSignals({ isBacklog: true, isEscalation: false }),
      ).toBe("backlog");
    });

    it("with no backlog lane: backlog signals fall back to default claimable", () => {
      setLaneConfig({
        lanes: [
          { id: "work", title: "Work", claimable: true },
        ],
      });
      expect(
        classifyLaneFromSignals({ isBacklog: true, isEscalation: false }),
      ).toBe("work");
    });

    it("never returns unknown lane ids", () => {
      setLaneConfig({
        lanes: [
          { id: "alpha", title: "Alpha", claimable: true },
          { id: "beta", title: "Beta", claimable: true, role: "escalation" },
          { id: "gamma", title: "Gamma", claimable: false },
        ],
      });
      const results = [
        classifyLaneFromSignals({ isBacklog: false, isEscalation: false }),
        classifyLaneFromSignals({ isBacklog: false, isEscalation: true }),
        classifyLaneFromSignals({ isBacklog: true, isEscalation: false }),
      ];
      for (const lane of results) {
        expect(["alpha", "beta", "gamma"]).toContain(lane);
      }
    });
  });
});
