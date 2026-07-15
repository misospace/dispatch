// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Vitest runs tests from the project root, so `process.cwd()` is the
// repository root regardless of where the test file lives.
const dockerfilePath = join(process.cwd(), "Dockerfile");

function readDockerfile() {
  return readFileSync(dockerfilePath, "utf8");
}

/**
 * Split the Dockerfile into per-stage sections keyed by the stage name
 * declared after each `FROM ... AS <name>` directive.
 */
function splitIntoStages(dockerfile: string): Map<string, string> {
  const stages = new Map<string, string>();
  const lines = dockerfile.split("\n");
  let currentName: string | null = null;
  let buffer: string[] = [];
  const fromRe = /^\s*FROM\s+\S+\s+(?:AS\s+)?(\S+)/i;
  const flush = () => {
    if (currentName !== null) {
      stages.set(currentName, buffer.join("\n"));
    }
  };
  for (const line of lines) {
    const match = line.match(fromRe);
    if (match) {
      flush();
      currentName = match[1];
      buffer = [];
    } else if (currentName !== null) {
      buffer.push(line);
    }
  }
  flush();
  return stages;
}

/**
 * Regression tests for issue #533: the builder stage used to hardcode
 * `ENV DATABASE_URL=postgresql://localhost:5432/dispatch`, which silently
 * overrode any `--build-arg DATABASE_URL=...` and could mislead Prisma's
 * client generation. The builder must instead inherit from the ARG.
 */
describe("Dockerfile builder stage DATABASE_URL", () => {
  it("declares DATABASE_URL as a build ARG with a placeholder default", () => {
    const dockerfile = readDockerfile();
    const argMatch = dockerfile.match(/^ARG\s+DATABASE_URL\s*=\s*(\S+)/m);
    expect(argMatch, "expected an ARG DATABASE_URL declaration in the Dockerfile").not.toBeNull();
    expect(argMatch![1]).toBe("postgresql://localhost:5432/dispatch");
  });

  it("makes the ENV DATABASE_URL inherit from the ARG instead of hardcoding a value", () => {
    const dockerfile = readDockerfile();
    // Find the ENV DATABASE_URL line and make sure it is referencing the ARG,
    // not a literal placeholder that would clobber --build-arg overrides.
    const envLineMatch = dockerfile.match(/^ENV\s+DATABASE_URL\s*=\s*(.+)$/m);
    expect(envLineMatch, "expected an ENV DATABASE_URL declaration in the Dockerfile").not.toBeNull();
    const envValue = envLineMatch![1].trim();
    expect(envValue).toBe("${DATABASE_URL}");
    expect(envValue).not.toBe("postgresql://localhost:5432/dispatch");
  });

  it("keeps ENV DATABASE_URL strictly inside the builder stage", () => {
    const dockerfile = readDockerfile();
    const stages = splitIntoStages(dockerfile);
    const builder = stages.get("builder");
    expect(builder, "expected a `builder` stage in the Dockerfile").toBeDefined();
    expect(builder!).toContain("ENV DATABASE_URL");

    for (const [name, body] of stages) {
      if (name === "builder") continue;
      expect(
        body,
        `non-builder stage "${name}" must not set ENV DATABASE_URL (issue #533)`,
      ).not.toMatch(/^ENV\s+DATABASE_URL\b/m);
    }
  });
});
