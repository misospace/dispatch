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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, relative, sep } from "path";

const SRC_DIR = realpathSync(join(__dirname, ".."));
const REPO_ROOT = realpathSync(join(__dirname, "..", ".."));

// Test fixtures deliberately assign a non-secret literal to
// `process.env.GITHUB_TOKEN`, so they are never in scope for a credential
// scan — and a UI fixture object is not a status writer either.
const isTestName = (name: string): boolean => /\.(test|spec)\.tsx?$/.test(name);
const isSourceName = (name: string): boolean => /\.tsx?$/.test(name) && !isTestName(name);

/**
 * Every production `.ts` file under `dir`, tests excluded.
 *
 * Symlinks are resolved with `realpathSync` and content is attributed to the
 * resolved path (#1601 review): a lexical path under a scanned surface (e.g.
 * `src/lib/pr-fix-queue/`) must never be able to launder an outside file's
 * content into — or out of — that surface's scan results, so the surface
 * membership tests below always see where the content really lives. Targets
 * that resolve outside the repository are still scanned and attributed: a
 * symlink planted in `src/` that points elsewhere is itself suspect, and
 * fail-closed beats silently skipping whatever it smuggles in. Broken
 * symlinks compile to nothing and are skipped. Results are deduplicated and
 * sorted, so an aliased file is scanned once under its one real path.
 *
 * Inclusion follows the lexical entry name, because that is the path the
 * compiler sees through the link (`evil.ts` compiles whatever it points at);
 * the test-fixture exclusion also checks the real name, so a link cannot
 * rename test content into (or out of) the production set. Unreadable
 * entries are skipped rather than fatal: if this process cannot read a path,
 * the compiler cannot compile it either, so it contributes no scan surface.
 */
function productionSources(dir: string = SRC_DIR): string[] {
  const found = new Set<string>();
  const visited = new Set<string>();
  const visit = (dir: string): void => {
    if (visited.has(dir)) return;
    visited.add(dir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // unreadable directory
    }
    for (const name of names) {
      const full = join(dir, name);
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue; // broken symlink
      }
      if (visited.has(real)) continue;
      let stats;
      try {
        stats = statSync(real);
      } catch {
        continue; // unreadable entry
      }
      if (stats.isDirectory()) visit(real);
      else if (stats.isFile() && isSourceName(name) && !isTestName(basename(real))) found.add(real);
    }
  };
  visit(realpathSync(dir));
  return [...found].sort();
}

/**
 * Surface membership on real paths only: a file belongs to a scanned surface
 * when its resolved path is that surface or lies under it (#1601 review).
 * Lexical comparison here is what let a symlink under the surface attribute
 * outside content to the surface; every membership test must go through this.
 */
const isWithinSurface = (file: string, surfaces: string[]): boolean =>
  surfaces.some((surface) => file === surface || file.startsWith(`${surface}${sep}`));

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

// A status ASSIGNMENT to WAITING_EXTERNAL, in any form a writer can use: an
// object-literal property (`status: "WAITING_EXTERNAL"`,
// `status: PrFixStatus.WAITING_EXTERNAL`) or a direct assignment
// (`item.status = "WAITING_EXTERNAL"`). Strict/loose EQUALITY is explicitly
// not an assignment — `where: { status: "WAITING_EXTERNAL" }` reads the
// status, and so does every comparison, which is why `=(?!=)` and a literal
// `:` (never `==`) are the only separators accepted.
const statusAssignment = /\bstatus\s*(?::|=(?!=))\s*[^,;)\n]*\bWAITING_EXTERNAL\b/;

