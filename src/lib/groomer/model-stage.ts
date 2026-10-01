/**
 * The hosted groomer's model stage: ask for a GroomingPlan and validate it,
 * with one repair turn and a narrow degradation path (dispatch#1126).
 *
 * Most failed grooms were a usable plan with one field in the wrong format,
 * or a final answer that was not JSON at all (stray <tool_call> text). Each
 * such failure discarded a full grooming pass. Instead:
 *  1. When the answer does not parse or does not validate, the model gets
 *     its own answer back with the exact errors and one chance to correct
 *     it, within what is left of the run's time budget.
 *  2. When the last usable answer still fails only on non-load-bearing
 *     fields, the draft is degraded (see plan-degrade.ts) and validated
 *     again, with a context warning per change.
 *  3. Anything else fails the run as before, with every attempt's errors.
 */

import type { callGroomerLLM, CallLlmOptions } from "./llm";
import type { GroomingPlanValidationResult, validateGroomingPlan } from "./plan";
import type { EvidenceCatalog } from "./plan-evidence";
import { degradePlanDraft } from "./plan-degrade";
import { sanitizeForStorage, sanitizeJsonForStorage, sanitizeModelJson } from "./sanitize";

/**
 * A repair turn left less than this (or less than the configured per-call
 * timeout, when that is shorter) is skipped: it could not finish a plan.
 */
export const MIN_REPAIR_TIMEOUT_MS = 30_000;

export interface ModelStageInput {
  callLLM: typeof callGroomerLLM;
  validateOutput: typeof validateGroomingPlan;
  /** The grooming call. Its timeoutMs also caps the repair turn. */
  llm: CallLlmOptions;
  catalog: EvidenceCatalog;
  /**
   * Epoch ms by which the repair turn must be done. It gets whatever remains
   * (at most llm.timeoutMs) and is skipped when that is too little.
   */
  deadline?: number;
}

export interface ModelStageResult {
  /** What to persist as the run's raw output. */
  rawOutput: unknown;
  /** Valid, or invalid with every attempt's errors. */
  validation: GroomingPlanValidationResult;
  /** Context warnings: the repair turn and each degradation. */
  warnings: string[];
}

interface Attempt {
  /** The parsed answer; undefined when it was not JSON or the call failed. */
  output?: unknown;
  /** The answer as the model sent it, for the repair turn and history. */
  response: string;
  errors: string[];
  validation?: GroomingPlanValidationResult;
}

/**
 * The full answer behind a parse failure. Duck-typed rather than an
 * instanceof check so a mocked llm module (tests, the eval corpus) keeps
 * working; see GroomerOutputParseError.
 */
