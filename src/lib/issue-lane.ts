import { VALID_LANES, VALID_CONFIDENCE } from "@/types";

/**
 * A lane classification result for an issue.
 */
export interface LaneClassification {
  /** The assigned execution lane */
  lane: "normal" | "escalated" | "backlog";
  /** Confidence in the classification */
  confidence: "high" | "medium" | "low";
  /** Human-readable reason for the classification */
  reason: string;
  /** Model or source that produced this classification */
  model?: string;
}

/**
 * Validate a lane value against known lanes.
 */
export function isValidLane(lane: unknown): lane is "normal" | "escalated" | "backlog" {
  return typeof lane === "string" && VALID_LANES.includes(lane as "normal" | "escalated" | "backlog");
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
 * Build a prompt for the model to classify an issue's execution lane.
 * This prompt is generic — no hardcoded agent names, repo names, or owner names.
 */
export function buildLaneClassificationPrompt(
  title: string,
  body: string | null,
  labels: string[],
  state: string,
): string {
  const truncatedBody = body ? (body.length > 8000 ? body.slice(0, 8000) + "\n...[truncated]" : body) : "(no body)";

  return `You are a task routing assistant. Classify this GitHub issue into an execution lane.

Return ONLY compact JSON with this exact schema:
{"lane":"normal"|"escalated"|"backlog","confidence":"high"|"medium"|"low","reason":"short reason"}

Lane definitions:
- normal: concrete, scoped, testable implementation work suitable for a normal worker.
- escalated: requires higher-judgment model support, such as architecture/security/API/auth boundary design, database/schema migration strategy, distributed/cross-service design, ambiguous product behavior, broad refactor planning, RFC/design/alternatives decisions, or audit parent decomposition.
- backlog: not actionable yet, placeholder, missing enough detail, or a parent/umbrella item with no direct work remaining.

Routing rules:
- Do not route to escalated only because labels include needs-escalation, escalated, priority/p1, or because the issue came from an audit.
- Do route broad audit parent/umbrella issues to escalated for decomposition/design unless already decomposed.
- Documentation, tests, CI, lint, release/version drift, bounded frontend/backend fixes, and concrete follow-up issues usually go to normal.
- If the issue already contains a reasonable implementation approach and acceptance criteria, prefer normal.
- If confidence is low and the issue is not actionable, choose backlog.

Issue:
title: ${title}
state: ${state}
labels: ${labels.join(", ") || "(none)"}

body:
${truncatedBody}`;
}

/**
 * Build a fallback classification when model classification fails.
 * Uses simple heuristics based on labels and title/body content.
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
    return { lane: "backlog", confidence: "high", reason: "Issue marked as backlog or research type" };
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
    return { lane: "escalated", confidence: "medium", reason: "Issue contains architecture/design/audit decomposition keywords" };
  }

  // Default to normal for concrete, actionable issues
  return { lane: "normal", confidence: "medium", reason: "Default classification: concrete implementation work" };
}

/**
 * Generate a safe JSON string from classification data for Prisma storage.
 */
export function serializeLaneData(classification: LaneClassification): Record<string, unknown> {
  return {
    lane: classification.lane,
    confidence: classification.confidence,
    reason: classification.reason.slice(0, 500),
    model: classification.model ?? null,
  };
}
