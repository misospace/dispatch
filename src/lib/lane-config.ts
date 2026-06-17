/**
 * Central lane configuration module.
 *
 * Provides a typed, configurable lane model so that all lane consumers go
 * through one helper instead of scattered string unions and constants.
 *
 * The default config preserves current behavior (normal / escalated / backlog).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single lane definition.
 */
export interface LaneConfig {
  /** Unique identifier (e.g. "normal", "escalated", "backlog") */
  id: string;
  /** Display title */
  title: string;
  /** Whether workers may claim issues in this lane */
  claimable: boolean;
  /** Optional role hint for heuristic classification ("default" or "escalation") */
  role?: "default" | "escalation";
  /** Optional human-readable description */
  description?: string;
  /** Optional hex color for UI rendering */
  color?: string;
  /** Default agent that handles this lane (optional) */
  defaultAgent?: string;
}

/**
 * Full lane configuration set.
 */
export interface LaneConfigSet {
  lanes: LaneConfig[];
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

/**
 * Default lane configuration — equivalent to current behavior.
 *
 * - `normal`: claimable, standard worker lane
 * - `escalated`: claimable, requires higher-judgment model support
 * - `backlog`: non-claimable, needs grooming before work can start
 */
const DEFAULT_LANE_CONFIG: LaneConfigSet = {
  lanes: [
    {
      id: "normal",
      title: "Normal",
      claimable: true,
      role: "default",
      description: "Standard execution lane for concrete, scoped implementation work.",
      color: "#3b82f6",
    },
    {
      id: "escalated",
      title: "Escalated",
      claimable: true,
      role: "escalation",
      description: "Requires higher-judgment model support (architecture, design, cross-service).",
      color: "#f97316",
    },
    {
      id: "backlog",
      title: "Backlog",
      claimable: false,
      description: "Needs grooming before work can start. Not directly claimable.",
      color: "#6b7280",
    },
  ],
};

// ─── Config State ─────────────────────────────────────────────────────────────

let laneConfigSet: LaneConfigSet = DEFAULT_LANE_CONFIG;

/**
 * Override the lane configuration (e.g. from environment or custom config file).
 *
 * Validates that every lane has a unique, non-empty id and that at least one
 * claimable lane exists. Throws on invalid config.
 */
export function setLaneConfig(config: LaneConfigSet): void {
  validateLaneConfigSet(config);
  laneConfigSet = config;
}

/**
 * Reset to the default lane configuration.
 */
export function resetLaneConfig(): void {
  laneConfigSet = DEFAULT_LANE_CONFIG;
}

// ─── Public Helpers ───────────────────────────────────────────────────────────

/**
 * Return all configured lanes (deep copy).
 */
export function getConfiguredLanes(): LaneConfig[] {
  return laneConfigSet.lanes.map((lane) => ({ ...lane }));
}

/**
 * Return only claimable lanes.
 */
export function getClaimableLanes(): LaneConfig[] {
  return getConfiguredLanes().filter((lane) => lane.claimable);
}

/**
 * Return the non-claimable "backlog" fallback lane, if configured.
 * Returns `undefined` when no non-claimable lane exists.
 */
export function getBacklogLane(): LaneConfig | undefined {
  return getConfiguredLanes().find((lane) => !lane.claimable);
}

/**
 * Check whether a lane id is configured.
 */
export function isValidLane(id: string): boolean {
  return getConfiguredLanes().some((lane) => lane.id === id);
}

/**
 * Check whether a lane id is both configured and claimable.
 */
export function isClaimableLane(id: string): boolean {
  return getConfiguredLanes().some((lane) => lane.id === id && lane.claimable);
}

/**
 * Look up a lane by id. Returns `undefined` when not found.
 */
export function getLaneById(id: string): LaneConfig | undefined {
  return getConfiguredLanes().find((lane) => lane.id === id);
}

/**
 * Return all configured lane ids.
 */
export function getLaneIds(): string[] {
  return getConfiguredLanes().map((lane) => lane.id);
}

/**
 * Check whether a lane id is the non-claimable (backlog) lane.
 */
export function isBacklogLane(id: string): boolean {
  const backlog = getBacklogLane();
  return backlog !== undefined && backlog.id === id;
}

// ─── Classification Helpers ──────────────────────────────────────────────────

/**
 * Return the default claimable lane.
 * Prefers a lane with role "default", falls back to the first claimable lane.
 */
export function getDefaultClaimableLane(): LaneConfig | undefined {
  const lanes = getConfiguredLanes();
  const explicitDefault = lanes.find((l) => l.claimable && l.role === "default");
  if (explicitDefault) return explicitDefault;
  return lanes.find((l) => l.claimable);
}

/**
 * Return the escalation lane, if configured.
 * Prefers a lane with role "escalation". Falls back to the default claimable
 * lane when no escalation lane exists — ensuring we never return an unknown id.
 */
export function getEscalationLane(): LaneConfig | undefined {
  const lanes = getConfiguredLanes();
  const explicitEscalation = lanes.find((l) => l.claimable && l.role === "escalation");
  if (explicitEscalation) return explicitEscalation;
  // Fall back to default claimable so we always have a valid lane id.
  return getDefaultClaimableLane();
}

/**
 * Signals used by heuristic classification to decide which lane an issue belongs to.
 */
export interface LaneSignals {
  /** Issue has backlog/not-ready indicators (status/backlog, placeholder, etc.) */
  isBacklog: boolean;
  /** Issue has escalation/high-complexity indicators (architecture, RFC, etc.) */
  isEscalation: boolean;
}

/**
 * Map heuristic signals to a configured lane id.
 * Never returns an unknown lane id — always falls back to the default claimable lane.
 */
export function classifyLaneFromSignals(signals: LaneSignals): string {
  if (signals.isBacklog) {
    const backlog = getBacklogLane();
    if (backlog) return backlog.id;
    // No non-claimable lane configured — fall back to default claimable.
    const defaultLane = getDefaultClaimableLane();
    if (defaultLane) return defaultLane.id;
  }

  if (signals.isEscalation) {
    const escalation = getEscalationLane();
    if (escalation) return escalation.id;
  }

  // Default: actionable issue -> default claimable lane.
  const defaultLane = getDefaultClaimableLane();
  if (defaultLane) return defaultLane.id;

  // Should never happen (config validation requires at least one claimable lane),
  // but provide a safe fallback.
  return "normal";
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a LaneConfigSet and throw on errors.
 */
function validateLaneConfigSet(config: LaneConfigSet): void {
  if (!Array.isArray(config.lanes) || config.lanes.length === 0) {
    throw new Error("Lane config must contain at least one lane");
  }

  const ids = new Set<string>();

  for (const lane of config.lanes) {
    if (typeof lane.id !== "string" || lane.id.trim().length === 0) {
      throw new Error(`Lane id must be a non-empty string, got: ${JSON.stringify(lane.id)}`);
    }

    if (ids.has(lane.id)) {
      throw new Error(`Duplicate lane id: ${lane.id}`);
    }
    ids.add(lane.id);

    if (typeof lane.title !== "string" || lane.title.trim().length === 0) {
      throw new Error(`Lane "${lane.id}" must have a non-empty title`);
    }

    if (typeof lane.claimable !== "boolean") {
      throw new Error(`Lane "${lane.id}" must have a boolean claimable field`);
    }
  }

  const hasClaimable = config.lanes.some((l) => l.claimable);
  if (!hasClaimable) {
    throw new Error("Lane config must contain at least one claimable lane");
  }
}
