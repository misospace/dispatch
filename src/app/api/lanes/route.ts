import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest } from "@/lib/auth";
import { getConfiguredLanes } from "@/lib/lane-config";

/**
 * Returns the configured lane topology so external workers can resolve lanes
 * by ROLE instead of hardcoding this deployment's lane ids.
 *
 * A worker that needs "the escalation lane" previously had to be told a literal
 * id (`ESCALATION_LANE=frontier`) — a setting whose name is a role and whose
 * value is deployment-specific, so renaming a lane silently broke the link and
 * every adopter hand-synced lane names across two systems.
 *
 * This is a pure reflection of DISPATCH_LANE_CONFIG_JSON. It hardcodes no lane
 * names: a deployment running the shipped default gets back `default` and
 * `backlog`, one running five tiers gets five. `role` is validated to be unique
 * across claimable lanes (see validateLaneConfigSet), so "the lane with role X"
 * is a well-defined question.
 */
export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  try {
    // getConfiguredLanes already deep-copies, so the response cannot alias the
    // module-level config.
    return NextResponse.json(getConfiguredLanes());
  } catch (error) {
    return handleApiError("list lanes", error);
  }
}
