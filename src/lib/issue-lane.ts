import { VALID_CONFIDENCE } from "@/types";
import { classifyLaneFromSignals, isValidLane as isValidLaneConfig, LaneSignals } from "@/lib/lane-config";

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

// ─── Heuristic Lane Classification ────────────────────────────────────────────

/**
 * Shared escalation keyword list used by classifyLaneByHeuristics and
 * stale-backlog reclassification.
 */
const ESCALATION_KEYWORDS = [
  "architecture",
  "audit",
  "design doc",
  "rfc",
  "alternatives considered",
  "migration strategy",
  "cross-service",
  "distributed system",
  "audit parent",
  "parent issue",
  "umbrella",
  "decomposition",
];

/**
 * Shared backlog signal list.
 */
const BACKLOG_SIGNALS = [
  "status/backlog",
  "type/research",
  "tbd",
  "to be determined",
  "placeholder",
  "more details needed",
  "needs more info",
];

/**
 * Shared escalation label signals.
 */
const ESCALATION_LABELS = ["needs-escalation", "needs-gpt"];

/**
 * Evaluate heuristic signals for an issue. Returns structured signals that can
 * be mapped to a configured lane via classifyLaneFromSignals.
 */
export function evaluateLaneSignals(
  title: string,
  body: string | null,
  labels: string[],
): LaneSignals & { reason: string } {
  const text = `${title} ${body ?? ""}`.toLowerCase();
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));

  // Check backlog first (highest priority exclusion)
  for (const signal of BACKLOG_SIGNALS) {
    if (text.includes(signal) || labelSet.has(signal)) {
      return { isBacklog: true, isEscalation: false, reason: `Backlog signal detected: ${signal}` };
    }
  }

  // Explicit escalation labels take precedence over text heuristics
  if (ESCALATION_LABELS.some((s) => labelSet.has(s))) {
    return { isBacklog: false, isEscalation: true, reason: "Escalation label detected" };
  }

  // Check escalated signals
  const escalationMatches = ESCALATION_KEYWORDS.filter((s) => text.includes(s));
  if (escalationMatches.length > 0 && !labelSet.has("status/backlog")) {
    return { isBacklog: false, isEscalation: true, reason: `Escalation keywords: ${escalationMatches.join(", ")}` };
  }

  // Default: concrete, actionable issues
  return { isBacklog: false, isEscalation: false, reason: "Default classification: concrete implementation work" };
}

/**
 * Heuristic lane classification when model calls are unavailable.
 * Uses label patterns and issue content to infer the correct execution lane.
 * Returns a configured lane id — never an unknown string.
 */
export function classifyLaneByHeuristics(
  title: string,
  body: string | null,
  labels: string[],
): LaneClassification {
  const signals = evaluateLaneSignals(title, body, labels);

  let confidence: "high" | "medium" | "low" = "medium";
  if (signals.isBacklog) {
    confidence = "high";
  } else if (signals.isEscalation && ESCALATION_LABELS.some((l) => labels.map((x) => x.toLowerCase()).includes(l))) {
    confidence = "high";
  }

  return {
    lane: classifyLaneFromSignals({ isBacklog: signals.isBacklog, isEscalation: signals.isEscalation }),
    confidence,
    reason: signals.reason,
  };
}