describe("external-wait contract enforcement (#1250)", () => {
  // `markPrFixItem` is the single place an item's status becomes
  // WAITING_EXTERNAL, so the external-wait contract is validated exactly once.
  // A second writer could park a malformed `externalWait` as a valid wait
  // without ever meeting `parseExternalWaitInput`.
  // Since #1592 the queue is a directory module (`src/lib/pr-fix-queue/`,
  // re-export barrel `pr-fix-queue.ts`); the single-writer surface is that
  // whole module — the writer itself lives in `pr-fix-queue/settlement.ts`,
  // and the other submodules only read the status or write history rows.
  // Surface membership is tested against real paths only: `productionSources`
  // resolves symlinks before attribution, so a symlink planted under the
  // writer directory cannot make outside content count as writer content (or
  // vice versa) (#1601 review).
  const WRITER_DIR = realpathSync(join(SRC_DIR, "lib", "pr-fix-queue"));
  const WRITER_BARREL = realpathSync(join(SRC_DIR, "lib", "pr-fix-queue.ts"));
  const isWriterFile = (file: string): boolean => isWithinSurface(file, [WRITER_BARREL, WRITER_DIR]);
  const assignments: CallSite[] = productionSources().flatMap((file) =>
    readFileSync(file, "utf-8")
      .split("\n")
      .flatMap((raw, index): CallSite[] =>
        statusAssignment.test(raw) ? [{ file, line: index + 1, text: raw.trim() }] : [],
      ),
  );

  it("WAITING_EXTERNAL has a single status writer (#1276 review)", () => {
    const outside = assignments.filter((hit) => !isWriterFile(hit.file));
    expect(
      outside.map((hit) => `${relative(REPO_ROOT, hit.file)}:${hit.line} → ${hit.text}`).join("\n"),
      "Only the src/lib/pr-fix-queue module may assign `status: \"WAITING_EXTERNAL\"` — every other writer could park an unvalidated external-wait contract. Route WAITING_EXTERNAL marks through markPrFixItem instead.",
    ).toBe("");
  });

  // Guard against a vacuous pass, and against the anchor comment going stale:
  // the writer must still be the module that turns a request into this status,
  // which means it gates the status AND validates the contract on that gate.
  it("the single-writer scan is not vacuous (the writer still gates this status)", () => {
    const content = readFileSync(join(WRITER_DIR, "settlement.ts"), "utf-8");
    const gated = /nextStatus\s*===\s*["']WAITING_EXTERNAL["']/.test(content);
    const validated = content.includes("parseExternalWaitInput(");
    expect(
      gated && validated,
      `src/lib/pr-fix-queue/settlement.ts no longer gates WAITING_EXTERNAL via nextStatus and validates it with parseExternalWaitInput (gated=${gated}, validated=${validated}); update this guard and the anchor comment on the markPrFixItem writer.\nAssignments found:\n${located(assignments)}`,
    ).toBe(true);
  });
});

describe("scan attribution resolves symlinks and stays on real paths (#1601 review)", () => {
  it("attributes symlinked content to its real path, so a link cannot launder outside content into a scanned surface", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pr-fix-scan-"));
    try {
      const outside = join(tmp, "outside");
      const surface = join(tmp, "surface");
      mkdirSync(outside);
      mkdirSync(surface);
      const realSurface = realpathSync(surface);
      const realOutside = realpathSync(outside);
      writeFileSync(join(outside, "real.ts"), 'export const smuggled = { status: "WAITING_EXTERNAL" };\n');
      writeFileSync(join(surface, "clean.ts"), "export const clean = 1;\n");
      // A link inside the surface pointing at outside content — the evasion
      // shape the review flagged: lexical attribution would read the target
      // through `surface/link.ts` and credit it to the surface.
      symlinkSync(join(outside, "real.ts"), join(surface, "link.ts"));
      // A symlinked directory recursion, a broken link, and a self-referential
      // loop must not throw, double-scan, or fabricate members.
      symlinkSync(outside, join(surface, "out-dir"));
      symlinkSync(join(tmp, "missing.ts"), join(surface, "broken.ts"));
      symlinkSync(surface, join(surface, "loop"));

      const files = productionSources(surface);
      // The smuggled content is attributed to where it really lives — outside
      // the surface — so a surface-membership test on the reported path
      // (isWriterFile) correctly refuses it.
      expect(files).toEqual([join(realOutside, "real.ts"), join(realSurface, "clean.ts")]);
      const hits = files.flatMap((file) =>
        readFileSync(file, "utf-8")
          .split("\n")
          .map((raw, index) => ({ file, line: index + 1, text: raw.trim() }))
          .filter(({ text }) => statusAssignment.test(text)),
      );
      expect(hits.map((hit) => `${hit.file}:${hit.line}`)).toEqual([`${join(realOutside, "real.ts")}:1`]);
      // The same production predicate the writer guard uses must refuse the
      // smuggled path: attribution and membership together defeat the evasion.
      expect(isWithinSurface(join(realOutside, "real.ts"), [realSurface])).toBe(false);
      expect(isWithinSurface(join(realSurface, "clean.ts"), [realSurface])).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("no credential is logged, echoed, or persisted by the evidence ledger (#1249/#1276 review)", () => {
  // The modules #1249/#1276 introduces or materially changes. The brief named
  // `src/lib/github-prs-review-threads.ts`; that module never existed — the
  // review-thread read (`fetchPullRequestReviewThreadStates`) lives in
  // `src/lib/github-prs.ts`, so that is what is scanned here (#1276 review).
  // Since #1592 the queue is a directory module; scan every submodule
  // (recursively, so future nested modules stay covered) plus the re-export
  // barrel so the moved code keeps credential coverage. Every entry is
  // resolved to its real path, matching how `productionSources` attributes
  // content, so a symlink among these names cannot be read or reported under
  // a lexical identity (#1601 review).
  const prFixQueueDir = join(SRC_DIR, "lib", "pr-fix-queue");
  const prFixQueueModules = productionSources(prFixQueueDir);
  const MODULES = [
    join(SRC_DIR, "lib", "pr-fix-evidence.ts"),
    join(SRC_DIR, "lib", "pr-fix-queue.ts"),
    ...prFixQueueModules,
    join(SRC_DIR, "lib", "pr-followup-ingestion.ts"),
    join(SRC_DIR, "lib", "github-prs.ts"),
  ].map((file) => {
    try {
      return realpathSync(file);
    } catch {
      return file; // missing: the existence guard below reports it
    }
  });

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