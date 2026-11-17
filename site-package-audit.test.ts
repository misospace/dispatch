// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ADMITTED_ADVISORIES,
  NPM_AUDIT_ARGS,
  evaluateAuditReport,
} from "./scripts/site-npm-audit.mjs";

// #1566: `site/` is a separate Astro project with its own package-lock.json
// and it ships to GitHub Pages. The app-level npm audit gate
// (.github/workflows/security-audit.yaml) reads the ROOT lockfile, and the
// Pages workflow installed the site with `npm ci --no-audit`, so no workflow
// audited the site's dependency tree at all: a vulnerable site dependency
// could be auto-merged and published unnoticed.
//
// These guards pin the site's audit gate: both workflows that run it must
// keep running the identical command, must keep pointing it at the site
// tree (not the app tree), must keep it blocking, and must keep running it
// on the events the issue asks for.

// The exact command both call sites run. Pinned verbatim so a change at one
// call site cannot silently diverge from the other. Since #1653 the command
// is the shared gate script: the npm audit scope (`--include=dev`), the
// severity threshold (`--audit-level=high`), and the single reviewed,
// time-boxed advisory exception all live inside it, pinned below on the
// script's own exports.
const SITE_AUDIT_COMMAND = "node ../scripts/site-npm-audit.mjs";

const SECURITY_AUDIT_WORKFLOW = join(
  process.cwd(),
  ".github",
  "workflows",
  "security-audit.yaml",
);
const PAGES_WORKFLOW = join(
  process.cwd(),
  ".github",
  "workflows",
  "pages.yaml",
);
const WORKFLOW_PATHS = [SECURITY_AUDIT_WORKFLOW, PAGES_WORKFLOW];

type Step = { body: string };
type Job = { name: string; body: string };

// The workflows are plain YAML and the repo carries no YAML parser
// dependency, so the steps and jobs are read as text. A step starts at a
// "- name:", "- uses:" or "- run:" list item and runs until the next one;
// anchoring on those keys keeps the unrelated "- " list items (the `paths:`
// filters) out of the step list.
function readSteps(path: string): Step[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const steps: Step[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^\s*-\s+(name|uses|run):/.test(line)) {
      if (current) steps.push({ body: current.join("\n") });
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) steps.push({ body: current.join("\n") });
  return steps;
}

// The `jobs:` section, one block per job (a job key sits at two-space
// indent; its own keys sit at four).
function readJobs(path: string): Job[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start === -1) throw new Error(`${path} has no jobs: section`);
  const jobs: Job[] = [];
  let name: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (name !== null) jobs.push({ name, body: body.join("\n") });
  };
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (match) {
      flush();
      name = match[1];
      body = [line];
    } else if (name !== null) {
      body.push(line);
    }
  }
  flush();
  return jobs;
}

// The workflow trigger section, everything before `jobs:`.
function readTriggers(path: string): string {
  const text = readFileSync(path, "utf8");
  const end = text.search(/^jobs:\s*$/m);
  return end === -1 ? text : text.slice(0, end);
}

// The step that audits the SITE tree: it runs the pinned gate command AND
// points the working directory at site/. The working-directory pin keeps
// the site gate distinguishable from any app-tree npm invocation, which is
// what makes "audits the site tree exactly once" meaningful.
function siteAuditSteps(path: string): Step[] {
  return readSteps(path).filter(
    (step) =>
      step.body.includes(SITE_AUDIT_COMMAND) &&
      /^\s*working-directory:\s*site\s*$/m.test(step.body),
  );
}

// The job that carries the site audit, identified by the gate command plus
// the site working directory.
function gateJob(path: string): Job {
  const gates = readJobs(path).filter(
    (job) =>
      job.body.includes(SITE_AUDIT_COMMAND) &&
      /^\s*working-directory:\s*site\s*$/m.test(job.body),
  );
  if (gates.length !== 1) {
    throw new Error(`${path} must run the site audit in exactly one job`);
  }
  return gates[0];
}

