/**
 * The bounded execution-metadata contract for worker task reports (#1183).
 *
 * A worker may attach a small, optional identity bag to
 * `POST /api/agents/[agentName]/tasks/report` describing the product that
 * executed the attempt: which worker product ran it, the model it drove, the
 * reasoning effort actually in effect, the runtime/config revision, and the
 * experiment/cohort label. This module is the single validation point for
 * that bag; the report route applies it before anything is hashed or
 * persisted.
 *
 * The contract exists because the attempt chain (#1183,
 * `src/lib/work-attempt-chain.ts`) needs to say *which* worker produced an
 * attempt without inheriting whatever else happened to be in the payload:
 *
 * - Recognized keys ONLY — an unknown key fails the request (fail closed),
 *   so the bag cannot grow into a free-form side channel.
 * - Values are trimmed strings, non-empty, at most 128 characters, single
 *   line, printable ASCII only. This validation is STRUCTURAL ONLY: it is
 *   not a content filter. It keeps multiline payloads (prompts, error
 *   dumps) out of the column and bounds size, but a credential short
 *   enough to fit the shape would pass — workers must not send secrets,
 *   and Dispatch does not scan content.
 * - Values are preserved (trimmed) and never inferred: Dispatch never
 *   derives any of these fields from timestamps, deployment data, or the
 *   agent name.
 *
 * `undefined`/`null` validate to an empty bag — existing workers that send
 * nothing change nothing (backward compatible).
 */

export type ExecutionMetadata = Record<string, string>;

export type ParsedExecutionMetadata =
  | { ok: true; value: ExecutionMetadata }
  | { ok: false; error: string };

/** The only keys a worker may supply, and what each one means. */
export const EXECUTION_METADATA_KEYS = [
  "worker",
  "model",
  "reasoningEffort",
  "runtimeRevision",
  "cohortLabel",
] as const;

const MAX_VALUE_LENGTH = 128;

// Printable ASCII only: excludes tabs, newlines, control characters, and
// anything non-ASCII, which is what keeps multi-line payloads (prompts,
// error dumps) and encoded content out of the column.
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

export function parseExecutionMetadata(raw: unknown): ParsedExecutionMetadata {
  if (raw === undefined || raw === null) {
    return { ok: true, value: {} };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "executionMetadata must be an object" };
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    return {
      ok: false,
      error: `executionMetadata must carry at least one of: ${EXECUTION_METADATA_KEYS.join(", ")}`,
    };
  }

  const value: ExecutionMetadata = {};
  for (const [key, rawValue] of entries) {
    if (!(EXECUTION_METADATA_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        error: `executionMetadata.${key} is not a recognized key; recognized keys: ${EXECUTION_METADATA_KEYS.join(", ")}`,
      };
    }
    if (typeof rawValue !== "string") {
      return { ok: false, error: `executionMetadata.${key} must be a string` };
    }
    const trimmed = rawValue.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_VALUE_LENGTH ||
      !PRINTABLE_ASCII.test(trimmed)
    ) {
      return {
        ok: false,
        error: `executionMetadata.${key} must be a non-empty string of at most ${MAX_VALUE_LENGTH} printable ASCII characters on a single line`,
      };
    }
    value[key] = trimmed;
  }

  return { ok: true, value };
}
