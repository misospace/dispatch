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
  /** Unique identifier (e.g. "local", "cloud", "frontier", "backlog") */
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
  /**
   * Migration aliases: map old lane IDs to currently configured lane IDs.
   *
   * Used for read-time compatibility when deploying a custom lane set to an
   * existing install that has issues stored under the default lane names
   * (normal, escalated, backlog). Aliases are purely a read-time resolution
   * mechanism — they do not rewrite issue data.
   *
   * Example:
   *   { normal: "local", escalated: "frontier", backlog: "parking-lot" }
   */
  laneAliases?: Record<string, string>;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

/**
 * Default lane configuration — minimal, lane-agnostic.
 *
 * Ships with a single `default` claimable lane + `backlog` for non-actionable
 * items. Real lane topologies (local/cloud/frontier, etc.) are injected at
 * deploy time via `DISPATCH_LANE_CONFIG_JSON` env var (see module-load init below).
 */
const DEFAULT_LANE_CONFIG: LaneConfigSet = {
  lanes: [
    {
      id: "default",
      title: "Default",
      claimable: true,
      role: "default",
      description: "Default execution lane. Override via DISPATCH_LANE_CONFIG_JSON for multi-lane setups.",
      color: "#3b82f6",
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

// ─── Alias / Migration Helpers ────────────────────────────────────────────────

/**
 * Return the configured lane alias map (empty object if none).
 */
export function getLaneAliases(): Record<string, string> {
  return laneConfigSet.laneAliases ?? {};
}

/**
 * Resolve a stored lane ID through the alias map.
 *
 * - Returns `null` for null/undefined/empty input.
 * - Returns the original lane ID if it is a currently configured lane.
 * - Returns the mapped configured lane ID if an alias exists.
 * - Returns the original lane ID otherwise (preserves visibility of unknown lanes).
 *
 * This function never silently maps unknown lanes to a default — it only
 * resolves explicitly configured aliases.
 */
export function resolveLaneId(laneId: string | null | undefined): string | null {
  if (!laneId) return null;
  // Already a configured lane
  if (isValidLane(laneId)) return laneId;
  // Check aliases
  const aliases = getLaneAliases();
  const resolved = aliases[laneId];
  if (resolved && isValidLane(resolved)) return resolved;
  // Unknown lane — return as-is so UI can show "Unknown: <id>"
  return laneId;
}

/**
 * Check whether a lane ID is either configured or has an alias.
 * Returns true for null/undefined (treated as "no lane set", which is valid).
 */
export function isKnownOrAliasedLane(laneId: string | null | undefined): boolean {
  if (!laneId) return true;
  if (isValidLane(laneId)) return true;
  const aliases = getLaneAliases();
  return laneId in aliases;
}

/**
 * Return info about an unconfigured lane ID, if it is unknown.
 * Returns `null` when the lane is configured or aliased.
 */
export function getUnconfiguredLaneInfo(
  laneId: string | null | undefined,
): { rawId: string; isAliased: boolean; resolvedId?: string } | null {
  if (!laneId) return null;
  if (isValidLane(laneId)) return null;
  const aliases = getLaneAliases();
  const resolved = aliases[laneId];
  if (resolved && isValidLane(resolved)) {
    return { rawId: laneId, isAliased: true, resolvedId: resolved };
  }
  return { rawId: laneId, isAliased: false };
}

/**
 * Check whether a stored lane ID matches the given configured lane,
 * either directly or through an alias.
 */
export function laneMatchesConfigured(storedLane: string | null | undefined, configuredLaneId: string): boolean {
  if (!storedLane) return false;
  if (storedLane === configuredLaneId) return true;
  const aliases = getLaneAliases();
  return aliases[storedLane] === configuredLaneId;
}

/**
 * Resolve a request-time lane filter value.
 * Returns the configured lane ID if the input is valid or aliased,
 * or `null` if the input is unknown (caller should return 400).
 */
export function resolveRequestLane(lane: string | null | undefined): string | null {
  if (!lane) return null;
  if (isValidLane(lane)) return lane;
  const aliases = getLaneAliases();
  const resolved = aliases[lane];
  if (resolved && isValidLane(resolved)) return resolved;
  return null;
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

  // At most one CLAIMABLE lane per role. Consumers resolve "the escalation
  // lane" by role rather than by id (see /api/lanes), so two claimable lanes
  // declaring the same role makes getEscalationLane's "find the first" depend
  // on array order -- a silent, config-dependent answer. Roles stay optional:
  // a single-lane deployment needs neither.
  const byRole = new Map<string, string[]>();
  for (const lane of config.lanes) {
    if (!lane.claimable || !lane.role) continue;
    byRole.set(lane.role, [...(byRole.get(lane.role) ?? []), lane.id]);
  }
  for (const [role, laneIds] of byRole) {
    if (laneIds.length > 1) {
      throw new Error(
        `Role "${role}" is claimed by more than one claimable lane: ${laneIds.join(", ")}`,
      );
    }
  }

  // Validate aliases point to configured lanes
  if (config.laneAliases) {
    for (const [from, to] of Object.entries(config.laneAliases)) {
      if (!ids.has(to)) {
        throw new Error(`Lane alias "${from}" -> "${to}" references an unconfigured lane`);
      }
    }
  }
}

// ─── Environment Init (Module-Load Side Effect) ──────────────────────────────

/**
 * Initialize lane config from DISPATCH_LANE_CONFIG_JSON env var.
 *
 * This runs as a module-load side effect so the config is available in the same
 * module instance that route handlers import — avoiding Turbopack standalone
 * chunk isolation where instrumentation.ts would mutate a separate instance.
 *
 * Placed at the bottom of this file so all declarations (DEFAULT_LANE_CONFIG,
 * laneConfigSet, setLaneConfig, validateLaneConfigSet) are already initialized.
 */
(function initFromEnv(): void {
  const raw = process.env.DISPATCH_LANE_CONFIG_JSON;
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw) as LaneConfigSet;
    setLaneConfig(parsed);
    console.log(`[lane-config] Loaded ${parsed.lanes.length} lanes from DISPATCH_LANE_CONFIG_JSON`);
  } catch (err) {
    console.error("[lane-config] Failed to parse DISPATCH_LANE_CONFIG_JSON:", err);
  }
})();
