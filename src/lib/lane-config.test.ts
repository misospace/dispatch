import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyLaneFromSignals,
  getDefaultClaimableLane,
  getEscalationLane,
  getBacklogLane,
  getClaimableLanes,
  getConfiguredLanes,
  getLaneById,
  getLaneIds,
  getLaneAliases,
  isBacklogLane,
  isClaimableLane,
  isValidLane,
  resetLaneConfig,
  resolveLaneId,
  isKnownOrAliasedLane,
  getUnconfiguredLaneInfo,
  laneMatchesConfigured,
  resolveRequestLane,
  setLaneConfig,
} from "./lane-config";

describe("lane-config defaults", () => {
  beforeEach(() => resetLaneConfig());

  it("returns two default lanes", () => {
    const lanes = getConfiguredLanes();
    expect(lanes).toHaveLength(2);
    expect(lanes.map((l) => l.id)).toEqual(["default", "backlog"]);
  });

  it("default is claimable, backlog is not", () => {
    expect(isClaimableLane("default")).toBe(true);
    expect(isClaimableLane("backlog")).toBe(false);
  });

  it("getClaimableLanes returns only claimable lanes", () => {
    const claimable = getClaimableLanes();
    expect(claimable).toHaveLength(1);
    expect(claimable.map((l) => l.id)).toEqual(["default"]);
  });

  it("getBacklogLane returns the non-claimable lane", () => {
    const backlog = getBacklogLane();
    expect(backlog).toBeDefined();
    expect(backlog?.id).toBe("backlog");
    expect(backlog?.claimable).toBe(false);
  });

  it("isValidLane returns correct values for defaults", () => {
    expect(isValidLane("default")).toBe(true);
    expect(isValidLane("backlog")).toBe(true);
    expect(isValidLane("unknown")).toBe(false);
  });

  it("isBacklogLane identifies the backlog lane", () => {
    expect(isBacklogLane("backlog")).toBe(true);
    expect(isBacklogLane("default")).toBe(false);
    expect(isBacklogLane("unknown")).toBe(false);
  });

  it("getLaneById returns the lane or undefined", () => {
    expect(getLaneById("default")?.title).toBe("Default");
    expect(getLaneById("nonexistent")).toBeUndefined();
  });

  it("getLaneIds returns all configured ids", () => {
    expect(getLaneIds()).toEqual(["default", "backlog"]);
  });

  it("returns a deep copy (mutations do not leak)", () => {
    const lanes = getConfiguredLanes();
    lanes[0].id = "mutated";
    expect(getConfiguredLanes()[0].id).toBe("default");
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
  beforeEach(() => resetLaneConfig());

  it("resetLaneConfig restores defaults", () => {
    setLaneConfig({
      lanes: [
        { id: "only", title: "Only", claimable: true },
      ],
    });
    expect(getConfiguredLanes()).toHaveLength(1);

    resetLaneConfig();
    expect(getConfiguredLanes()).toHaveLength(2);
    expect(getLaneIds()).toEqual(["default", "backlog"]);
  });
});

describe("lane-config classification helpers", () => {
  afterEach(() => {
    resetLaneConfig();
  });

  describe("getDefaultClaimableLane", () => {
    it("returns the lane with role=default by default config", () => {
      expect(getDefaultClaimableLane()?.id).toBe("local");
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
      expect(getEscalationLane()?.id).toBe("frontier");
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
      ).toBe("frontier");
    });

    it("maps default signals to the default claimable lane", () => {
      expect(
        classifyLaneFromSignals({ isBacklog: false, isEscalation: false }),
      ).toBe("local");
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

describe("lane-config aliases", () => {
  afterEach(() => {
    resetLaneConfig();
  });

  describe("getLaneAliases", () => {
    it("returns empty object when no aliases are configured", () => {
      resetLaneConfig();
      expect(getLaneAliases()).toEqual({});
    });

    it("returns the alias map when configured", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true, role: "default" },
          { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: {
          normal: "local",
          escalated: "frontier",
          backlog: "parking-lot",
        },
      });
      expect(getLaneAliases()).toEqual({
        normal: "local",
        escalated: "frontier",
        backlog: "parking-lot",
      });
    });
  });

  describe("resolveLaneId", () => {
    it("returns null for null/undefined/empty input", () => {
      expect(resolveLaneId(null)).toBeNull();
      expect(resolveLaneId(undefined)).toBeNull();
      expect(resolveLaneId("")).toBeNull();
    });

    it("returns the original lane ID if it is configured (default config)", () => {
      expect(resolveLaneId("normal")).toBe("local");
      expect(resolveLaneId("escalated")).toBe("frontier");
      expect(resolveLaneId("backlog")).toBe("backlog");
    });

    it("returns the mapped configured lane ID if an alias exists", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true, role: "default" },
          { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: {
          normal: "local",
          escalated: "frontier",
          backlog: "parking-lot",
        },
      });
      expect(resolveLaneId("normal")).toBe("local");
      expect(resolveLaneId("escalated")).toBe("frontier");
      expect(resolveLaneId("backlog")).toBe("parking-lot");
    });

    it("returns the original lane ID for unknown lanes (preserves visibility)", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { normal: "local" },
      });
      expect(resolveLaneId("unknown-old-lane")).toBe("unknown-old-lane");
    });

    it("does not silently map unknown lanes to default", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true, role: "default" },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
      });
      expect(resolveLaneId("someRandomLane")).toBe("someRandomLane");
    });

    it("returns configured lane when input matches a configured lane (not aliased)", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { normal: "local" },
      });
      expect(resolveLaneId("local")).toBe("local");
      expect(resolveLaneId("parking-lot")).toBe("parking-lot");
    });
  });

  describe("isKnownOrAliasedLane", () => {
    it("returns true for null/undefined (no lane set is valid)", () => {
      expect(isKnownOrAliasedLane(null)).toBe(true);
      expect(isKnownOrAliasedLane(undefined)).toBe(true);
    });

    it("returns true for configured lanes and aliases", () => {
      expect(isKnownOrAliasedLane("local")).toBe(true);
      expect(isKnownOrAliasedLane("frontier")).toBe(true);
      expect(isKnownOrAliasedLane("backlog")).toBe(true);
    });

    it("returns false for unknown lanes without alias", () => {
      expect(isKnownOrAliasedLane("unknown-lane")).toBe(false);
    });

    it("returns true for aliased lanes", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { normal: "local", escalated: "local" },
      });
      expect(isKnownOrAliasedLane("normal")).toBe(true);
      expect(isKnownOrAliasedLane("escalated")).toBe(true);
      expect(isKnownOrAliasedLane("unknown-lane")).toBe(false);
    });
  });

  describe("getUnconfiguredLaneInfo", () => {
    it("returns null for configured lanes", () => {
      expect(getUnconfiguredLaneInfo("local")).toBeNull();
      expect(getUnconfiguredLaneInfo("frontier")).toBeNull();
      expect(getUnconfiguredLaneInfo("backlog")).toBeNull();
    });

    it("returns null for null input", () => {
      expect(getUnconfiguredLaneInfo(null)).toBeNull();
    });

    it("returns aliased info when lane has an alias", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { normal: "local", backlog: "parking-lot" },
      });
      expect(getUnconfiguredLaneInfo("normal")).toEqual({
        rawId: "normal",
        isAliased: true,
        resolvedId: "local",
      });
      expect(getUnconfiguredLaneInfo("backlog")).toEqual({
        rawId: "backlog",
        isAliased: true,
        resolvedId: "parking-lot",
      });
    });

    it("returns unaliased info for unknown lanes", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
        ],
        laneAliases: { normal: "local" },
      });
      expect(getUnconfiguredLaneInfo("unknown-lane")).toEqual({
        rawId: "unknown-lane",
        isAliased: false,
      });
    });
  });

  describe("laneMatchesConfigured", () => {
    it("returns true when stored lane equals configured lane", () => {
      expect(laneMatchesConfigured("local", "local")).toBe(true);
    });

    it("returns false when stored lane differs from configured lane (no alias)", () => {
      expect(laneMatchesConfigured("frontier", "local")).toBe(false);
    });

    it("returns true when stored lane aliases to configured lane", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { normal: "local", backlog: "parking-lot" },
      });
      expect(laneMatchesConfigured("normal", "local")).toBe(true);
      expect(laneMatchesConfigured("backlog", "parking-lot")).toBe(true);
      expect(laneMatchesConfigured("unknown", "local")).toBe(false);
    });

    it("returns false for null stored lane", () => {
      expect(laneMatchesConfigured(null, "default")).toBe(false);
    });
  });

  describe("resolveRequestLane", () => {
    it("returns null for null/undefined input", () => {
      expect(resolveRequestLane(null)).toBeNull();
      expect(resolveRequestLane(undefined)).toBeNull();
    });

    it("returns the configured lane ID for valid lanes", () => {
      expect(resolveRequestLane("local")).toBe("local");
      expect(resolveRequestLane("frontier")).toBe("frontier");
    });

    it("resolves aliased lane names to configured lane ID", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { normal: "local", backlog: "parking-lot" },
      });
      expect(resolveRequestLane("normal")).toBe("local");
      expect(resolveRequestLane("backlog")).toBe("parking-lot");
    });

    it("returns null for unknown lanes (caller should return 400)", () => {
      expect(resolveRequestLane("unknown-lane")).toBeNull();
    });
  });

  describe("setLaneConfig validation with aliases", () => {
    it("rejects aliases that point to unconfigured lanes", () => {
      expect(() =>
        setLaneConfig({
          lanes: [
            { id: "local", title: "Local", claimable: true },
          ],
          laneAliases: { normal: "nonexistent" },
        }),
      ).toThrow('Lane alias "normal" -> "nonexistent" references an unconfigured lane');
    });

    it("accepts aliases that point to configured lanes", () => {
      expect(() =>
        setLaneConfig({
          lanes: [
            { id: "local", title: "Local", claimable: true },
            { id: "parking-lot", title: "Parking Lot", claimable: false },
          ],
          laneAliases: { normal: "local", backlog: "parking-lot" },
        }),
      ).not.toThrow();
    });

    it("allows empty alias map", () => {
      expect(() =>
        setLaneConfig({
          lanes: [
            { id: "local", title: "Local", claimable: true },
          ],
          laneAliases: {},
        }),
      ).not.toThrow();
    });
  });

  describe("migration scenarios", () => {
    it("global test config treats normal/escalated as aliases", () => {
      // normal and escalated are aliases, not valid lanes themselves
      expect(isValidLane("normal")).toBe(false);
      expect(isValidLane("escalated")).toBe(false);
      expect(isValidLane("backlog")).toBe(true);
      // But they resolve through aliases
      expect(resolveLaneId("normal")).toBe("local");
      expect(resolveLaneId("escalated")).toBe("frontier");
      expect(resolveLaneId("backlog")).toBe("backlog");
    });

    it("custom config with laneAliases maps old normal to new default lane", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true, role: "default" },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { normal: "local" },
      });
      expect(isValidLane("normal")).toBe(false);
      expect(resolveLaneId("normal")).toBe("local");
      expect(laneMatchesConfigured("normal", "local")).toBe(true);
    });

    it("custom config with laneAliases maps old escalated to configured escalation lane", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true, role: "default" },
          { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { escalated: "frontier" },
      });
      expect(resolveLaneId("escalated")).toBe("frontier");
      expect(laneMatchesConfigured("escalated", "frontier")).toBe(true);
    });

    it("custom config with laneAliases maps old backlog to configured non-claimable lane", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { backlog: "parking-lot" },
      });
      expect(resolveLaneId("backlog")).toBe("parking-lot");
      expect(isBacklogLane(resolveLaneId("backlog")!)).toBe(true);
    });

    it("single claimable lane plus backlog works with aliases from old default lanes", () => {
      setLaneConfig({
        lanes: [
          { id: "work", title: "Work", claimable: true, role: "default" },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: {
          normal: "work",
          escalated: "work",
          backlog: "parking-lot",
        },
      });
      expect(resolveLaneId("normal")).toBe("work");
      expect(resolveLaneId("escalated")).toBe("work");
      expect(resolveLaneId("backlog")).toBe("parking-lot");
      expect(laneMatchesConfigured("normal", "work")).toBe(true);
      expect(laneMatchesConfigured("escalated", "work")).toBe(true);
      expect(laneMatchesConfigured("backlog", "parking-lot")).toBe(true);
    });
  });
});
