#!/usr/bin/env node
// #1653: the `site/` npm audit gate with a reviewed, time-boxed advisory
// exception. Both call sites — the `audit-site` job in
// `.github/workflows/security-audit.yaml` and the `validate` job in
// `.github/workflows/pages.yaml` — run this one script, so the exception can
// never drift between them (pinned by `site-package-audit.test.ts`).
//
// The gate itself is unchanged from #1566: `npm audit` over the `site/` tree
// with `--include=dev --audit-level=high` and the same fetch-retry flags,
// blocking, reading the lockfile (no install needed). What is added is a
// single admitted advisory: a high/critical finding passes only when every
// blocking advisory resolves to an entry in ADMITTED_ADVISORIES below AND
// that entry's exception window is still open. Every other advisory — and
// this one after its expiry — fails the gate. Failures to parse, unresolvable
// findings, and malformed exception records all fail closed.
//
// The admitted exception exists because GHSA-fc5q-39xc-vjpf (picomatch
// regex-denial-of-service, high, CVSS 7.5) was widened on 2026-11-17 to
// `<= 4.0.7` with no patched release, and astro — the site framework —
// depends on picomatch@^4.0.7 directly and through six transitive paths. The
// accepted-risk record, including the review trigger, lives in
// SECURITY-ACCEPTED-RISKS.md.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The exception list is deliberately exact: one advisory, named by GHSA id.
// Do not add entries here without an accepted-risk record in
// SECURITY-ACCEPTED-RISKS.md and a human review of that record.
export const ADMITTED_ADVISORIES = [
  {
    id: "GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    // Exception is valid through this UTC date, inclusive; the gate fails
    // again from the following day until a human renews or retires it.
    // Keep in sync with the record in SECURITY-ACCEPTED-RISKS.md
    // (site-package-audit.test.ts pins the two dates against each other).
    expiresOn: "2027-02-17",
    reason:
      "picomatch ReDoS with no patched release (every published version, <= 4.0.7, is affected); the site build parses only its own glob patterns, never a published-site reader's input.",
  },
];

// The exact audit invocation, kept flag-for-flag identical to the #1566 gate
// plus `--json` for machine-readable adjudication.
export const NPM_AUDIT_ARGS = [
  "audit",
  "--include=dev",
  "--audit-level=high",
  "--json",
  "--fetch-retries=5",
  "--fetch-timeout=120000",
  "--fetch-retry-mintimeout=20000",
  "--fetch-retry-maxtimeout=120000",
];

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const KNOWN_SEVERITIES = new Set(["info", "low", "moderate", "high", "critical"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GHSA_IN_URL = /advisories\/(GHSA-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+)/i;

function blocking(severity) {
  return BLOCKING_SEVERITIES.has(String(severity ?? "").toLowerCase());
}

// Follow one vulnerable package entry to the advisory objects it resolves to.
// In the npm v2 audit report a blocking entry is either the vulnerable leaf
// (its `via` carries the advisory object with the GHSA url) or a transitive
// dependent (its `via` lists only strings naming the packages below it). The
// advisories of a dependent are therefore exactly the advisory objects found
// by walking those strings down; an unresolvable string or an advisory object
// without a GHSA url is an unexplained blocking finding, reported as such so
// the caller fails closed rather than waving it through.
function resolveBlockingAdvisories(entryName, vulnerabilities) {
  const advisories = new Map();
  let unexplained = false;
  const seen = new Set();
  const stack = [entryName];
  while (stack.length > 0) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const entry = vulnerabilities[current];
    if (!entry) {
      unexplained = true;
      continue;
    }
    for (const via of entry.via ?? []) {
      if (typeof via === "string") {
        stack.push(via);
        continue;
      }
      const id = String(via.url ?? "").match(GHSA_IN_URL)?.[1];
      const severity = String(via.severity ?? "").toLowerCase();
      if (!id || !KNOWN_SEVERITIES.has(severity)) {
        // An advisory object without a parseable GHSA id or with an
        // unrecognized severity cannot be matched against the exception
        // list or the threshold: unexplained, fail closed. A recognized
        // sub-threshold severity is skipped — the gate threshold is high.
        unexplained = true;
        continue;
      }
      if (!blocking(severity)) continue;
      const key = id.toUpperCase();
      if (!advisories.has(key)) {
        advisories.set(key, {
          id,
          // The advisory object's own `name` is the affected package; the
          // entry that surfaced it may be a transitive dependent.
          name: typeof via.name === "string" ? via.name : current,
          severity: via.severity,
          url: via.url,
          range: via.range,
        });
      }
    }
  }
  return { advisories, unexplained };
}

// Pure adjudication of one `npm audit --json` report, so the exception logic
// is unit-testable without a network call. `todayIso` is a YYYY-MM-DD string.
// Returns { ok, failures[], admitted[] } where failures describe every reason
// the gate must stay red and admitted describes the exceptions applied.
export function evaluateAuditReport(report, admitted, todayIso) {
  const failures = [];
  const admittedHits = new Map();

  const admittedById = new Map();
  for (const exception of admitted ?? []) {
    const valid =
      typeof exception?.id === "string" &&
      /^GHSA-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/i.test(exception.id) &&
      typeof exception?.expiresOn === "string" &&
      ISO_DATE.test(exception.expiresOn);
    if (!valid) {
      // A malformed exception record is never load-bearing: fail closed.
      failures.push({
        kind: "malformed-exception",
        note: `exception record for ${JSON.stringify(exception?.id)} is malformed (need a GHSA id and a YYYY-MM-DD expiresOn)`,
      });
      continue;
    }
    admittedById.set(exception.id.toUpperCase(), exception);
  }

  if (
    !report ||
    typeof report !== "object" ||
    report.auditReportVersion === undefined ||
    typeof report.vulnerabilities !== "object" ||
    report.vulnerabilities === null
  ) {
    failures.push({
      kind: "no-report",
      note: "npm audit did not produce a parseable audit report",
    });
    return { ok: false, failures, admitted: [] };
  }

  const vulnerabilities = report.vulnerabilities;
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!blocking(entry?.severity)) continue;
    const { advisories, unexplained } = resolveBlockingAdvisories(name, vulnerabilities);
    if (unexplained || advisories.size === 0) {
      failures.push({
        kind: "unattributed",
        package: name,
        severity: entry?.severity,
        note: `blocking finding on ${name} does not resolve to a named advisory`,
      });
      continue;
    }
    for (const advisory of advisories.values()) {
      const exception = admittedById.get(advisory.id.toUpperCase());
      if (!exception) {
        failures.push({ kind: "unadmitted", package: name, advisory });
      } else if (todayIso > exception.expiresOn) {
        failures.push({ kind: "expired", package: name, advisory, exception });
      } else if (!admittedHits.has(advisory.id.toUpperCase())) {
        admittedHits.set(advisory.id.toUpperCase(), { package: name, advisory, exception });
      }
    }
  }

  return { ok: failures.length === 0, failures, admitted: [...admittedHits.values()] };
}

