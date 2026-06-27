import { STATUS_LABELS, PRIORITY_LABELS, isValidGroomAction, type GroomAction } from "@/types";
import { isValidLane } from "@/lib/lane-config";

export interface GroomerOutput {
  actionability?: "ready" | "needs_info" | "blocked" | "backlog" | "already_done";
  confidence?: "high" | "medium" | "low";
  labelsToAdd: string[];
  labelsToRemove: string[];
  lane: { id: string; confidence: "high" | "medium" | "low"; reason: string };
  summary?: string;
  githubComment?: string;
  needsInfoReason?: string;
  blockedReason?: string;
  nextGroomingAction?: GroomAction;
}

const validTypeLabels = ["type/bug", "type/feature", "type/chore", "type/research", "type/security"];
const allowedLabelPrefixes = new Set(["status/", "priority/", "type/"]);

export function validateGroomerOutput(data: unknown): {
  valid: boolean;
  parsed?: GroomerOutput;
  errors?: string[];
} {
  const errors: string[] = [];

  if (typeof data !== "object" || data === null) {
    return { valid: false, errors: ["output must be an object"] };
  }

  const obj = data as Record<string, unknown>;

  if (
    "actionability" in obj &&
    !["ready", "needs_info", "blocked", "backlog", "already_done"].includes(String(obj.actionability))
  ) {
    errors.push(`invalid actionability: ${String(obj.actionability)}`);
  }

  if ("confidence" in obj && !["high", "medium", "low"].includes(String(obj.confidence))) {
    errors.push(`invalid top-level confidence: ${String(obj.confidence)}`);
  }

  // Validate labelsToAdd
  const labelsToAdd = Array.isArray(obj.labelsToAdd) ? obj.labelsToAdd : [];
  for (const label of labelsToAdd) {
    if (typeof label !== "string") {
      errors.push(`labelsToAdd contains non-string: ${JSON.stringify(label)}`);
      continue;
    }
    if (label.startsWith("agent/")) {
      errors.push(`labelsToAdd must not contain agent/* labels: ${label}`);
      continue;
    }
    if (!isAllowedLabel(label)) {
      errors.push(`labelsToAdd contains disallowed label: ${label}`);
    }
  }

  // Validate labelsToRemove
  const labelsToRemove = Array.isArray(obj.labelsToRemove) ? obj.labelsToRemove : [];
  for (const label of labelsToRemove) {
    if (typeof label !== "string") {
      errors.push(`labelsToRemove contains non-string: ${JSON.stringify(label)}`);
      continue;
    }
    if (label.startsWith("agent/")) {
      errors.push(`labelsToRemove must not remove agent/* labels: ${label}`);
      continue;
    }
    if (!isAllowedLabel(label)) {
      errors.push(`labelsToRemove contains disallowed label: ${label}`);
    }
  }

  // Validate lane
  const lane = obj.lane;
  if (typeof lane !== "object" || lane === null) {
    errors.push("lane is required");
  } else {
    const laneObj = lane as Record<string, unknown>;
    const laneId = laneObj.id;
    const confidence = laneObj.confidence;
    const reason = laneObj.reason;

    if (typeof laneId !== "string" || !isValidLane(laneId)) {
      errors.push(`invalid lane id: ${String(laneId)}`);
    }
    if (!["high", "medium", "low"].includes(String(confidence))) {
      errors.push(`invalid confidence: ${String(confidence)}`);
    }
    if (typeof reason !== "string" || !reason.trim()) {
      errors.push("lane reason is required and must be non-empty");
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const parsed: GroomerOutput = {
    labelsToAdd,
    labelsToRemove,
    lane: {
      id: (lane as any).id,
      confidence: (lane as any).confidence,
      reason: ((lane as any).reason as string).trim(),
    },
  };

  if ("actionability" in obj) {
    parsed.actionability = obj.actionability as GroomerOutput["actionability"];
  }
  if ("confidence" in obj) {
    parsed.confidence = obj.confidence as GroomerOutput["confidence"];
  }

  // Tolerate null for optional string fields: treat null the same as absent.
  // Non-null non-string values are still rejected.

  if ("summary" in obj && typeof obj.summary === "string") {
    parsed.summary = obj.summary;
  } else if ("summary" in obj && obj.summary !== null) {
    errors.push("summary must be a string");
    return { valid: false, errors };
  }

  if ("githubComment" in obj && obj.githubComment !== null && typeof obj.githubComment !== "string") {
    errors.push("githubComment must be a string");
    return { valid: false, errors };
  } else if ("githubComment" in obj && obj.githubComment !== null) {
    parsed.githubComment = obj.githubComment as string;
  }

  if ("needsInfoReason" in obj && obj.needsInfoReason !== null && typeof obj.needsInfoReason !== "string") {
    errors.push("needsInfoReason must be a string");
    return { valid: false, errors };
  } else if ("needsInfoReason" in obj && obj.needsInfoReason !== null) {
    parsed.needsInfoReason = obj.needsInfoReason as string;
  }

  if ("blockedReason" in obj && obj.blockedReason !== null && typeof obj.blockedReason !== "string") {
    errors.push("blockedReason must be a string");
    return { valid: false, errors };
  } else if ("blockedReason" in obj && obj.blockedReason !== null) {
    parsed.blockedReason = obj.blockedReason as string;
  }

  if ("nextGroomingAction" in obj && obj.nextGroomingAction !== null) {
    if (typeof obj.nextGroomingAction !== "string") {
      errors.push("nextGroomingAction must be a string");
      return { valid: false, errors };
    }
    if (!isValidGroomAction(obj.nextGroomingAction)) {
      errors.push(`invalid nextGroomingAction: ${obj.nextGroomingAction}`);
      return { valid: false, errors };
    }
    parsed.nextGroomingAction = obj.nextGroomingAction;
  }

  return { valid: true, parsed };
}

function isAllowedLabel(label: string): boolean {
  if (STATUS_LABELS.some((s) => s === label)) return true;
  if (PRIORITY_LABELS.some((s) => s === label)) return true;
  if (validTypeLabels.includes(label)) return true;
  return false;
}
