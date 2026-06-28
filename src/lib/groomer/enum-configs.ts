/**
 * Registry of enum field configurations for the groomer output validator.
 *
 * Each key is a dot-notation path matching the groomer output shape.
 * Adding a new enum field = appending an entry here. No validator changes needed.
 *
 * Lane config (validValues + aliases) is resolved lazily so that env-driven
 * lane topologies are respected at validation time.
 */

import { getConfiguredLanes, getLaneAliases } from "@/lib/lane-config";
import type { EnumConfig } from "./enum-config";

/**
 * Canonical enum configs for every groomer output enum field.
 *
 * Status, priority, and type labels are intentionally excluded — they use
 * prefix-based validation (isAllowedLabel) and are not closed enums.
 */
export const GROOMER_ENUM_CONFIGS: Record<string, EnumConfig> = {
  "lane.id": {
    field: "lane.id",
    resolveValidValues: () =>
      getConfiguredLanes().map((l) => l.id) as readonly string[],
    aliases: () => getLaneAliases() as Record<string, string>,
  },

  "lane.confidence": {
    field: "lane.confidence",
    validValues: ["high", "medium", "low"],
  },

  confidence: {
    field: "confidence",
    validValues: ["high", "medium", "low"],
  },

  actionability: {
    field: "actionability",
    validValues: ["ready", "needs_info", "blocked", "backlog", "already_done"],
  },

  nextGroomingAction: {
    field: "nextGroomingAction",
    validValues: [
      "promote_to_ready",
      "escalate",
      "mark_not_ready",
      "mark_needs_info",
      "mark_blocked",
    ],
  },
};
