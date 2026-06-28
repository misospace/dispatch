import { z } from "zod";
import { STATUS_LABELS, PRIORITY_LABELS, type GroomAction } from "@/types";
import { resolveEnumConfig, type ResolutionEvent } from "./enum-config";
import type { EnumConfig } from "./enum-config";
import { GROOMER_ENUM_CONFIGS } from "./enum-configs";

// ─── Public Types ─────────────────────────────────────────────────────────────

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

export interface ValidationResult {
  valid: boolean;
  parsed?: GroomerOutput;
  errors?: string[];
  resolutions?: ResolutionEvent[];
}

// ─── Label Validation (unchanged — prefix-based, not enum) ────────────────────

const validTypeLabels = ["type/bug", "type/feature", "type/chore", "type/research", "type/security"];

function isAllowedLabel(label: string): boolean {
  if (STATUS_LABELS.some((s) => s === label)) return true;
  if (PRIORITY_LABELS.some((s) => s === label)) return true;
  if (validTypeLabels.includes(label)) return true;
  return false;
}

function validateLabelList(list: unknown[], kind: string): string[] {
  const errors: string[] = [];
  for (const label of list) {
    if (typeof label !== "string") {
      errors.push(`${kind} contains non-string: ${JSON.stringify(label)}`);
      continue;
    }
    if (label.startsWith("agent/")) {
      errors.push(`${kind} must not contain agent/* labels: ${label}`);
      continue;
    }
    if (!isAllowedLabel(label)) {
      errors.push(`${kind} contains disallowed label: ${label}`);
    }
  }
  return errors;
}

// ─── Enum Resolution Helper ───────────────────────────────────────────────────

/**
 * Validate a single enum value against its config. Returns { error, resolvedValue }.
 * - If the value is in validValues → no error, returns as-is.
 * - If the value is in aliases  → no error, returns canonical (caller records ResolutionEvent).
 * - Otherwise → returns an error string.
 */
function validateEnumValue(
  rawValue: unknown,
  fieldPath: string,
  validValues: readonly string[],
  aliases: Record<string, string>,
): { error?: string; resolvedValue?: string } {
  if (typeof rawValue !== "string") {
    return { error: `invalid ${fieldPath}: ${JSON.stringify(rawValue)}` };
  }

  // Direct match
  if (validValues.includes(rawValue)) {
    return { resolvedValue: rawValue };
  }

  // Alias match
  const canonical = aliases[rawValue];
  if (canonical !== undefined && validValues.includes(canonical)) {
    return { resolvedValue: canonical };
  }

  return { error: `invalid ${fieldPath}: ${rawValue}` };
}

/**
 * Resolve an enum value to its canonical form. Assumes already validated.
 */
function resolveEnumValue(rawValue: string, config: EnumConfig<string>): string {
  const resolved = resolveEnumConfig(config);
  if (resolved.validValues.includes(rawValue)) return rawValue;
  const canonical = resolved.aliases[rawValue];
  if (canonical !== undefined && resolved.validValues.includes(canonical)) return canonical;
  return rawValue; // fallback — should not reach here after validation
}

// ─── Zod Base Schema ──────────────────────────────────────────────────────────

/** Minimal zod schema for structural validation (types, required fields). */
const baseSchema = z.object({
  labelsToAdd: z.array(z.unknown()).default([]),
  labelsToRemove: z.array(z.unknown()).default([]),
  lane: z.object({
    id: z.unknown(),
    confidence: z.unknown(),
    reason: z.unknown(),
  }),
});

// ─── Optional String Fields ───────────────────────────────────────────────────

const OPTIONAL_STRING_FIELDS: (keyof Pick<GroomerOutput, "summary" | "githubComment" | "needsInfoReason" | "blockedReason">)[] = [
  "summary",
  "githubComment",
  "needsInfoReason",
  "blockedReason",
];

// ─── Main Validator ───────────────────────────────────────────────────────────

