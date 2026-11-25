export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, val) =>
      typeof val === "bigint" ? val.toString() : val
    )
  );
}

/**
 * Deterministic key-sorted JSON for scalars/nested objects/arrays: object keys
 * are sorted and `undefined` entries are omitted. Two payloads that differ
 * only in key order or in explicitly-undefined optional fields serialize
 * identically, which is what the idempotency fingerprints of the requeue and
 * task-report surfaces hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Strip a Markdown code fence wrapping a model's JSON reply, so the body can
 * be handed straight to `JSON.parse`.
 */
export function trimJsonFences(text: string): string {
  let result = text.trim();
  if (result.startsWith("```")) {
    const firstNewline = result.indexOf("\n");
    if (firstNewline > 0) {
      result = result.slice(firstNewline + 1);
    } else {
      result = result.slice(3);
    }
  }
  if (result.endsWith("```")) {
    result = result.slice(0, -3).trim();
  }
  return result;
}
