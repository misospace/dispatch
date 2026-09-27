import { describe, expect, it } from "vitest";
import { getLaneIds, setLaneConfig } from "@/lib/lane-config";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";
import { buildEvidenceCatalog } from "./plan-evidence";
import { buildGroomingPlanResponseSchema } from "./plan-schema";
import { PLAN_LABELS } from "./plan";

const snapshot: GroomingEvidenceSnapshot = {
  capturedAt: "2026-09-26T00:00:00.000Z",
  repoFullName: "org/repo",
  defaultBranch: "main",
  headSha: "abc123",
  pinnedRef: "abc123",
  issue: { number: 1, title: "t", body: null, labels: [], state: "open", updatedAt: "", url: "" },
  issueFingerprint: "fp",
  comments: [{ id: "5", author: "alice", createdAt: "", body: "b", provenance: "human_comment", authoritative: true }],
  evidenceDigest: "d",
  warnings: [],
  sources: [
    { path: "src/a.ts", provenance: "repository", via: "read", ref: "abc123" },
    { key: "github:pr:org/repo#2", provenance: "github_pull_request", state: "merged", url: null, via: "read", observedAt: "", ref: null },
  ],
};

type Node = Record<string, any>;

function walk(node: unknown, visit: (n: Node, path: string) => void, path = "$"): void {
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  visit(n, path);
  if (n.properties) for (const [k, v] of Object.entries(n.properties)) walk(v, visit, `${path}.${k}`);
  if (n.items) walk(n.items, visit, `${path}[]`);
  if (Array.isArray(n.anyOf)) n.anyOf.forEach((v: unknown, i: number) => walk(v, visit, `${path}|${i}`));
}

describe("buildGroomingPlanResponseSchema", () => {
  const schema = buildGroomingPlanResponseSchema(buildEvidenceCatalog(snapshot)) as Node;

  it("requires every section and forbids extra properties on every object", () => {
    expect(schema.required).toEqual(["verdict", "implementationBrief", "mutations", "decomposition", "relatedWork"]);
    walk(schema, (n, path) => {
      if (n.type === "object" && n.properties) {
        expect(n.additionalProperties, path).toBe(false);
        expect(n.required, path).toEqual(Object.keys(n.properties));
      }
    });
  });

  it("bounds every string and array", () => {
    walk(schema, (n, path) => {
      if (n.type === "string" && !n.enum) expect(typeof n.maxLength, path).toBe("number");
      if (n.type === "array") expect(typeof n.maxItems, path).toBe("number");
    });
  });

  it("derives the lane enum from configured lanes", () => {
    expect(schema.properties.verdict.properties.lane.properties.id.enum).toEqual(getLaneIds());
    setLaneConfig({ lanes: [{ id: "only", title: "Only", claimable: true, role: "default" }] });
    const custom = buildGroomingPlanResponseSchema() as Node;
    expect(custom.properties.verdict.properties.lane.properties.id.enum).toEqual(["only"]);
  });

  it("constrains labels to the priority/type allowlist, never status", () => {
    const labels = schema.properties.mutations.properties.labelsToAdd.items.enum as string[];
    expect(labels).toEqual([...PLAN_LABELS]);
    expect(labels.some((l) => l.startsWith("status/"))).toBe(false);
  });

  it("constrains evidence ids to this run's catalog, by kind", () => {
    const verdictRefs = schema.properties.verdict.properties.evidenceRefs.items.enum;
    expect(verdictRefs).toEqual(["issue", "comment:5", "repo:src/a.ts", "github:pr:org/repo#2"]);
    const brief = schema.properties.implementationBrief.anyOf[1];
    expect(brief.properties.relevantPaths.items.properties.ref.enum).toEqual(["repo:src/a.ts"]);
    expect(schema.properties.relatedWork.items.properties.ref.enum).toEqual(["github:pr:org/repo#2"]);
  });

  it("forces arrays empty when the catalog has no ids of the needed kind", () => {
    const bare = buildGroomingPlanResponseSchema(buildEvidenceCatalog({ ...snapshot, sources: [] })) as Node;
    expect(bare.properties.relatedWork.maxItems).toBe(0);
    expect(bare.properties.implementationBrief.anyOf[1].properties.relevantPaths.maxItems).toBe(0);
  });

  it("falls back to bounded strings without a catalog", () => {
    const plain = buildGroomingPlanResponseSchema() as Node;
    expect(plain.properties.verdict.properties.evidenceRefs.items).toMatchObject({ type: "string", maxLength: 300 });
  });

  it("contains no provider or model names", () => {
    const text = JSON.stringify(schema).toLowerCase();
    for (const name of ["openai", "anthropic", "claude", "gpt", "gemini", "llama", "qwen", "gemma", "mistral", "deepseek"]) {
      expect(text).not.toContain(name);
    }
  });
});
