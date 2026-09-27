// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

// Set by Next.js or the Dockerfile rather than by operators.
const PLATFORM_VARS = new Set(["NODE_ENV", "NEXT_RUNTIME", "NEXT_PUBLIC_DISPATCH_VERSION", "PORT"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function envVarsReadByCode(): Set<string> {
  const names = new Set<string>();
  // process.env.NAME, process.env["NAME"], and env.NAME on an injected env object.
  const pattern = /(?:\bprocess\.env\.|\bprocess\.env\[["']|(?<![\w.])env\??\.)([A-Z][A-Z0-9_]+)/g;
  for (const file of sourceFiles(join(root, "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

function envVarsDocumented(): Set<string> {
  const text = readFileSync(join(root, ".env.example"), "utf8");
  return new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
}

describe(".env.example", () => {
  it("documents every env var the code reads", () => {
    const documented = envVarsDocumented();
    const missing = [...envVarsReadByCode()]
      .filter((name) => !documented.has(name) && !PLATFORM_VARS.has(name))
      .sort();
    expect(missing).toEqual([]);
  });
});
