/**
 * Requirement-anchoring guards for the durable PR-fix evidence ledger
 * (#1249/#1276 review).
 *
 * Two PR requirements were marked "no valid enforcement location" because the
 * enforcement exists but no discoverable test names it. Both are enforced
 * here as source scans rather than behaviour, because each is an invariant
 * about the SHAPE of the code (one writer; no credential handling in this
 * feature) that no behavioural test can observe — a second status writer or a
 * stray `console.warn(token)` is invisible to every existing assertion.
 *
 * The behavioural half of each requirement is pinned elsewhere and referenced
 * from the comments below:
 *   - external wait: `src/lib/pr-fix-external-wait.test.ts` → "structured
 *     external-wait contract (#1250)" (malformed contract through the
 *     report → markPrFixItem path parks fail-closed) and
 *     `src/lib/pr-fix-queue-evidence.test.ts` → "terminal dispositions retire
 *     attempt snapshot (#1276 review)".
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

const SRC_DIR = join(__dirname, "..");
const REPO_ROOT = join(__dirname, "..", "..");

/** Every production `.ts` file under `src/`, tests excluded. */
function productionSources(dir: string = SRC_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...productionSources(full));
      continue;
    }
    // Test fixtures deliberately assign a non-secret literal to
    // `process.env.GITHUB_TOKEN`, so they are never in scope for a credential
    // scan — and a UI fixture object is not a status writer either.
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/** Parenthesis balance, used to capture a whole `console.*(...)` call. */
const parenDelta = (text: string): number =>
  (text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length;

interface CallSite {
  file: string;
  line: number;
  text: string;
}

/** Every `console.*(` call site with its full (possibly multi-line) argument text. */
function consoleCallSites(content: string, file: string): CallSite[] {
  const sites: CallSite[] = [];
  let open: CallSite | null = null;
  content.split("\n").forEach((raw, index) => {
    const start = /console\.(log|info|warn|error|debug|table|trace|dir)\s*\(/.exec(raw);
    if (start) {
      const site: CallSite = { file, line: index + 1, text: raw.slice(start.index) };
      if (parenDelta(site.text) > 0) open = site;
      else sites.push(site);
      return;
    }
    if (!open) return;
    open.text += ` ${raw.trim()}`;
    if (parenDelta(open.text) <= 0) {
      sites.push(open);
      open = null;
    }
  });
  return sites;
}

const located = (sites: CallSite[]): string =>
  sites.map((site) => `${relative(REPO_ROOT, site.file)}:${site.line} → ${site.text.replace(/\s+/g, " ").slice(0, 120)}`).join("\n");

describe("external-wait contract enforcement (#1250)", () => {
  // `markPrFixItem` is the single place an item's status becomes
  // WAITING_EXTERNAL, so the external-wait contract is validated exactly once.
  // A second writer could park a malformed `externalWait` as a valid wait
  // without ever meeting `parseExternalWaitInput`.
const writer = join(SRC_DIR, "lib", "pr-fix-queue.ts");
  // A status ASSIGNMENT to this value, in any form a writer can use: an
  // object-literal property (`status: "WAITING_EXTERNAL"`,
  // `status: PrFixStatus.WAITING_EXTERNAL`) or a direct assignment
  // (`item.status = "WAITING_EXTERNAL"`). Strict/loose EQUALITY is explicitly
  // not an assignment — `where: { status: "WAITING_EXTERNAL" }` reads the
  // status, and so does every comparison, which is why `=(?!=)` and a literal
  // `:` (never `==`) are the only separators accepted.
  const statusAssignment = /\bstatus\s*(?::|=(?!=))\s*[^,;)\n]*\bWAITING_EXTERNAL\b/;
  const assignments: CallSite[] = productionSources().flatMap((file) =>
    readFileSync(file, "utf-8")
      .split("\n")
      .flatMap((raw, index): CallSite[] =>
        statusAssignment.test(raw) ? [{ file, line: index + 1, text: raw.trim() }] : [],
      ),
  );

  it("WAITING_EXTERNAL has a single status writer (#1276 review)", () => {
    const outside = assignments.filter((hit) => hit.file !== writer);
    expect(
      outside.map((hit) => `${relative(REPO_ROOT, hit.file)}:${hit.line} → ${hit.text}`).join("\n"),
      "Only src/lib/pr-fix-queue.ts may assign `status: \"WAITING_EXTERNAL\"` — every other writer could park an unvalidated external-wait contract. Route WAITING_EXTERNAL marks through markPrFixItem instead.",
    ).toBe("");
  });

  // Guard against a vacuous pass, and against the anchor comment going stale:
  // the writer must still be the module that turns a request into this status,
  // which means it gates the status AND validates the contract on that gate.
  it("the single-writer scan is not vacuous (the writer still gates this status)", () => {
    const content = readFileSync(writer, "utf-8");
    const gated = /nextStatus\s*===\s*["']WAITING_EXTERNAL["']/.test(content);
    const validated = content.includes("parseExternalWaitInput(");
    expect(
      gated && validated,
      `src/lib/pr-fix-queue.ts no longer gates WAITING_EXTERNAL via nextStatus and validates it with parseExternalWaitInput (gated=${gated}, validated=${validated}); update this guard and the anchor comment on the markPrFixItem writer.\nAssignments found:\n${located(assignments)}`,
    ).toBe(true);
  });
});

describe("no credential is logged, echoed, or persisted by the evidence ledger (#1249/#1276 review)", () => {
  // The modules #1249/#1276 introduces or materially changes. The brief named
  // `src/lib/github-prs-review-threads.ts`; that module never existed — the
  // review-thread read (`fetchPullRequestReviewThreadStates`) lives in
  // `src/lib/github-prs.ts`, so that is what is scanned here (#1276 review).
  const MODULES = [
    join(SRC_DIR, "lib", "pr-fix-evidence.ts"),
    join(SRC_DIR, "lib", "pr-fix-queue.ts"),
    join(SRC_DIR, "lib", "pr-followup-ingestion.ts"),
    join(SRC_DIR, "lib", "github-prs.ts"),
  ];

  it("scans only modules that exist (the guard is not silently vacuous)", () => {
    for (const sourceFile of MODULES) {
      expect(existsSync(sourceFile), `credential scan target missing: ${relative(REPO_ROOT, sourceFile)}`).toBe(true);
    }
  });

  it("reads no token from the environment and builds no auth header", () => {
    // A credential read here would be one careless log away from a leak; the
    // forge read in github-prs.ts goes through the sanctioned
    // `getHeadersAsync` accessor, which keeps the token in github-auth.ts.
    const banned = [
      { pattern: /process\.env\.[A-Za-z_]*(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z_]*/, label: "credential env read" },
      { pattern: /["'`]Authorization["'`]/i, label: "Authorization header literal" },
      { pattern: /x-access-token/i, label: "GitHub token header" },
      { pattern: /["'`]bearer\s/i, label: "bearer credential literal" },
    ];
    const hits: string[] = [];
    for (const sourceFile of MODULES) {
      const content = readFileSync(sourceFile, "utf-8");
      content.split("\n").forEach((raw, index) => {
        for (const { pattern, label } of banned) {
          if (pattern.test(raw)) hits.push(`${relative(REPO_ROOT, sourceFile)}:${index + 1} (${label}) → ${raw.trim()}`);
        }
      });
    }
    expect(hits.join("\n"), "the evidence ledger must not read or construct credentials; use the github-auth accessor").toBe("");
  });

  it("logs no token or auth header through console.*", () => {
    // Credential-shaped words only. A bare `headers` is deliberately NOT banned:
  // logging which headers were sent (or that a request failed on headers) is
  // legitimate diagnostics, and banning the word would push the next change
  // toward logging less rather than logging less-sensitive things. This guard
  // is about the VALUE, so it matches the credential nouns themselves.
  const banned = /(token|authorization|auth[\s_-]?header|credential|secret|cookie|password)/i;
    const hits = MODULES.flatMap((sourceFile) =>
      consoleCallSites(readFileSync(sourceFile, "utf-8"), sourceFile)
        .filter((site) => banned.test(site.text))
        .map((site) => `${relative(REPO_ROOT, site.file)}:${site.line} → ${site.text.replace(/\s+/g, " ").slice(0, 160)}`),
    );
    expect(hits.join("\n"), "console output must never carry a credential or an auth header").toBe("");
  });

  it("persists no credential-bearing column on PrFixEvidence", () => {
    const schema = readFileSync(join(REPO_ROOT, "prisma", "schema.prisma"), "utf-8");
    const model = /model PrFixEvidence \{([\s\S]*?)\n\}/.exec(schema);
    expect(model, "PrFixEvidence model not found in prisma/schema.prisma").not.toBeNull();
    const fields = (model?.[1] ?? "")
      .split("\n")
      .map((line) => /^\s{2}([A-Za-z][A-Za-z0-9_]*)\s+\S/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name));
    expect(fields.length, "PrFixEvidence field parse failed — keep this guard in step with the schema").toBeGreaterThan(5);
    const credentialFields = fields.filter((name) => /(token|secret|credential|password|cookie|auth)/i.test(name));
    expect(
      credentialFields.map((name) => `${relative(REPO_ROOT, join("prisma", "schema.prisma"))}: PrFixEvidence.${name}`).join("\n"),
      "PrFixEvidence must stay a forge-observation ledger: no credential column may be added to it",
    ).toBe("");
  });
});