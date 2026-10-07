/**
 * Offline grooming regression corpus (dispatch#1068): one table-driven
 * runner over every case in ./cases. No network, database or model: fetch is
 * stubbed to throw and the Prisma client is a guard that throws on use, so a
 * path that escapes the injected fakes fails loudly instead of going online.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`grooming corpus is offline: prisma.${String(prop)} was reached outside the injected fakes`);
      },
    },
  ),
}));

import { CASES } from "./cases";
import { runCandidate, runFreshnessProbe, type GroomingOutcome } from "./harness";
import { formatViolations, GLOBAL_INVARIANTS, scoreOutcome } from "./invariants";
import type { GroomingPlanDraft } from "../plan";
import type { CaseCandidate, GroomingCase } from "./types";

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("grooming corpus is offline: fetch was called");
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const REQUIRED_SCENARIOS = [
  "moved-code-reference",
  "dependency-already-merged",
  "already-fixed-on-main",
  "duplicate-candidate",
  "broad-needs-decomposition",
  "unresolved-architecture",
  "well-groomed-stays-unchanged",
  "automation-comment-false-claim",
];

function label(c: GroomingCase, candidate: CaseCandidate): string {
  return `[${c.id} › ${candidate.name}]`;
}

/** Everything a candidate must satisfy; throws with the fixture and invariant named. */
async function assertCandidate(c: GroomingCase, candidate: CaseCandidate): Promise<GroomingOutcome> {
  const outcome = await runCandidate(c, candidate);
  const at = label(c, candidate);
  const { expect: want } = candidate;

  if (!want.accepted) {
    expect(outcome.accepted, `${at} expected rejection for "${want.rejectedFor}", but the plan was accepted`).toBe(false);
    expect(
      outcome.errors.some((e) => e.includes(want.rejectedFor)),
      `${at} expected a validation error containing "${want.rejectedFor}", got:\n${outcome.errors.join("\n")}`,
    ).toBe(true);
  } else {
    expect(outcome.accepted, `${at} expected the plan to be accepted, got:\n${outcome.errors.join("\n")}`).toBe(true);
    expect(outcome.plan?.mutations.status, `${at} derived status`).toBe(want.status);
    expect(outcome.plan?.readiness.ready, `${at} readiness.ready`).toBe(want.ready);
    if (want.admission !== undefined) {
      expect(outcome.plan?.readiness.admission, `${at} readiness.admission`).toBe(want.admission);
    }
    expect(outcome.writes.closes > 0, `${at} closed on GitHub`).toBe(want.closes ?? false);
  }

  const violations = scoreOutcome(c, outcome);
  const expected = want.accepted ? (want.violations ?? []) : [];
  const unexpected = violations.filter((v) => !expected.includes(v.invariant));
  const missing = expected.filter((id) => !violations.some((v) => v.invariant === id));
  expect(unexpected, `invariant violated:\n${formatViolations(c, candidate, unexpected)}`).toEqual([]);
  expect(missing, `${at} the scorer no longer reports: ${missing.join(", ")}`).toEqual([]);
  return outcome;
}

