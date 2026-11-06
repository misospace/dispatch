// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

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

// The exact command both call sites run. Pinned verbatim so a change to the
// flags in one workflow cannot silently diverge from the other, and so the
// scope (`--include=dev`) and the severity threshold (`--audit-level=high`)
// stay the ones the issue asks for.
const SITE_AUDIT_COMMAND =
  "npm audit --include=dev --audit-level=high --fetch-retries=5 --fetch-timeout=120000 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000";

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

// The step that audits the SITE tree: it runs the pinned command AND points
// the working directory at site/. The app-level informational pass in
// security-audit.yaml runs the same command without a working directory, so
// the two are told apart by the working directory, not by the command.
function siteAuditSteps(path: string): Step[] {
  return readSteps(path).filter(
    (step) =>
      step.body.includes(SITE_AUDIT_COMMAND) &&
      /^\s*working-directory:\s*site\s*$/m.test(step.body),
  );
}

// The job that carries the site audit. The app-level informational pass in
// security-audit.yaml runs the same command in the app tree, so the job is
// told apart by the site working directory, not by the command.
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

      it("runs the pinned dev-inclusive command at --audit-level=high", () => {
        const [step] = siteAuditSteps(workflowPath);
        expect(step.body).toContain(SITE_AUDIT_COMMAND);
        expect(SITE_AUDIT_COMMAND).toContain("--include=dev");
        expect(SITE_AUDIT_COMMAND).toContain("--audit-level=high");
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
