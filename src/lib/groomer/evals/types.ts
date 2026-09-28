/**
 * Fixture schema for the offline grooming regression corpus (dispatch#1068).
 *
 * One GroomingCase is one maintainer failure mode: the issue as GitHub holds
 * it, its comments, what the run's exploration read or merely surfaced, the
 * related GitHub work it observed, and the outcomes that must never happen.
 * Each case carries candidate model outputs (good ones and the mistakes a
 * model actually makes) and what the deterministic pipeline must do with
 * each. The corpus scores invariants, never prose.
 *
 * Adding a case: write `cases/<id>.ts` exporting a GroomingCase and list it
 * in `cases/index.ts`. The runner picks it up; nothing else changes.
 *
 * Evaluating a new prompt/schema version: feed its raw output for a case to
 * `runCandidate` + `scoreOutcome` (harness.ts / invariants.ts). The scorer
 * reports every global invariant and every forbidden outcome it violates.
 */
import type { StatusLabel } from "@/types";
import type { RelatedWorkObservation } from "../evidence-snapshot";
import type { GroomingStaleReason } from "../freshness";

export interface CaseIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  /** Dispatch's cached lane at selection time. */
  lane?: string | null;
}

/**
 * A GitHub comment. Provenance (human vs automation) is NOT declared here: the
 * real snapshot collector derives it from the author, so a fixture cannot
 * accidentally mark an automation comment authoritative.
 */
export interface CaseComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface CaseRepository {
  /** Default-branch head the run pinned; null models an unresolvable head. */
  headSha: string | null;
  defaultBranch?: string;
  /** Paths read with read_file at the pinned SHA. */
  read?: string[];
  /**
   * What read_file returned for some of `read`, keyed by path: the content an
   * already_done close's excerpts are checked against (dispatch#1099). A read
   * path without content here was read but its text is not available.
   */
  contents?: Record<string, string>;
  /** Paths only surfaced by a code-search hit or named in findings; never read. */
  surfaced?: string[];
}

/** An issue Dispatch tracks, for the dependency open-set lookup. */
export interface TrackedIssue {
  number: number;
  state: "open" | "closed";
}

/**
 * Outcomes a case forbids for every candidate. The deterministic pipeline
 * must make them impossible; when it cannot (a structurally valid but wrong
 * model output), the scorer still reports them so a model eval fails.
 */
export type ForbiddenOutcome =
  /** readiness.ready is true / status/ready applied. */
  | "ready"
  /** Admitted to a normal implementation worker. */
  | "implementation_admission"
  /** The issue is closed on GitHub. */
  | "close"
  /** The issue title is rewritten on GitHub. */
  | "title_change"
  /** The issue body is rewritten on GitHub. */
  | "body_change"
  /** A non-status label is added or removed. */
  | "label_change"
  /** Any GitHub write at all. */
  | "github_write";

export type CandidateExpectation =
  | {
      accepted: false;
      /** A fragment one of the deterministic validation errors must contain. */
      rejectedFor: string;
    }
  | {
      accepted: true;
      /** The single status the plan derives. */
      status: StatusLabel;
      ready: boolean;
      admission?: "implementation" | "escalation" | null;
      /** Whether the issue is closed on GitHub. Defaults to false. */
      closes?: boolean;
      /**
       * Invariant ids the scorer must report for this candidate. Only for a
       * model mistake the validator structurally cannot see; the entry
       * documents that the corpus catches it at eval time instead.
       */
      violations?: string[];
    };

export interface CaseCandidate {
  /** What this model output does, read as a test name. */
  name: string;
  /** The raw model output, exactly as the LLM call would return it. */
  output: unknown;
  /**
   * The model's answer to the repair turn (dispatch#1126), when `output` is
   * rejected. Absent, the model repeats `output`.
   */
  repair?: unknown;
  expect: CandidateExpectation;
  /**
   * Set when the expected behavior depends on a child issue that has not
   * landed. The candidate is kept (so landing it is a one-line change) but
   * skipped, with this reason in the test name.
   */
  pendingOn?: string;
  /**
   * Set when the expectation is right but merged code does not meet it yet.
   * The runner asserts the expectation FAILS (vitest `it.fails`), so the bug
   * stays visible and the test flips red the day it is fixed.
   */
  knownBug?: string;
}

export type FreshnessEvent =
  | { kind: "none" }
  | { kind: "issue_edit"; title?: string; body?: string; addLabels?: string[]; removeLabels?: string[] }
  | { kind: "comment"; author: string }
  | { kind: "commit"; files: string[] }
  | { kind: "dependency_state"; number: number; state: "open" | "closed" }
  | { kind: "related_state"; key: string; state: "open" | "closed" | "merged" };

/**
 * After a candidate is applied, one event happens; the freshness pass must
 * mark the result stale for exactly `stale` (empty: it stays fresh).
 */
export interface FreshnessProbe {
  name: string;
  /** Name of an accepted candidate in this case whose applied result is the baseline. */
  from: string;
  event: FreshnessEvent;
  stale: GroomingStaleReason[];
}

/** Behavior a child issue will add, with no candidate shape to pin yet. */
export interface PendingBehavior {
  name: string;
  on: string;
}

export interface GroomingCase {
  /** Unique kebab-case id; every failure message starts with it. */
  id: string;
  /** The maintainer failure mode this case guards, in one sentence. */
  scenario: string;
  /** The Dispatch history this case regresses, when it has one. */
  regressionOf?: string;
  repoFullName: string;
  issue: CaseIssue;
  comments?: CaseComment[];
  repository: CaseRepository;
  relatedWork?: Array<Pick<RelatedWorkObservation, "key" | "kind" | "state" | "via" | "closes" | "baseRef">>;
  trackedIssues?: TrackedIssue[];
  /** Dependency keys (`owner/repo#N`) that are merged/closed and must never count as open blockers. */
  closedDependencies?: string[];
  forbidden: ForbiddenOutcome[];
  candidates: CaseCandidate[];
  freshness?: FreshnessProbe[];
  pending?: PendingBehavior[];
}
