/**
 * Invariant scoring for the grooming corpus (dispatch#1068).
 *
 * scoreOutcome checks one outcome against every global invariant plus the
 * case's forbidden outcomes and returns the violations; an empty list is a
 * pass. It inspects decisions and mutations only, never wording, so the same
 * corpus can score any prompt, schema version or model.
 */
import { getClaimableLanes } from "@/lib/lane-config";
import { IN_FLIGHT_STATUSES, PLAN_LIMITS, type GroomingPlanCitation } from "../plan";
import type { EvidenceCatalogEntry } from "../plan-evidence";
import type { GroomingOutcome } from "./harness";
import type { CaseCandidate, ForbiddenOutcome, GroomingCase } from "./types";

export interface Violation {
  /** Invariant id, e.g. "single-status" or "forbidden:close". */
  invariant: string;
  message: string;
}

/** Global invariant ids, each checked for every candidate of every case. */
export const GLOBAL_INVARIANTS = [
  "fail-closed",
  "single-status",
  "ready-requires-pinned-read",
  "automation-never-authority",
  "issue-body-not-authority",
  "close-only-already-done",
  "already-done-current-evidence",
  "dependency-truth",
  "in-flight-untouched",
  "design-escalates",
  "decomposition-bounded",
] as const;

const isStatus = (label: string) => label.startsWith("status/");

function anyWrite(o: GroomingOutcome): boolean {
  const w = o.writes;
  return w.labels.length > 0 || w.titleBody.length > 0 || w.comments.length > 0 || w.closes > 0;
}

function entryFor(o: GroomingOutcome, id: string): EvidenceCatalogEntry | undefined {
  return o.catalog?.entries.find((entry) => entry.id === id);
}

function isPinnedRead(o: GroomingOutcome, id: string): boolean {
  const entry = entryFor(o, id);
  return !!entry && entry.subject === "repository" && entry.pinned && !!o.catalog?.binding.headSha;
}

/** Evidence other than the issue itself and automation output. */
function isIndependent(citation: GroomingPlanCitation | EvidenceCatalogEntry | undefined): boolean {
  return !!citation && citation.subject !== "issue" && citation.provenance !== "automation_comment";
}

function nonStatusDiff(before: string[], after: string[]): string[] {
  const b = new Set(before.filter((l) => !isStatus(l)));
  const a = new Set(after.filter((l) => !isStatus(l)));
  return [...[...a].filter((l) => !b.has(l)).map((l) => `+${l}`), ...[...b].filter((l) => !a.has(l)).map((l) => `-${l}`)];
}

