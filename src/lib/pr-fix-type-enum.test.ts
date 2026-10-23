/**
 * PrFixType parity guard (#1327).
 *
 * The queue's `type` column is a Postgres enum, so a value the enum lacks
 * cannot be persisted at all. The mocked suite cannot see that — it assigns
 * strings into objects — so an app-side type union that outruns the database
 * enum passes every unit test and fails on the first real write.
 *
 * Three places must carry the value together:
 *   - `PrFixType` / `VALID_PR_FIX_TYPES` in src/types/index.ts (the app union),
 *   - `enum PrFixType` in prisma/schema.prisma (the generated client), and
 *   - the migration SQL that adds it to the live database.
 *
 * The real-database half of this guard (a REBASE row actually persisting)
 * lives in src/lib/pr-fix-rebase-type.integration.test.ts, which runs against
 * PostgreSQL in the database-integration CI job.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { PR_FIX_TYPE_PRIORITY, VALID_PR_FIX_TYPES } from "@/types";

const REPO_ROOT = join(__dirname, "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "prisma", "migrations");

/** The `PrFixType` values declared in prisma/schema.prisma. */
function schemaEnumValues(): string[] {
  const schema = readFileSync(join(REPO_ROOT, "prisma", "schema.prisma"), "utf-8");
  const block = /enum\s+PrFixType\s*\{([\s\S]*?)\n\}/.exec(schema);
  expect(block, "enum PrFixType not found in prisma/schema.prisma").not.toBeNull();
  return (block?.[1] ?? "")
    .split("\n")
    .map((line) => /^\s*([A-Z][A-Z0-9_]*)\s*$/.exec(line)?.[1])
    .filter((value): value is string => Boolean(value));
}

/** Every value the migration SQL creates or adds to the PrFixType enum. */
function migratedEnumValues(): string[] {
  const values = new Set<string>();
  for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, entry.name, "migration.sql"), "utf-8");
    const created = /CREATE TYPE\s+"PrFixType"\s+AS ENUM\s*\(([^)]*)\)/.exec(sql);
    for (const value of created?.[1]?.split(",") ?? []) {
      const name = /'([A-Z][A-Z0-9_]*)'/.exec(value)?.[1];
      if (name) values.add(name);
    }
    for (const match of sql.matchAll(/ALTER\s+TYPE\s+"PrFixType"\s+ADD\s+VALUE(?:\s+IF\s+NOT\s+EXISTS)?\s+'([A-Z][A-Z0-9_]*)'/gi)) {
      values.add(match[1]);
    }
  }
  return [...values];
}

describe("PrFixType parity across app, schema, and migrations (#1327)", () => {
  it("the Prisma schema enum and the app-side type union carry the same values", () => {
    const schemaValues = schemaEnumValues();
    expect(schemaValues.length, "PrFixType enum parse failed — keep this guard in step with the schema").toBeGreaterThan(0);
    expect(
      [...VALID_PR_FIX_TYPES].sort().join(","),
      "src/types/index.ts VALID_PR_FIX_TYPES and prisma/schema.prisma enum PrFixType disagree — a value the database enum lacks cannot be persisted",
    ).toBe([...schemaValues].sort().join(","));
  });

  it("every schema enum value is created or added by a migration", () => {
    const migrated = new Set(migratedEnumValues());
    expect(
      schemaEnumValues()
        .filter((value) => !migrated.has(value))
        .join("\n"),
      "these PrFixType values are declared in prisma/schema.prisma but no migration adds them to the database enum",
    ).toBe("");
  });

  it("every valid type has a priority", () => {
    const missing = VALID_PR_FIX_TYPES.filter((type) => PR_FIX_TYPE_PRIORITY[type] === undefined);
    expect(missing.join("\n"), "PR_FIX_TYPE_PRIORITY must rank every valid PR-fix type").toBe("");
  });
});