// The command a step runs, read back off the `run:` line so two call sites
// can be compared on the command alone.
function runCommand(step: Step): string {
  const match = step.body.match(/^\s*run:\s*(.+)$/m);
  if (!match) throw new Error(`step has no run command:\n${step.body}`);
  return match[1].trim();
}

describe("site/ npm audit gate (#1566)", () => {
  it("site/ carries its own manifest and lockfile for the gate to audit", () => {
    expect(existsSync(join(process.cwd(), "site", "package.json"))).toBe(true);
    expect(existsSync(join(process.cwd(), "site", "package-lock.json"))).toBe(
      true,
    );
  });

  for (const workflowPath of WORKFLOW_PATHS) {
    const workflowName = basename(workflowPath);

    describe(workflowName, () => {
      it("audits the site tree exactly once", () => {
        expect(siteAuditSteps(workflowPath)).toHaveLength(1);
      });

      it("audits site/ and not the app tree", () => {
        const [step] = siteAuditSteps(workflowPath);
        expect(step.body).toMatch(/^\s*working-directory:\s*site\s*$/m);
      });

      it("runs the pinned site audit gate command", () => {
        const [step] = siteAuditSteps(workflowPath);
        expect(step.body).toContain(SITE_AUDIT_COMMAND);
      });

      it("is a blocking gate, not an informational one", () => {
        const [step] = siteAuditSteps(workflowPath);
        expect(step.body).not.toMatch(/continue-on-error:\s*true/);
      });

      it("cannot be turned non-blocking from the job level", () => {
        // A job-level `continue-on-error: true` makes the whole job
        // advisory while every step still looks blocking.
        expect(gateJob(workflowPath).body).not.toMatch(
          /^ {4}continue-on-error:/m,
        );
        expect(readFileSync(workflowPath, "utf8")).not.toMatch(
          /^ {4}continue-on-error:\s*true/m,
        );
      });

      it("cannot be skipped by a condition on the job or the step", () => {
        expect(gateJob(workflowPath).body).not.toMatch(/^ {4}if:/m);
        const [step] = siteAuditSteps(workflowPath);
        expect(step.body).not.toMatch(/^\s*if:/m);
      });
    });
  }

  it("both workflows run the identical site audit command", () => {
    const commands = WORKFLOW_PATHS.map((path) =>
      runCommand(siteAuditSteps(path)[0]),
    );
    expect(commands[0]).toBe(commands[1]);
    expect(commands[0]).toBe(SITE_AUDIT_COMMAND);
  });

  it("the Security Audit workflow gates site/ on pull requests and pushes to main", () => {
    const triggers = readTriggers(SECURITY_AUDIT_WORKFLOW);
    expect(triggers).toMatch(/push:\s*\n\s+branches:\s*\[main\]/);
    expect(triggers).toMatch(/pull_request:\s*\n\s+branches:\s*\[main\]/);
    // A path filter would leave pull requests that do not touch site/ (or
    // that touch nothing at all) without the gate.
    expect(triggers).not.toMatch(/paths(-ignore)?:/);
    expect(readFileSync(SECURITY_AUDIT_WORKFLOW, "utf8")).toContain(
      "audit-site",
    );
  });

  it("the Pages workflow gates site/ on the site/** paths it ships", () => {
    const triggers = readTriggers(PAGES_WORKFLOW);
    expect(triggers).toContain('"site/**"');
    expect(triggers).toMatch(/pull_request:/);
    expect(triggers).toMatch(/push:/);
    expect(triggers).not.toMatch(/paths-ignore:/);
  });

  it("the Pages publish depends on the validation, so a red gate blocks it", () => {
    const build = readJobs(PAGES_WORKFLOW).find(
      (job) => job.name === "build",
    );
    expect(build, "pages.yaml must have a build job").toBeDefined();
    expect(build?.body).toMatch(/^ {4}needs:\s*validate\s*$/m);
  });
});