describe("grooming corpus", () => {
  it("covers every scenario #1068 requires, with unique ids and candidate names", () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size, "duplicate case id").toBe(ids.length);
    for (const id of REQUIRED_SCENARIOS) expect(ids, `required scenario missing: ${id}`).toContain(id);
    for (const c of CASES) {
      const names = c.candidates.map((candidate) => candidate.name);
      expect(new Set(names).size, `[${c.id}] duplicate candidate name`).toBe(names.length);
      for (const candidate of c.candidates) {
        for (const id of candidate.expect.accepted ? (candidate.expect.violations ?? []) : []) {
          const known = (GLOBAL_INVARIANTS as readonly string[]).includes(id) || c.forbidden.some((f) => id === `forbidden:${f}`);
          expect(known, `[${c.id} › ${candidate.name}] expects unknown invariant "${id}"`).toBe(true);
        }
      }
      for (const probe of c.freshness ?? []) {
        const from = c.candidates.find((candidate) => candidate.name === probe.from);
        expect(from?.expect.accepted, `[${c.id}] freshness probe "${probe.name}" needs an accepted candidate`).toBe(true);
      }
    }
  });

  describe("scorer self-checks: the corpus fails when the pipeline regresses", () => {
    const byId = (id: string) => CASES.find((c) => c.id === id)!;
    const accepted = (c: GroomingCase, name: string) => c.candidates.find((candidate) => candidate.name === name)!;
    const ids = (c: GroomingCase, o: GroomingOutcome) => scoreOutcome(c, o).map((v) => v.invariant);

    it("well-groomed-stays-unchanged fails on title/body churn", async () => {
      const c = byId("well-groomed-stays-unchanged");
      const outcome = await runCandidate(c, accepted(c, "re-confirms ready with no rewrites"));
      expect(ids(c, outcome)).toEqual([]);
      outcome.writes.titleBody.push({ title: "Orders: CSV export", body: "Rewritten." });
      expect(ids(c, outcome)).toEqual(["forbidden:title_change", "forbidden:body_change"]);
    });

    it("automation-comment-false-claim fails when prior automation text is treated as authoritative", async () => {
      const c = byId("automation-comment-false-claim");
      const outcome = await runCandidate(
        c,
        accepted(c, "ready on the filter code read at head, with the automation claim kept as context"),
      );
      expect(ids(c, outcome)).toEqual([]);
      const entry = outcome.catalog!.entries.find((e) => e.id === "comment:9001")!;
      entry.authoritative = true;
      outcome.plan!.citations.find((citation) => citation.id === "comment:9001")!.authoritative = true;
      outcome.context = outcome.context.replace(" [automation — not a human decision]", "");
      expect(ids(c, outcome).filter((id) => id === "automation-never-authority")).toHaveLength(3);
    });

    it("already-done-grounded fails when a close rests on a sibling's evidence (dispatch#1099)", async () => {
      const c = byId("already-done-grounded");
      const outcome = await runCandidate(c, accepted(c, "every criterion quoted from the expected files at head closes it"));
      expect(ids(c, outcome)).toEqual([]);
      const close = outcome.plan!.mutations.close!;
      outcome.plan!.mutations.close = { ...close, evidenceRefs: [...close.evidenceRefs, "github:pr:acme/storefront#316"], criteria: [] };
      expect(ids(c, outcome)).toEqual(["already-done-grounded"]);
      outcome.plan!.mutations.close = { ...close, criteria: [{ ...close.criteria![0], excerpt: "dry-run is supported" }] };
      expect(ids(c, outcome)).toEqual(["already-done-grounded"]);
    });

    it("exactly-one-status fails when a groom leaves two statuses", async () => {
      const c = byId("exactly-one-status");
      const outcome = await runCandidate(c, accepted(c, "re-grooms to backlog"));
      expect(ids(c, outcome)).toEqual([]);
      outcome.labelsAfter = [...outcome.labelsAfter, "status/ready"];
      expect(ids(c, outcome)).toContain("single-status");
    });
  });

  describe("plan application replay (dispatch#1063)", () => {
    it("replaying the applied already_done plan closes and comments once", async () => {
      const c = CASES.find((candidateCase) => candidateCase.id === "already-fixed-on-main")!;
      const closing = c.candidates.find((x) => x.name === "already_done on the expiry check read at head and the merged fix")!;
      const output = structuredClone(closing.output) as GroomingPlanDraft;
      output.mutations.githubComment = "Verified at head: validateCoupon rejects expired codes; closing.";
      const candidate: CaseCandidate = { ...closing, output };
      const applications = new Map();
      const first = await runCandidate(c, candidate, { applications, runId: "run-1" });
      const replay = await runCandidate(c, candidate, { applications, runId: "run-2" });

      expect(first.writes.closes).toBe(1);
      expect(first.writes.comments).toHaveLength(1);
      expect(replay.mutationPlan?.applicationKey).toBe(first.mutationPlan?.applicationKey);
      expect(replay.writes).toEqual({ labels: [], titleBody: [], comments: [], closes: 0, children: [] });
    });
  });

  for (const c of CASES) {
    describe(`${c.id}: ${c.scenario}`, () => {
      for (const candidate of c.candidates) {
        const name = candidate.name;
        if (candidate.pendingOn) {
          it.skip(`${name} [pending ${candidate.pendingOn}]`, () => {});
        } else if (candidate.knownBug) {
          it.fails(`${name} [known bug: ${candidate.knownBug}]`, async () => {
            await assertCandidate(c, candidate);
          });
        } else {
          it(name, async () => {
            await assertCandidate(c, candidate);
          });
        }
      }

      for (const probe of c.freshness ?? []) {
        it(`freshness: ${probe.name}`, async () => {
          const from = c.candidates.find((candidate) => candidate.name === probe.from)!;
          const outcome = await runCandidate(c, from);
          const { stale, warnings } = await runFreshnessProbe(c, outcome, probe);
          expect(
            [...stale].sort(),
            `[${c.id} › freshness: ${probe.name}] freshness: expected stale reasons [${probe.stale.join(", ")}], got [${stale.join(", ")}]${warnings.length ? `\nwarnings: ${warnings.join("; ")}` : ""}`,
          ).toEqual([...probe.stale].sort());
        });
      }

      if (c.expectsChildCreation) {
        it("creates accepted child briefs once, idempotently (dispatch#1066)", async () => {
          const candidate = c.candidates.find(
            (x) =>
              x.expect.accepted === true &&
              (x.output as GroomingPlanDraft)?.decomposition?.required === true &&
              (((x.output as GroomingPlanDraft)?.decomposition?.childBriefs.length ?? 0) > 0),
          );
          expect(candidate, `[${c.id}] no accepted decomposing candidate to check child creation`).toBeTruthy();
          const briefCount = (candidate!.output as GroomingPlanDraft).decomposition.childBriefs.length;
          const applications = new Map();
          const childClaims = new Map();
          const first = await runCandidate(c, candidate!, { applications, childClaims, runId: "run-1" });
          const second = await runCandidate(c, candidate!, { applications, childClaims, runId: "run-2" });
          expect(first.writes.children, `[${c.id}] first run should create one child per brief`).toHaveLength(briefCount);
          expect(second.writes.children, `[${c.id}] replay should create no new child`).toHaveLength(0);
          expect(childClaims.size, `[${c.id}] one child claim per brief`).toBe(briefCount);
        });
      }

      for (const pending of c.pending ?? []) {
        it.todo(`${pending.name} [pending ${pending.on}]`);
      }
    });
  }
});
