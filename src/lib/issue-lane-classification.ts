import { VALID_LANES, isValidLane } from "@/types";

// Lane classification constants
export const LANE_NORMAL = "NORMAL" as const;
export const LANE_GPT = "GPT" as const;
export const LANE_BACKLOG = "BACKLOG" as const;

export type IssueLane = "NORMAL" | "GPT" | "BACKLOG";

// Confidence thresholds
const MIN_CONFIDENCE = 0.1;
const HIGH_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Validate that a lane string is one of the allowed values.
 */
export function validateLane(lane: unknown): IssueLane | null {
  if (typeof lane !== "string") return null;
  if (!isValidLane(lane)) return null;
  return lane as IssueLane;
}

/**
 * Validate confidence is a number in [0, 1].
 */
export function validateConfidence(value: unknown): number | null {
  if (typeof value === "number" && !isNaN(value) && value >= 0 && value <= 1) {
    return Math.round(value * 100) / 100; // Round to 2 decimal places
  }
  return null;
}

/**
 * Validate a lane classification result.
 * Returns the classification if valid, or null if invalid.
 */
export function validateClassification(input: unknown): {
  lane: IssueLane | null;
  confidence: number | null;
  reason: string | null;
  model: string | null;
} {
  if (!input || typeof input !== "object") {
    return { lane: null, confidence: null, reason: null, model: null };
  }

  const obj = input as Record<string, unknown>;
  const lane = validateLane(obj.lane);
  const confidence = validateConfidence(obj.confidence);
  const reason = typeof obj.reason === "string" && obj.reason.trim().length > 0
    ? obj.reason.trim()
    : null;
  const model = typeof obj.model === "string" && obj.model.trim().length > 0
    ? obj.model.trim()
    : null;

  return { lane, confidence, reason, model };
}

/**
 * Build a generic classification prompt for an issue.
 * This prompt is intentionally agent-agnostic and repo-agnostic.
 */
export function buildClassificationPrompt(issue: {
  title: string;
  body: string | null;
  labels: string[];
}): string {
  const labelStr = issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}\n` : "";

  let bodySection = "";
  if (issue.body && issue.body.trim().length > 0) {
    bodySection = `Body:\n${issue.body}\n`;
  }

  return `You are an issue classification assistant. Classify this GitHub issue into exactly one execution lane.

## Lane Definitions

- NORMAL: Concrete, scoped, testable implementation work suitable for a standard worker. Examples: bounded frontend/backend fixes, documentation, tests, CI/lint, release/version drift, dependency updates, concrete follow-up issues with clear acceptance criteria, lint coverage expansion, health check runbooks.

- GPT: Requires higher-judgment model support. Examples: architecture/security/API/auth boundary design, database/schema migration strategy, distributed/cross-service design, ambiguous product behavior, broad refactor planning, RFC/design/alternatives decisions, audit parent decomposition (broad parent/umbrella issues with no direct work remaining).

- BACKLOG: Not actionable yet — placeholder, missing enough detail, or a parent/umbrella item that hasn't been decomposed into concrete work.

## Routing Rules

1. Do NOT route to GPT only because labels include "needs-gpt", "escalated", "priority/p1", or because the issue came from an audit.
2. DO route broad audit parent/umbrella issues to GPT for decomposition/design unless already decomposed.
3. Documentation, tests, CI, lint, release/version drift, bounded frontend/backend fixes, and concrete follow-up issues usually go to NORMAL.
4. If the issue already contains a reasonable implementation approach and acceptance criteria, prefer NORMAL.
5. If confidence is low and the issue is not actionable, choose BACKLOG.

## Input

Title: ${escapeForPrompt(issue.title)}${labelStr}${bodySection}
## Output Format

Respond with valid JSON containing exactly these fields:
- lane: one of "NORMAL", "GPT", "BACKLOG"
- confidence: a number between 0.0 and 1.0 indicating your confidence in this classification
- reason: a brief explanation of why this lane was chosen (1-2 sentences)

Do not include any text outside the JSON object.`;
}

/**
 * Escape special characters for inclusion in prompts to avoid injection issues.
 */
function escapeForPrompt(text: string): string {
  return text.replace(/`/g, "\\`").replace(/\{/g, "{{").replace(/\}/g, "}}");
}

/**
 * Classify an issue using the provided classifier function.
 * The classifier is a generic function that takes the prompt and returns a classification result.
 * This allows injection of different LLM backends or mock classifiers for testing.
 */
export type LaneClassifier = (prompt: string) => Promise<{
  lane: string;
  confidence: number;
  reason: string;
}>;

/**
 * Default no-op classifier that returns NORMAL with low confidence.
 * Used when no LLM is available or for testing.
 */
export async function noopClassifier(_prompt: string): Promise<{
  lane: string;
  confidence: number;
  reason: string;
}> {
  return { lane: "NORMAL", confidence: 0.5, reason: "Default classification (no classifier available)" };
}

/**
 * Classify a single issue and return the validated result.
 */
export async function classifyIssue(
  issue: { title: string; body: string | null; labels: string[] },
  classifier: LaneClassifier = noopClassifier,
  modelSource: string = "default",
): Promise<{
  lane: IssueLane;
  confidence: number | null;
  reason: string;
  model: string;
}> {
  const prompt = buildClassificationPrompt(issue);

  let rawResult;
  try {
    rawResult = await classifier(prompt);
  } catch (error) {
    // Classification failure returns NORMAL with low confidence and logs the error
    console.error("Issue classification failed, defaulting to NORMAL:", error);
    return {
      lane: LANE_NORMAL,
      confidence: MIN_CONFIDENCE,
      reason: `Classification failed: ${error instanceof Error ? error.message : "unknown error"}`,
      model: modelSource,
    };
  }

  const validated = validateClassification(rawResult);

  // If validation fails entirely, default to NORMAL with low confidence
  if (!validated.lane) {
    return {
      lane: LANE_NORMAL,
      confidence: MIN_CONFIDENCE,
      reason: "Invalid model response, defaulted to NORMAL",
      model: modelSource,
    };
  }

  return {
    lane: validated.lane,
    confidence: validated.confidence ?? null,
    reason: validated.reason ?? "Classification applied",
    model: modelSource,
  };
}

/**
 * Apply lane routing rules to determine if escalation logic should be bypassed.
 * Returns true if the issue has labels that should NOT trigger GPT routing.
 */
export function shouldIgnoreEscalationLabels(labels: string[]): boolean {
  const escalationLabels = ["needs-gpt", "escalated"];
  return labels.some((l) => escalationLabels.includes(l));
}

/**
 * Check if an issue title/body suggests it's a broad audit parent/umbrella issue.
 */
export function isBroadAuditParent(issue: { title: string; body: string | null }): boolean {
  const text = [issue.title, issue.body].join(" ").toLowerCase();
  const umbrellaKeywords = [
    "audit",
    "decomposition",
    "parent",
    "umbrella",
    "overarching",
    "roadmap",
    "initiative",
    "epic",
    "program",
  ];
  return umbrellaKeywords.some((kw) => text.includes(kw));
}

/**
 * Check if an issue has concrete acceptance criteria (suggests NORMAL lane).
 */
export function hasAcceptanceCriteria(issue: { title: string; body: string | null }): boolean {
  const text = [issue.title, issue.body].join(" ").toLowerCase();
  const criteriaPatterns = [
    "acceptance criteri",
    "given.*when.*then",
    "checklist",
    "steps:",
    "todo:",
    "do:",
    "definition of done",
    "deliverable",
  ];
  return criteriaPatterns.some((pattern) => new RegExp(pattern).test(text));
}