// #1653: the gate command is a script carrying the repo's only accepted npm
// advisory exception — GHSA-fc5q-39xc-vjpf (picomatch ReDoS, high, widened
// 2026-11-17 to `<= 4.0.7` with no patched release). These pins hold the
// three properties the issue demands: the gate stays blocking for everything
// else, the exception names exactly that one advisory, and the exception is
// time-boxed — with the accepted-risk record in SECURITY-ACCEPTED-RISKS.md
// pinned to the same id and expiry so the script and the record cannot
// drift apart.

const GATE_SCRIPT_PATH = join(process.cwd(), "scripts", "site-npm-audit.mjs");

function advisoryObject(id: string, severity: string, range = "<=4.0.7") {
  return {
    name: "picomatch",
    dependency: "picomatch",
    title: "test fixture",
    url: `https://github.com/advisories/${id}`,
    severity,
    range,
  };
}

function auditReport(vulnerabilities: Record<string, unknown>) {
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
}

function nextUtcDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

// The shape the live feed actually returns for the picomatch advisory: the
// vulnerable leaf carries the advisory object, every dependent lists only
// strings naming the packages below it.
function picomatchReport(extra?: Record<string, unknown>) {
  return auditReport({
    picomatch: {
      name: "picomatch",
      severity: "high",
      via: [advisoryObject("GHSA-fc5q-39xc-vjpf", "high")],
      range: "<=4.0.7",
    },
    "@astrojs/internal-helpers": {
      name: "@astrojs/internal-helpers",
      severity: "high",
      via: ["picomatch"],
    },
    astro: {
      name: "astro",
      severity: "high",
      via: ["@astrojs/internal-helpers", "picomatch"],
    },
    ...(extra ?? {}),
  });
}

