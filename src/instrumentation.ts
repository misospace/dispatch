import { setLaneConfig } from "./lib/lane-config";
import type { LaneConfigSet } from "./lib/lane-config";

/**
 * Next.js instrumentation hook — runs once on server startup.
 *
 * Wires runtime lane configuration via the `DISPATCH_LANE_CONFIG_JSON` env var.
 * If unset, the default lane config (local/cloud/frontier/backlog) is used.
 *
 * Example env var (single-line JSON):
 *   DISPATCH_LANE_CONFIG_JSON='{"lanes":[{"id":"local","title":"Local","claimable":true,"role":"default"},{"id":"frontier","title":"Frontier","claimable":true,"role":"escalation"},{"id":"backlog","title":"Backlog","claimable":false}],"laneAliases":{"normal":"local","escalated":"frontier"}}'
 */
export async function register() {
  const raw = process.env.DISPATCH_LANE_CONFIG_JSON;
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw) as LaneConfigSet;
    setLaneConfig(parsed);
    // eslint-disable-next-line no-console
    console.log(`[lane-config] Loaded ${parsed.lanes.length} lanes from DISPATCH_LANE_CONFIG_JSON`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[lane-config] Failed to parse DISPATCH_LANE_CONFIG_JSON:", err);
  }
}
