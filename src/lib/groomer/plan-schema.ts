import { getLaneIds } from "@/lib/lane-config";
import type { EvidenceCatalog } from "./plan-evidence";
import { catalogIds } from "./plan-evidence";
import {
  ACTIONABILITY_VALUES,
  CLOSE_REASON_VALUES,
  CONFIDENCE_VALUES,
  DEPENDENCY_STATE_VALUES,
  PATH_CHANGE_VALUES,
  PLAN_LABELS,
  PLAN_LIMITS as L,
  RELATION_VALUES,
  UNCERTAINTY_KIND_VALUES,
  VERIFICATION_VALUES,
  WORK_TYPE_VALUES,
} from "./plan";

type Schema = Record<string, unknown>;

const str = (maxLength: number, minLength = 1): Schema => ({ type: "string", minLength, maxLength });
const nullable = (schema: Schema): Schema => ({ anyOf: [{ type: "null" }, schema] });
const enumOf = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
const list = (items: Schema, maxItems: number): Schema => ({ type: "array", items, maxItems });
const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

/**
 * An array of evidence ids, enum-constrained to this run's catalog. With no
 * eligible ids the array is forced empty: an empty enum is not a valid
 * grammar, and an unconstrained string would invite invented refs.
 */
function refList(ids: string[], maxItems: number): Schema {
  return ids.length > 0 ? list(enumOf(ids), maxItems) : { type: "array", items: { type: "string" }, maxItems: 0 };
}

/**
 * JSON Schema for the GroomingPlan draft, sent as an OpenAI-style
 * `json_schema` response_format. On a grammar-constrained backend the model
 * can then only emit configured lanes, allowlisted labels, bounded strings
 * and arrays, and evidence ids that exist in this run's catalog.
 * validateGroomingPlan still runs afterwards for the cross-field invariants
 * a schema cannot express (readiness, close consistency, lane coherence).
 *
 * Without a catalog (no snapshot available) evidence ids are unconstrained
 * strings and the validator rejects any it does not know.
 */
export function buildGroomingPlanResponseSchema(catalog?: EvidenceCatalog): Schema {
  const laneIds = getLaneIds();
  const anyRef = catalog ? catalogIds(catalog) : null;
  const repoRef = catalog ? catalogIds(catalog, "repository") : null;
  const relatedRef = catalog ? catalogIds(catalog, "related_work") : null;
  const refs = (ids: string[] | null, maxItems: number) =>
    ids ? refList(ids, maxItems) : list(str(L.shortText), maxItems);
  const ref = (ids: string[] | null) => (ids ? enumOf(ids) : str(L.shortText));
  const confidence = enumOf(CONFIDENCE_VALUES);
  const labels = list(enumOf(PLAN_LABELS), L.labels);

  return obj({
    verdict: obj({
      actionability: enumOf(ACTIONABILITY_VALUES),
      workType: enumOf(WORK_TYPE_VALUES),
      confidence,
      lane: obj({
        id: laneIds.length > 0 ? enumOf(laneIds) : str(L.shortText),
        confidence,
        reason: str(L.shortText),
      }),
      summary: str(L.summary),
      rationale: str(L.text),
      evidenceRefs: refs(anyRef, L.evidenceRefs),
      uncertainties: list(
        obj({
          kind: enumOf(UNCERTAINTY_KIND_VALUES),
          question: str(L.shortText),
          material: { type: "boolean" },
        }),
        L.uncertainties,
      ),
    }),
    implementationBrief: nullable(
      obj({
        problem: str(L.text),
        verifiedCurrentBehavior: obj({
          statement: str(L.text),
          evidenceRefs: refs(anyRef, L.evidenceRefs),
        }),
        relevantPaths: repoRef && repoRef.length === 0
          ? { type: "array", items: { type: "object" }, maxItems: 0 }
          : list(obj({ ref: ref(repoRef), change: enumOf(PATH_CHANGE_VALUES) }), L.relevantPaths),
        filesToCreate: list(str(L.shortText), L.filesToCreate),
        invariants: list(str(L.shortText), L.listItems),
        inScope: list(str(L.shortText), L.listItems),
        outOfScope: list(str(L.shortText), L.listItems),
        dependencies: list(
          obj({
            ref: str(L.shortText),
            state: enumOf(DEPENDENCY_STATE_VALUES),
            evidenceRef: relatedRef && relatedRef.length === 0 ? { type: "null" } : nullable(ref(relatedRef)),
          }),
          L.dependencies,
        ),
        acceptanceCriteria: list(
          obj({ criterion: str(L.shortText), verification: enumOf(VERIFICATION_VALUES) }),
          L.listItems,
        ),
        tests: list(str(L.shortText), L.listItems),
      }),
    ),
    mutations: obj({
      labelsToAdd: labels,
      labelsToRemove: labels,
      proposedTitle: nullable(str(L.titleMax, L.titleMin)),
      proposedBody: nullable(str(L.body)),
      githubComment: nullable(str(L.comment)),
      close: nullable(
        obj({
          reason: enumOf(CLOSE_REASON_VALUES),
          rationale: str(L.text),
          evidenceRefs: refs(anyRef, L.evidenceRefs),
        }),
      ),
    }),
    decomposition: obj({
      required: { type: "boolean" },
      reason: nullable(str(L.text)),
      childBriefs: list(
        obj({
          title: str(L.titleMax, L.titleMin),
          problem: str(L.text),
          acceptanceCriteria: list(str(L.shortText), L.childCriteria),
        }),
        L.childBriefs,
      ),
    }),
    relatedWork: relatedRef && relatedRef.length === 0
      ? { type: "array", items: { type: "object" }, maxItems: 0 }
      : list(obj({ ref: ref(relatedRef), relation: enumOf(RELATION_VALUES), note: str(L.shortText) }), L.relatedWork),
  });
}