describe("site audit gate advisory exception (#1653)", () => {
  const TODAY = "2026-11-17";

  it("the gate script exists and keeps the #1566 audit scope and threshold", () => {
    expect(existsSync(GATE_SCRIPT_PATH)).toBe(true);
    expect(NPM_AUDIT_ARGS).toContain("--include=dev");
    expect(NPM_AUDIT_ARGS).toContain("--audit-level=high");
    expect(NPM_AUDIT_ARGS).toContain("--json");
    // The fetch-retry flags that reduce transient registry failures (the
    // gate still fails closed on a sustained advisory-endpoint outage).
    expect(NPM_AUDIT_ARGS.join(" ")).toContain("--fetch-retries=5");
    expect(NPM_AUDIT_ARGS.join(" ")).toContain("--fetch-timeout=120000");
  });

  it("admits exactly one advisory, named by GHSA id, with a future time-box", () => {
    expect(ADMITTED_ADVISORIES).toHaveLength(1);
    const [exception] = ADMITTED_ADVISORIES;
    expect(exception.id).toBe("GHSA-fc5q-39xc-vjpf");
    expect(isRealCalendarDate(exception.expiresOn)).toBe(true);
    // Same inclusive semantics as the gate: the exception must still lie in
    // the future-or-today, and the day it expires the gate still admits —
    // the suite only goes red after the window itself has closed.
    expect(
      exception.expiresOn >= new Date().toISOString().slice(0, 10),
    ).toBe(true);
    expect(exception.reason.length).toBeGreaterThan(0);
  });

  it("SECURITY-ACCEPTED-RISKS.md records the same advisory id and expiry", () => {
    const doc = readFileSync(
      join(process.cwd(), "SECURITY-ACCEPTED-RISKS.md"),
      "utf8",
    );
    for (const exception of ADMITTED_ADVISORIES) {
      expect(doc).toContain(exception.id);
      expect(doc).toContain(exception.expiresOn);
    }
  });

  it("admits a picomatch-only report, including transitive dependents", () => {
    const verdict = evaluateAuditReport(picomatchReport(), ADMITTED_ADVISORIES, TODAY);
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.admitted).toHaveLength(1);
  });

  it("admits the exception on its expiry date and refuses it the day after", () => {
    const [exception] = ADMITTED_ADVISORIES;
    expect(
      evaluateAuditReport(picomatchReport(), ADMITTED_ADVISORIES, exception.expiresOn).ok,
    ).toBe(true);
    const nextDay = nextUtcDay(exception.expiresOn);
    expect(nextDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nextDay > exception.expiresOn).toBe(true);
    const verdict = evaluateAuditReport(picomatchReport(), ADMITTED_ADVISORIES, nextDay);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f: { kind: string }) => f.kind === "expired")).toBe(true);
  });

  it("still fails for a second advisory that is not on the exception list", () => {
    const report = picomatchReport({
      minimatch: {
        name: "minimatch",
        severity: "high",
        via: [advisoryObject("GHSA-0000-0000-0000", "high", "<=9.0.0")],
        range: "<=9.0.0",
      },
      vite: {
        name: "vite",
        severity: "high",
        via: ["picomatch", "minimatch"],
      },
    });
    const verdict = evaluateAuditReport(report, ADMITTED_ADVISORIES, TODAY);
    expect(verdict.ok).toBe(false);
    expect(
      verdict.failures.some(
        (f: { advisory?: { id?: string } }) =>
          f.advisory?.id === "GHSA-0000-0000-0000",
      ),
    ).toBe(true);
  });

  it("fails closed on an advisory object with a missing or unknown severity", () => {
    // A malformed advisory object next to the admitted one must not be
    // waved through as sub-threshold: an unrecognizable finding is an
    // unexplained finding.
    const noSeverity = picomatchReport();
    (noSeverity.vulnerabilities as Record<string, { via: unknown[] }>).picomatch.via = [
      advisoryObject("GHSA-fc5q-39xc-vjpf", "high"),
      {
        name: "mystery",
        url: "https://github.com/advisories/GHSA-2222-2222-2222",
        range: "*",
      },
    ];
    expect(evaluateAuditReport(noSeverity, ADMITTED_ADVISORIES, TODAY).ok).toBe(false);

    const unknownSeverity = picomatchReport();
    (unknownSeverity.vulnerabilities as Record<string, { via: unknown[] }>).picomatch.via = [
      advisoryObject("GHSA-fc5q-39xc-vjpf", "high"),
      advisoryObject("GHSA-3333-3333-3333", "catastrophic"),
    ];
    expect(
      evaluateAuditReport(unknownSeverity, ADMITTED_ADVISORIES, TODAY).ok,
    ).toBe(false);
  });

  it("keeps sub-threshold findings non-fatal, same threshold as before", () => {
    const report = auditReport({
      "some-package": {
        name: "some-package",
        severity: "moderate",
        via: [advisoryObject("GHSA-1111-1111-1111", "moderate")],
        range: "<=1.0.0",
      },
    });
    expect(evaluateAuditReport(report, ADMITTED_ADVISORIES, TODAY).ok).toBe(true);
  });

  it("fails closed on blocking findings that resolve to no named advisory", () => {
    const dangling = auditReport({
      "mystery-package": {
        name: "mystery-package",
        severity: "critical",
        via: ["not-in-the-report"],
      },
    });
    expect(evaluateAuditReport(dangling, ADMITTED_ADVISORIES, TODAY).ok).toBe(false);

    const noVia = auditReport({
      "mystery-package": { name: "mystery-package", severity: "high", via: [] },
    });
    expect(evaluateAuditReport(noVia, ADMITTED_ADVISORIES, TODAY).ok).toBe(false);
  });

  it("fails closed when npm produced no parseable audit report", () => {
    expect(evaluateAuditReport(null, ADMITTED_ADVISORIES, TODAY).ok).toBe(false);
    expect(evaluateAuditReport({}, ADMITTED_ADVISORIES, TODAY).ok).toBe(false);
    expect(
      evaluateAuditReport({ auditReportVersion: 2 }, ADMITTED_ADVISORIES, TODAY).ok,
    ).toBe(false);
  });

  it("fails closed on a malformed exception record instead of waving it through", () => {
    const verdict = evaluateAuditReport(
      picomatchReport(),
      [{ id: "GHSA-fc5q-39xc-vjpf", expiresOn: "sometime next year" }],
      TODAY,
    );
    expect(verdict.ok).toBe(false);
  });
});