export function validateGroomerOutput(data: unknown): ValidationResult {
  const errors: string[] = [];
  const resolutions: ResolutionEvent[] = [];

  // Must be an object
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { valid: false, errors: ["output must be an object"] };
  }

  // Structural validation via zod
  const parsedBase = baseSchema.safeParse(data);
  if (!parsedBase.success) {
    const zodErrors = parsedBase.error.issues.map((e) =>
      `${e.path.join(".")}: ${e.message}`,
    );
    return { valid: false, errors: zodErrors };
  }

  const obj = data as Record<string, unknown>;
  const labelsToAdd = Array.isArray(obj.labelsToAdd) ? (obj.labelsToAdd as unknown[]) : [];
  const labelsToRemove = Array.isArray(obj.labelsToRemove) ? (obj.labelsToRemove as unknown[]) : [];

  // ── Label validation (unchanged) ──
  errors.push(...validateLabelList(labelsToAdd, "labelsToAdd"));
  errors.push(...validateLabelList(labelsToRemove, "labelsToRemove"));

  // ── Lane object validation ──
  const lane = obj.lane;
  if (typeof lane !== "object" || lane === null) {
    errors.push("lane is required");
  } else {
    const laneObj = lane as Record<string, unknown>;

    // lane.id — enum with alias resolution
    const laneIdConfig = resolveEnumConfig(GROOMER_ENUM_CONFIGS["lane.id"]);
    const laneIdResult = validateEnumValue(
      laneObj.id,
      "lane id",
      laneIdConfig.validValues,
      laneIdConfig.aliases,
    );
    if (laneIdResult.error) {
      errors.push(laneIdResult.error);
    } else {
      // If aliased, record a resolution event
      if (typeof laneObj.id === "string" && laneIdResult.resolvedValue !== laneObj.id) {
        resolutions.push({
          field: "lane.id",
          rawValue: laneObj.id,
          resolvedValue: laneIdResult.resolvedValue!,
          source: "alias",
        });
      }
    }

    // lane.confidence — enum (no aliases configured)
    const confConfig = resolveEnumConfig(GROOMER_ENUM_CONFIGS["lane.confidence"]);
    const confResult = validateEnumValue(
      laneObj.confidence,
      "confidence",
      confConfig.validValues,
      confConfig.aliases,
    );
    if (confResult.error) {
      errors.push(confResult.error);
    }

    // lane.reason — non-empty string
    if (typeof laneObj.reason !== "string" || !laneObj.reason.trim()) {
      errors.push("lane reason is required and must be non-empty");
    }
  }

  // ── Top-level enum fields ──

  // actionability
  let resolvedActionability: string | undefined;
  if ("actionability" in obj) {
    const actConfig = resolveEnumConfig(GROOMER_ENUM_CONFIGS["actionability"]);
    const actResult = validateEnumValue(
      obj.actionability,
      "actionability",
      actConfig.validValues,
      actConfig.aliases,
    );
    if (actResult.error) {
      errors.push(actResult.error);
    } else {
      resolvedActionability = actResult.resolvedValue;
      if (typeof obj.actionability === "string" && actResult.resolvedValue !== obj.actionability) {
        resolutions.push({
          field: "actionability",
          rawValue: obj.actionability,
          resolvedValue: actResult.resolvedValue!,
          source: "alias",
        });
      }
    }
  }

  // confidence (top-level)
  let resolvedConfidence: string | undefined;
  if ("confidence" in obj) {
    const confConfig = resolveEnumConfig(GROOMER_ENUM_CONFIGS["confidence"]);
    const confResult = validateEnumValue(
      obj.confidence,
      "top-level confidence",
      confConfig.validValues,
      confConfig.aliases,
    );
    if (confResult.error) {
      errors.push(confResult.error);
    } else {
      resolvedConfidence = confResult.resolvedValue;
      if (typeof obj.confidence === "string" && confResult.resolvedValue !== obj.confidence) {
        resolutions.push({
          field: "confidence",
          rawValue: obj.confidence,
          resolvedValue: confResult.resolvedValue!,
          source: "alias",
        });
      }
    }
  }

  // ── Early exit on validation errors ──
  if (errors.length > 0) {
    return { valid: false, errors, resolutions };
  }

  // ── Build parsed output ──
  const laneObj = lane as Record<string, unknown>;
  const resolvedLaneId = resolveEnumValue(
    laneObj.id as string,
    GROOMER_ENUM_CONFIGS["lane.id"],
  );

  const parsed: GroomerOutput = {
    labelsToAdd: labelsToAdd as string[],
    labelsToRemove: labelsToRemove as string[],
    lane: {
      id: resolvedLaneId,
      confidence: laneObj.confidence as GroomerOutput["lane"]["confidence"],
      reason: (laneObj.reason as string).trim(),
    },
  };

  if (resolvedActionability !== undefined) {
    parsed.actionability = resolvedActionability as GroomerOutput["actionability"];
  }

  if (resolvedConfidence !== undefined) {
    parsed.confidence = resolvedConfidence as GroomerOutput["confidence"];
  }

  // Optional string fields — null tolerance (null treated as absent)
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (!(field in obj)) continue;
    const val = (obj as Record<string, unknown>)[field];
    if (val === null) continue; // treat as omitted
    if (typeof val !== "string") {
      errors.push(`${field} must be a string`);
      return { valid: false, errors, resolutions };
    }
    (parsed as unknown as Record<string, unknown>)[field] = val;
  }

  // nextGroomingAction — null tolerance + enum validation
  if ("nextGroomingAction" in obj) {
    const rawVal = obj.nextGroomingAction;
    if (rawVal === null) {
      // treat as omitted — skip
    } else if (typeof rawVal !== "string") {
      errors.push("nextGroomingAction must be a string");
      return { valid: false, errors, resolutions };
    } else {
      const ngaConfig = resolveEnumConfig(GROOMER_ENUM_CONFIGS["nextGroomingAction"]);
      const ngaResult = validateEnumValue(
        rawVal,
        "nextGroomingAction",
        ngaConfig.validValues,
        ngaConfig.aliases,
      );
      if (ngaResult.error) {
        errors.push(ngaResult.error);
        return { valid: false, errors, resolutions };
      }
      parsed.nextGroomingAction = ngaResult.resolvedValue as GroomAction;

      // Record resolution event if aliased
      if (ngaResult.resolvedValue !== rawVal) {
        resolutions.push({
          field: "nextGroomingAction",
          rawValue: rawVal,
          resolvedValue: ngaResult.resolvedValue!,
          source: "alias",
        });
      }
    }
  }

  return { valid: true, parsed, resolutions };
}