function unparsedResponse(err: unknown): string | null {
  if (!(err instanceof Error) || err.name !== "GroomerOutputParseError") return null;
  const content = (err as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function responseText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

const MAX_WARNING_ERRORS = 5;

function summarizeErrors(errors: string[]): string {
  const shown = errors.slice(0, MAX_WARNING_ERRORS).join("; ");
  return errors.length > MAX_WARNING_ERRORS ? `${shown}; and ${errors.length - MAX_WARNING_ERRORS} more` : shown;
}

/**
 * Run the model stage and make what it returns safe to persist: the raw
 * output (parsed JSON, a non-JSON answer's text, or both attempts), the
 * validation errors and the warnings all carry model text, and one NUL byte
 * in any of them would fail the GroomingRun write (see sanitizeForStorage).
 */
export async function runModelStage(input: ModelStageInput): Promise<ModelStageResult> {
  const result = await modelStage(input);
  const { validation } = result;
  return {
    rawOutput: sanitizeJsonForStorage(result.rawOutput),
    validation: validation.valid ? validation : { ...validation, errors: validation.errors?.map((e) => sanitizeForStorage(e)) },
    warnings: result.warnings.map((w) => sanitizeForStorage(w)),
  };
}

async function modelStage(input: ModelStageInput): Promise<ModelStageResult> {
  const { callLLM, validateOutput, llm, catalog } = input;
  const validate = (output: unknown) => validateOutput(output, { catalog });

  // Strip NUL and the other C0 control characters from the model's answer once,
  // before validation (dispatch#1130). This is the single point where model text
  // becomes safe, so the validated plan is exactly what later reaches storage
  // (GroomingRun.validatedOutput) and the mutation applier (Issue.groomingSummary,
  // IssueLane.reason, the GitHub comment body). It does not truncate: field length
  // limits stay the validator's, so a plan that is only too long is still rejected
  // for length instead of being silently shortened. The parse-failure responses
  // below keep echoing the model's own text verbatim because they are built from
  // the raw content, not from this sanitized object. A field that is only
  // control characters strips to empty and then fails its minimum, routing it
  // to the repair turn rather than persisting garbage.
  const judge = (rawAnswer: unknown): Attempt => {
    const output = sanitizeModelJson(rawAnswer);
    const validation = validate(output);
    return { output, response: responseText(output), errors: validation.valid ? [] : (validation.errors ?? []), validation };
  };

  // The first answer. A parse failure is the model's to fix; any other
  // error (timeout, API error) is not, and fails the run as before.
  let first: Attempt;
  let firstError: unknown = null;
  try {
    first = judge(await callLLM(llm));
  } catch (err) {
    const response = unparsedResponse(err);
    if (response === null) throw err;
    firstError = err;
    first = { response, errors: [(err as Error).message] };
  }
  if (first.validation?.valid) return { rawOutput: first.output, validation: first.validation, warnings: [] };

  // One repair turn, bounded by what the run has left.
  const remaining = input.deadline === undefined ? llm.timeoutMs : input.deadline - Date.now();
  const repairTimeoutMs = Math.min(llm.timeoutMs, remaining);
  let repair: Attempt | null = null;
  if (repairTimeoutMs >= Math.min(llm.timeoutMs, MIN_REPAIR_TIMEOUT_MS)) {
    try {
      repair = judge(
        await callLLM({ ...llm, timeoutMs: repairTimeoutMs, repair: { previousResponse: first.response, errors: first.errors } }),
      );
    } catch (err) {
      const response = unparsedResponse(err);
      repair = { response: response ?? "", errors: [err instanceof Error ? err.message : String(err)] };
    }
    if (repair.validation?.valid) {
      return {
        rawOutput: repair.output,
        validation: repair.validation,
        warnings: [`model: the repair turn fixed the first answer, which failed with: ${summarizeErrors(first.errors)}`],
      };
    }
  } else {
    console.warn(`[groomer] skipped the repair turn: only ${Math.max(0, remaining)}ms left in the run's budget`);
  }

  // Degrade the latest answer that parsed, when only non-load-bearing
  // fields are wrong. Re-validation decides; nothing is trusted from here.
  const last = repair?.validation ? repair : first.validation ? first : null;
  let degradeErrors: string[] = [];
  const degraded = last ? degradePlanDraft(last.output, last.errors) : null;
  if (last && degraded) {
    const validation = validate(degraded.output);
    // A removed repository id must still be cited elsewhere: the freshness
    // baseline tracks the files a plan cites, so losing the only citation of
    // a path would silently stop re-grooming when that file changes.
    const cited = new Set(validation.plan?.citations.map((c) => c.id) ?? []);
    const untracked = degraded.removedRefs.filter(
      (ref) => !cited.has(ref) && catalog.entries.some((e) => e.id === ref && e.subject === "repository"),
    );
    if (!validation.valid) {
      degradeErrors = validation.errors ?? [];
    } else if (untracked.length > 0) {
      degradeErrors = untracked.map(
        (ref) => `${ref} is cited only in a field that takes related-work ids; dropping it would stop freshness tracking that file`,
      );
    } else {
      const warnings = [...degraded.warnings];
      if (repair) warnings.unshift(`model: the repair turn did not fix every error; degraded the ${last === repair ? "repaired" : "first"} answer`);
      return { rawOutput: last.output, validation, warnings };
    }
  }

  // No repair was possible: fail exactly as before.
  if (!repair) {
    if (firstError) throw firstError;
    return {
      rawOutput: first.output,
      validation: { ...first.validation!, errors: [...first.errors, ...degradeErrors.map((e) => `after degrading: ${e}`)] },
      warnings: [],
    };
  }

  // The repair failed too: keep both answers and both error sets.
  return {
    rawOutput: {
      firstAnswer: first.output ?? first.response,
      repairAnswer: repair.output ?? (repair.response || null),
    },
    validation: {
      valid: false,
      errors: [
        ...first.errors.map((e) => `first answer: ${e}`),
        ...repair.errors.map((e) => `repair: ${e}`),
        ...degradeErrors.map((e) => `after degrading: ${e}`),
      ],
    },
    warnings: [],
  };
}