function main() {
  const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
  const result = spawnSync("npm", NPM_AUDIT_ARGS, {
    cwd: siteDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    console.error(`site audit gate: failed to run npm audit: ${result.error.message}`);
    process.exit(1);
  }

  // npm writes the JSON report to stdout and notices to stderr; parse from
  // the first "{" so a stray prefix line cannot hide the report.
  const stdout = result.stdout ?? "";
  const jsonStart = stdout.indexOf("{");
  let report = null;
  if (jsonStart !== -1) {
    try {
      report = JSON.parse(stdout.slice(jsonStart));
    } catch {
      report = null;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const verdict = evaluateAuditReport(report, ADMITTED_ADVISORIES, today);

  if (!verdict.ok) {
    for (const failure of verdict.failures) {
      if (failure.advisory) {
        const label = failure.kind === "expired" ? "EXPIRED exception" : "no exception";
        console.error(
          `site audit gate FAIL: ${failure.advisory.id} in ${failure.advisory.name ?? failure.package} ` +
            `(${failure.advisory.severity}, ${failure.advisory.range ?? "range unknown"}) — ${label}` +
            (failure.exception ? ` valid through ${failure.exception.expiresOn}` : "") +
            `; see SECURITY-ACCEPTED-RISKS.md`,
        );
      } else {
        console.error(`site audit gate FAIL (${failure.kind}): ${failure.note}`);
      }
    }
    // Keep the raw report tail available for triage; it is what npm saw.
    if (stdout.trim().length > 0) console.error(stdout.trim());
    process.exit(1);
  }

  for (const hit of verdict.admitted) {
    console.warn(
      `site audit gate: ADMITTED (accepted risk, expires ${hit.exception.expiresOn} UTC) ` +
        `${hit.advisory.id} in ${hit.advisory.name ?? hit.package} (${hit.advisory.severity}, ` +
        `${hit.advisory.range ?? "range unknown"}) — ${hit.exception.reason}`,
    );
  }
  // An adjudicated pass that contradicts npm's own exit code is a corrupt
  // signal, in either direction: admitted findings but a clean npm, or a
  // failing npm whose report shows nothing blocking. Fail closed.
  const npmBlocked = result.status !== 0;
  if (npmBlocked !== (verdict.admitted.length > 0)) {
    console.error(
      `site audit gate FAIL: npm audit exited ${result.status} but the report adjudicates ` +
        `${verdict.admitted.length} admitted blocking finding(s) and no failures`,
    );
    process.exit(1);
  }
  console.log("site audit gate: PASS");
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
