import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DOC_REL = "docs/observability.md";

// `fileURLToPath(new URL(..., import.meta.url))` is unusable here: the jsdom
// environment's `URL` yields an object node:url rejects. `import.meta.dirname`
// is a plain string in the vitest transform, and vitest always runs from the
// repo root, so walk up as a safety net rather than trusting either blindly.
function repoRoot(): string {
  let dir = path.resolve(import.meta.dirname, "..");
  while (!existsSync(path.join(dir, DOC_REL)) && dir !== path.dirname(dir)) {
    dir = path.dirname(dir);
  }
  return dir;
}

const REPO_ROOT = repoRoot();
const doc = readFileSync(path.join(REPO_ROOT, DOC_REL), "utf8");
const docLines = doc.split("\n");

const readRepo = (relative: string): string => readFileSync(path.join(REPO_ROOT, relative), "utf8");

/** Cells of every `|`-row between `heading` and the next heading. */
function rowsAfterHeading(heading: string): string[][] {
  const start = docLines.findIndex((l) => l.startsWith(heading));
  expect(start, `${DOC_REL} is missing the "${heading}" heading`).toBeGreaterThan(-1);
  const rows: string[][] = [];
  for (let i = start + 1; i < docLines.length; i += 1) {
    const line = docLines[i];
    if (line.startsWith("#")) break;
    if (!line.startsWith("|")) continue;
    rows.push(
      line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  }
  return rows;
}

function alertTable(): string[][] {
  return rowsAfterHeading("## 6. Alert catalogue");
}

const CATALOGUE = alertTable();
const HEADER = CATALOGUE[0];
const ALERTS = CATALOGUE.filter((cells) => /^A\d+$/.test(cells[0]));
const col = (name: string): number => HEADER.indexOf(name);

const CONDITION = col("Condition (predicate)");
const ENABLED = col("Enabled");
const SEVERITY = col("Severity");
const FOR = col("`for`");
const WHY = col("Why actionable");
const RECOVERY = col("Recovery / operator action");

/** Required, non-empty cells paired with a readable label for failure output. */
const REQUIRED_CELLS: [number, string][] = [
  [col("Alert"), "Alert"],
  [CONDITION, "Condition"],
  [ENABLED, "Enabled"],
  [SEVERITY, "Severity"],
  [FOR, "for"],
  [WHY, "Why actionable"],
  [RECOVERY, "Recovery"],
];

/** Signal names defined by the §4 catalogue: first cell is `` `dispatch_x` ``. */
const DEFINED_SIGNALS = new Set(
  docLines
    .filter((l) => l.startsWith("|"))
    .map((l) => {
      const first = l.split("|")[1]?.trim() ?? "";
      return /^`(dispatch_[a-z0-9_]+)`$/.exec(first)?.[1];
    })
    .filter((n): n is string => Boolean(n)),
);

describe("observability design doc: §6 alert catalogue structure", () => {
  it("defines A1–A14 exactly once, each row complete", () => {
    const ids = ALERTS.map((cells) => cells[0]);
    const expected = Array.from({ length: 14 }, (_, i) => `A${i + 1}`);
    expect(ids, `§6 alert IDs drifted; expected exactly ${expected.join(", ")}`).toEqual(expected);
    const missing = REQUIRED_CELLS.filter(([idx]) => idx === -1).map(([, label]) => label);
    expect(missing, `§6 table is missing the column(s): ${missing.join(", ")}`).toEqual([]);

    const problems: string[] = [];
    for (const cells of ALERTS) {
      const id = cells[0];
      if (cells.length !== HEADER.length) {
        problems.push(`${id}: ${cells.length} cells, header has ${HEADER.length}`);
      }
      for (const [idx, label] of REQUIRED_CELLS) {
        if (!cells[idx]) problems.push(`${id}: empty "${label}" cell`);
      }
    }
    expect(problems, `Fix the malformed rows in §6 of ${DOC_REL}:\n  ${problems.join("\n  ")}`).toEqual([]);
  });

  it("marks exactly A6 disabled, and disabled rows carry no duration and severity info", () => {
    const problems: string[] = [];
    const disabled: string[] = [];
    for (const cells of ALERTS) {
      const id = cells[0];
      const enabled = cells[ENABLED];
      if (/^no\b/.test(enabled)) disabled.push(id);
      else if (enabled !== "yes") problems.push(`${id}: Enabled cell is "${enabled}", expected "yes" or "no …"`);

      if (!/^no\b/.test(enabled)) continue;
      if (/\d+\s*(m|s|h|min)/.test(cells[FOR])) {
        problems.push(`${id}: disabled but its \`for\` cell is a duration ("${cells[FOR]}")`);
      }
      if (!cells[SEVERITY].includes("info")) {
        problems.push(`${id}: disabled but severity is "${cells[SEVERITY]}", expected info`);
      }
      if (!cells[CONDITION].includes("must NOT fire")) {
        problems.push(`${id}: disabled but its condition does not say "must NOT fire"`);
      }
    }
    expect(disabled, `§6 must pin exactly A6 as disabled; got: ${disabled.join(", ") || "none"}`).toEqual([
      "A6",
    ]);
    expect(problems, `Fix §6 in ${DOC_REL}:\n  ${problems.join("\n  ")}`).toEqual([]);
  });
});

describe("observability design doc: §4.1/§4 signal invariants", () => {
  it("uses no rate-style function in any alert condition (§4.1)", () => {
    const offenders = ALERTS.filter((cells) => /\b(increase|rate|delta)\s*\(/.test(cells[CONDITION])).map(
      (cells) => cells[0],
    );
    expect(
      offenders,
      `${DOC_REL} §4.1 forbids increase()/rate()/delta(); offending alert conditions: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("only names signals defined in the §4 catalogue", () => {
    expect(
      DEFINED_SIGNALS.size,
      `${DOC_REL} §4 no longer defines any \`dispatch_*\` signals — this check would pass vacuously`,
    ).toBeGreaterThan(0);
    const unknown = new Map<string, string[]>();
    for (const cells of ALERTS) {
      for (const signal of cells[CONDITION].match(/dispatch_[a-z0-9_]+/g) ?? []) {
        if (DEFINED_SIGNALS.has(signal)) continue;
        unknown.set(signal, [...(unknown.get(signal) ?? []), cells[0]]);
      }
    }
    const detail = [...unknown].map(([s, ids]) => `${s} (used by ${ids.join(", ")})`).join("; ");
    expect(unknown.size, `${DOC_REL}: alert conditions reference undefined signals: ${detail}`).toBe(0);
  });
});

describe("observability design doc: source drift", () => {
  it("resolves every `file:line` citation", () => {
    // Paths with a `/` only: the bare-filename form is a drift bug of its own.
    const CITATION = /`([A-Za-z0-9_./[\]-]+\.(?:ts|tsx|prisma|yaml|yml|json|md)):(\d+)(?:-(\d+))?`/g;
    const matches = [...doc.matchAll(CITATION)];
    expect(matches.length, `${DOC_REL} has no backticked file:line citations to check`).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const match of matches) {
      const [citation, file, start, end] = match;
      const abs = path.join(REPO_ROOT, file);
      const lastLine = Number(end ?? start);
      if (!file.includes("/")) {
        problems.push(`${citation} is a bare filename — cite the full repo-relative path`);
        continue;
      }
      if (!existsSync(abs)) {
        problems.push(`${citation} — file does not exist`);
        continue;
      }
      const lineCount = readFileSync(abs, "utf8").split("\n").length;
      if (lineCount < lastLine) problems.push(`${citation} — file has only ${lineCount} lines`);
    }
    expect(problems, `Fix these citations in ${DOC_REL}:\n  ${problems.join("\n  ")}`).toEqual([]);
  });

  it("keeps the §4.9 `IssueSyncRun.status` values equal to the values source writes", () => {
    const OPEN = "whose only persisted values are";
    const CLOSE = "There is **no**";
    const from = doc.indexOf(OPEN);
    const to = doc.indexOf(CLOSE, from);
    expect(from, `${DOC_REL} §4.9 no longer has the IssueSyncRun.status sentence`).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const documented = new Set(
      [...doc.slice(from + OPEN.length, to).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]),
    );
    expect(
      documented.size,
      `${DOC_REL} §4.9 names no \`IssueSyncRun.status\` values — this check would pass vacuously`,
    ).toBeGreaterThan(0);

    // These three are the only IssueSyncRun status writers (grep-verified);
    // src/app/api/automation/sync/route.ts delegates to the shared lock path.
    const writers = ["src/lib/sync-lock.ts", "src/app/api/sync/route.ts", "src/app/api/sync/scheduled/route.ts"];
    const written = new Set(
      writers.flatMap((file) => [...readRepo(file).matchAll(/status:\s*["']([a-z]+)["']/g)].map((m) => m[1])),
    );

    const detail = `documented: ${[...documented].sort().join(", ") || "none"}; written: ${[...written].sort().join(", ") || "none"}`;
    expect([...documented].sort(), `${DOC_REL} §4.9 vs source — ${detail}`).toEqual([...written].sort());
  });
});