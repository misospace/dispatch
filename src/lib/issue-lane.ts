import { VALID_CONFIDENCE } from "@/types";
import { classifyLaneFromSignals, isValidLane as isValidLaneConfig } from "@/lib/lane-config";

/**
 * A lane classification result for an issue.
 */
export interface LaneClassification {
  /** The assigned execution lane id (e.g. "normal", "escalated", "backlog", or custom) */
  lane: string;
  /** Confidence in the classification */
  confidence: "high" | "medium" | "low";
  /** Human-readable reason for the classification */
  reason: string;
  /** Model or source that produced this classification */
  model?: string;
}

/**
 * Validate a lane value against configured lanes.
 * Delegates to lane-config which respects custom lane configuration.
 */
export function isValidLane(lane: unknown): lane is string {
  return typeof lane === "string" && isValidLaneConfig(lane);
}

/**
 * Validate a confidence value against known confidences.
 */
export function isValidConfidence(confidence: unknown): confidence is "high" | "medium" | "low" {
  return typeof confidence === "string" && VALID_CONFIDENCE.includes(confidence as "high" | "medium" | "low");
}

/**
 * Validate a lane classification object.
 * Returns the parsed result if valid, or null if invalid.
 */
export function parseLaneClassification(data: unknown): LaneClassification | null {
  if (typeof data !== "object" || data === null) return null;

  const obj = data as Record<string, unknown>;
  const lane = obj.lane;
  const confidence = obj.confidence;
  const reason = obj.reason;

  if (!isValidLane(lane)) return null;
  if (!isValidConfidence(confidence)) return null;
  if (typeof reason !== "string" || reason.trim().length === 0) return null;

  return {
    lane,
    confidence,
    reason: reason.trim().slice(0, 500),
    model: typeof obj.model === "string" ? obj.model : undefined,
  };
}

/**
 * Validate a full classification payload (Prisma data shape).
 */
export function validateLaneRecord(data: unknown): {
  valid: boolean;
  error?: string;
  parsed?: LaneClassification;
} {
  if (typeof data !== "object" || data === null) {
    return { valid: false, error: "classification must be an object" };
  }

  const obj = data as Record<string, unknown>;
  const lane = obj.lane;
  const confidence = obj.confidence;

  if (!isValidLane(lane)) {
    return { valid: false, error: `invalid lane: ${String(lane)}` };
  }
  if (!isValidConfidence(confidence)) {
    return { valid: false, error: `invalid confidence: ${String(confidence)}` };
  }

  const reason = typeof obj.reason === "string" ? obj.reason : "";
  if (reason.trim().length === 0) {
    return { valid: false, error: "reason is required and must be non-empty" };
  }

  return {
    valid: true,
    parsed: {
      lane,
      confidence,
      reason: reason.trim().slice(0, 500),
      model: typeof obj.model === "string" ? obj.model : undefined,
    },
  };
}

/**
 * Build a fallback classification when model classification fails.
 * Uses simple heuristics based on labels and title/body content.
 * Returns configured lane ids — never hardcoded strings.
 */
export function classifyByHeuristics(
  title: string,
  body: string | null,
  labels: string[],
): LaneClassification {
  const text = `${title} ${body ?? ""}`.toLowerCase();
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));

  // Check for backlog indicators
  if (labelSet.has("status/backlog") || labelSet.has("type/research")) {
    return {
      lane: classifyLaneFromSignals({ isBacklog: true, isEscalation: false }),
      confidence: "high",
      reason: "Issue marked as backlog or research type",
    };
  }

  // Check for escalated indicators (but not just priority/escalated labels)
  const escalationKeywords = [
    "architecture",
    "design doc",
    "rfc",
    "alternatives",
    "migration strategy",
    "cross-service",
    "distributed system",
    "audit parent",
    "parent issue",
    "umbrella",
    "decomposition",
  ];
  const hasEscalationKeyword = escalationKeywords.some((kw) => text.includes(kw));
  if (hasEscalationKeyword && !labelSet.has("status/backlog")) {
    return {
      lane: classifyLaneFromSignals({ isBacklog: false, isEscalation: true }),
      confidence: "medium",
      reason: "Issue contains architecture/design/audit decomposition keywords",
    };
  }

  // Default to normal for concrete, actionable issues
  return {
    lane: classifyLaneFromSignals({ isBacklog: false, isEscalation: false }),
    confidence: "medium",
    reason: "Default classification: concrete implementation work",
  };
}