function globalViolations(c: GroomingCase, o: GroomingOutcome): Violation[] {
  const v: Violation[] = [];
  const add = (invariant: string, message: string) => v.push({ invariant, message });
  const inFlight = o.labelsBefore.some((l) => IN_FLIGHT_STATUSES.includes(l as never));

  // Every automation comment reaches the model tagged, and the catalog never
  // lets it be authority, whatever the plan does with it.
  for (const comment of c.comments ?? []) {
    const entry = entryFor(o, `comment:${comment.id}`);
    if (entry?.provenance === "automation_comment" && entry.authoritative) {
      add("automation-never-authority", `comment:${comment.id} by ${comment.author} is marked authoritative in the catalog`);
    }
    if (entry?.provenance === "automation_comment" && !o.context.includes(`${comment.author} [automation`)) {
      add("automation-never-authority", `comment:${comment.id} by ${comment.author} reached the prompt without the automation tag`);
    }
  }

  if (!o.accepted) {
    if (anyWrite(o) || o.issueData) {
      add("fail-closed", "a rejected plan still wrote to GitHub or the issue row");
    }
    return v;
  }

  const plan = o.plan;
  if (!plan) {
    add("fail-closed", "an accepted plan produced no GroomingPlan");
    return v;
  }
  const { verdict } = plan;
  const ready = plan.readiness.ready;
  const closed = o.writes.closes > 0;

  if (inFlight) {
    if (anyWrite(o)) add("in-flight-untouched", `issue is ${o.labelsBefore.filter((l) => IN_FLIGHT_STATUSES.includes(l as never)).join(", ")} but the run wrote to GitHub`);
    if (o.issueData && "currentLane" in o.issueData) add("in-flight-untouched", "the run moved the lane of an in-flight issue");
  } else {
    const statuses = o.labelsAfter.filter(isStatus);
    if (statuses.length !== 1) {
      add("single-status", `labels after the run carry ${statuses.length} status labels: ${statuses.join(", ") || "none"}`);
    } else if (statuses[0] !== plan.mutations.status) {
      add("single-status", `applied ${statuses[0]} but the plan derived ${plan.mutations.status}`);
    }
  }

  if (ready) {
    if (!verdict.evidenceRefs.some((id) => isPinnedRead(o, id))) {
      add("ready-requires-pinned-read", "ready without a repository citation read at the pinned head SHA");
    }
    if (verdict.workType === "implementation") {
      const vcb = plan.implementationBrief?.verifiedCurrentBehavior.evidenceRefs ?? [];
      if (!vcb.some((id) => isPinnedRead(o, id))) {
        add("ready-requires-pinned-read", "verifiedCurrentBehavior is not backed by a pinned read");
      }
      for (const path of plan.implementationBrief?.relevantPaths ?? []) {
        if (path.change === "modify" && !isPinnedRead(o, path.ref)) {
          add("ready-requires-pinned-read", `the brief modifies ${path.ref}, which was never read at the pinned head SHA`);
        }
      }
    }
  }

  for (const citation of plan.citations) {
    if (citation.provenance === "automation_comment" && citation.authoritative) {
      add("automation-never-authority", `${citation.id} is cited as authoritative automation output`);
    }
  }
  const verdictCitations = verdict.evidenceRefs.map((id) => plan.citations.find((c) => c.id === id));
  if (verdictCitations.length > 0 && verdictCitations.every((c) => c?.provenance === "automation_comment")) {
    add("automation-never-authority", `the ${verdict.actionability} verdict cites only automation output`);
  }
  const decisionRefs = closed ? (plan.mutations.close?.evidenceRefs ?? []) : ready ? verdict.evidenceRefs : [];
  if ((ready || closed) && decisionRefs.length > 0) {
    const cited = decisionRefs.map((id) => plan.citations.find((c) => c.id === id));
    if (!cited.some((citation) => citation?.provenance !== "automation_comment" && citation !== undefined)) {
      add("automation-never-authority", `${closed ? "close" : "ready"} rests only on automation output`);
    }
    if (!cited.some(isIndependent)) {
      add("issue-body-not-authority", `${closed ? "close" : "ready"} rests only on the issue's own text or automation output`);
    }
  }

  if (closed) {
    if (verdict.actionability !== "already_done" || plan.mutations.close?.reason !== "already_done") {
      add("close-only-already-done", `closed on GitHub with verdict ${verdict.actionability} / close reason ${plan.mutations.close?.reason ?? "none"}`);
    }
    if (verdict.uncertainties.some((u) => u.material)) {
      add("close-only-already-done", "closed while a material uncertainty remains");
    }
    const close = plan.mutations.close?.evidenceRefs ?? [];
    if (!close.some((id) => isPinnedRead(o, id))) {
      add("already-done-current-evidence", "closed without citing repository evidence read at the pinned head SHA");
    }
    if (verdict.confidence !== "high") {
      add("already-done-current-evidence", `closed at ${verdict.confidence} confidence`);
    }
    if (o.issueData?.state !== "closed") {
      add("close-only-already-done", "closed on GitHub but the local issue row was not marked closed");
    }
  } else if (verdict.actionability === "already_done" && !inFlight) {
    add("close-only-already-done", "already_done was accepted but the issue was not closed");
  }

  const closedDependencies = (c.closedDependencies ?? []).map((key) => key.toLowerCase());
  for (const [i, dep] of (plan.implementationBrief?.dependencies ?? []).entries()) {
    const entry = dep.evidenceRef ? entryFor(o, dep.evidenceRef) : undefined;
    if (entry?.state && dep.state === "open" && entry.state !== "open") {
      add("dependency-truth", `dependencies[${i}] ${dep.ref} is stated open but ${entry.id} is ${entry.state}`);
    }
    const key = (dep.ref.startsWith("#") ? `${c.repoFullName}${dep.ref}` : dep.ref).toLowerCase();
    if (dep.state === "open" && closedDependencies.includes(key)) {
      add("dependency-truth", `dependencies[${i}] ${dep.ref} is stated open but it is closed`);
    }
  }
  const openBlockers = (o.issueData?.groomedOpenBlockerKeys as string[] | undefined) ?? [];
  for (const key of closedDependencies) {
    if (openBlockers.includes(key)) {
      add("dependency-truth", `${key} is closed but the freshness baseline records it as an open blocker`);
    }
  }

  if (ready && verdict.workType === "design") {
    const escalation = getClaimableLanes().find((lane) => lane.role === "escalation")?.id;
    if (plan.readiness.admission !== "escalation" || plan.readiness.lane !== escalation) {
      add("design-escalates", `ready design work admitted as ${plan.readiness.admission} to lane ${plan.readiness.lane}`);
    }
  }

  if (plan.decomposition.childBriefs.length > PLAN_LIMITS.childBriefs) {
    add("decomposition-bounded", `${plan.decomposition.childBriefs.length} child briefs exceed the bound of ${PLAN_LIMITS.childBriefs}`);
  }
  if (plan.decomposition.required && ready && verdict.workType === "implementation") {
    add("decomposition-bounded", "an issue that must be split was admitted as one implementation task");
  }

  return v;
}

function forbiddenViolations(c: GroomingCase, o: GroomingOutcome): Violation[] {
  const hits: Array<[ForbiddenOutcome, boolean, string]> = [
    ["ready", o.plan?.readiness.ready === true || (o.labelsAfter.includes("status/ready") && !o.labelsBefore.includes("status/ready")), "the issue was made ready"],
    ["implementation_admission", o.plan?.readiness.admission === "implementation", "the issue was admitted to an implementation worker"],
    ["close", o.writes.closes > 0, "the issue was closed on GitHub"],
    ["title_change", o.writes.titleBody.some((w) => w.title !== undefined), "the title was rewritten"],
    ["body_change", o.writes.titleBody.some((w) => w.body !== undefined), "the body was rewritten"],
    ["label_change", nonStatusDiff(o.labelsBefore, o.labelsAfter).length > 0, `labels changed: ${nonStatusDiff(o.labelsBefore, o.labelsAfter).join(" ")}`],
    ["github_write", anyWrite(o), "the run wrote to GitHub"],
  ];
  return hits
    .filter(([id, hit]) => c.forbidden.includes(id) && hit)
    .map(([id, , message]) => ({ invariant: `forbidden:${id}`, message }));
}

export function scoreOutcome(c: GroomingCase, o: GroomingOutcome): Violation[] {
  return [...globalViolations(c, o), ...forbiddenViolations(c, o)];
}

/** One line per violation, naming the fixture, the candidate and the invariant. */
export function formatViolations(c: GroomingCase, candidate: CaseCandidate, violations: Violation[]): string {
  return violations.map((v) => `[${c.id} › ${candidate.name}] ${v.invariant}: ${v.message}`).join("\n");
}