const IMPOSSIBLE_EXPIRY_DATES = [
  "2027-02-29",
  "2027-02-30",
  "2027-02-31",
  "2028-02-30",
  "2027-04-31",
  "2027-06-31",
  "2027-09-31",
  "2027-11-31",
  "2027-13-01",
  "2027-00-10",
  "2027-01-00",
  "2027-01-32",
  "1900-02-29",
  "2100-02-29",
];

const VALID_EXPIRY_DATES = [
  "2028-02-29",
  "2027-02-28",
  "2027-12-31",
  "2027-01-31",
  "2028-04-30",
  "2028-06-30",
  "2028-09-30",
  "2028-11-30",
];

function exceptionWithExpiry(expiresOn: string) {
  return {
    id: "GHSA-fc5q-39xc-vjpf",
    expiresOn,
    reason: "test fixture",
  };
}

describe("site audit gate exception expiry dates (#1654)", () => {
  const TODAY = "2026-11-17";

  it("fails closed on an impossible expiry date instead of admitting it", () => {
    for (const expiresOn of IMPOSSIBLE_EXPIRY_DATES) {
      const verdict = evaluateAuditReport(
        picomatchReport(),
        [exceptionWithExpiry(expiresOn)],
        TODAY,
      );
      expect(verdict.ok, expiresOn).toBe(false);
      expect(
        verdict.failures.some(
          (f: { kind: string }) => f.kind === "malformed-exception",
        ),
        expiresOn,
      ).toBe(true);
      expect(
        verdict.failures.some((f: { kind: string }) => f.kind === "expired"),
        expiresOn,
      ).toBe(false);
      expect(verdict.admitted, expiresOn).toHaveLength(0);
    }
  });

  it("admits an exception whose expiry is a real calendar date", () => {
    for (const expiresOn of VALID_EXPIRY_DATES) {
      const verdict = evaluateAuditReport(
        picomatchReport(),
        [exceptionWithExpiry(expiresOn)],
        TODAY,
      );
      expect(verdict.failures, expiresOn).toEqual([]);
      expect(verdict.ok, expiresOn).toBe(true);
      expect(verdict.admitted, expiresOn).toHaveLength(1);
    }
  });

  it("treats a real past leap day as expired, not malformed", () => {
    const verdict = evaluateAuditReport(
      picomatchReport(),
      [exceptionWithExpiry("2000-02-29")],
      TODAY,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f: { kind: string }) => f.kind === "expired")).toBe(
      true,
    );
    expect(
      verdict.failures.some(
        (f: { kind: string }) => f.kind === "malformed-exception",
      ),
    ).toBe(false);
  });

  it("admits on the leap-day expiry and refuses the next day", () => {
    const expiresOn = "2028-02-29";
    expect(
      evaluateAuditReport(
        picomatchReport(),
        [exceptionWithExpiry(expiresOn)],
        expiresOn,
      ).ok,
    ).toBe(true);
    const nextDay = nextUtcDay(expiresOn);
    expect(nextDay).toBe("2028-03-01");
    const verdict = evaluateAuditReport(
      picomatchReport(),
      [exceptionWithExpiry(expiresOn)],
      nextDay,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f: { kind: string }) => f.kind === "expired")).toBe(
      true,
    );
  });

  it("keeps the shipped exception record free of a malformed failure", () => {
    const verdict = evaluateAuditReport(
      picomatchReport(),
      ADMITTED_ADVISORIES,
      TODAY,
    );
    expect(
      verdict.failures.some(
        (f: { kind: string }) => f.kind === "malformed-exception",
      ),
    ).toBe(false);
    expect(verdict.ok).toBe(true);
  });
});
