/**
 * Deterministic harness for the grooming corpus (dispatch#1068).
 *
 * Runs one candidate model output through the real hosted-groomer path —
 * evidence snapshot collection, exploration folding, catalog, prompt
 * context, plan validation, the legacy-output mapping and the mutation
 * applier — with every external dependency replaced by an in-memory fake.
 * Nothing here reaches the network, a database or a model: the model's
 * answer is the candidate itself.
 */
import type { GitHubIssue } from "@/types";
import { dependencyKey } from "@/lib/issue-dependencies";
import type { HostedGroomerConfig } from "../config";
import { buildIssueContext } from "../context";
import { collectGroomingEvidenceSnapshot, type RelatedWorkObservation } from "../evidence-snapshot";
import type { ExploreResult } from "../explore";
import type { CommitComparison } from "@/lib/github-code-search";
import {
  DEFAULT_FRESHNESS_BUDGET,
  runGroomingFreshnessPass,
  type FreshnessGitHub,
  type FreshnessIssueRow,
  type FreshnessStore,
} from "../freshness-invalidation";
import type { GroomingStaleReason } from "../freshness";
import { validateGroomingPlan, type GroomingPlan, type GroomingPlanValidationResult } from "../plan";
import type { EvidenceCatalog } from "../plan-evidence";
import { runHostedGroomer, type GroomerDeps } from "../run";
import type { GroomerOutput } from "../schema";
import type { GroomingCandidate } from "../selector";
import type { CaseCandidate, FreshnessProbe, GroomingCase } from "./types";

export interface GitHubWrites {
  labels: string[][];
  titleBody: Array<{ title?: string; body?: string | null }>;
  comments: string[];
  closes: number;
  children: Array<{ number: number; url: string }>;
}

export interface GroomingOutcome {
  accepted: boolean;
  /** Deterministic validation errors when the plan was rejected. */
  errors: string[];
  plan?: GroomingPlan;
  output?: GroomerOutput;
  /** The catalog the run rendered into the prompt and validated against. */
  catalog: EvidenceCatalog | null;
  /** The issue context the model was prompted with. */
  context: string;
  labelsBefore: string[];
  /** The label set on GitHub after the run. */
  labelsAfter: string[];
  writes: GitHubWrites;
  /** Local Issue columns the run wrote (grooming fields + freshness baseline). */
  issueData: Record<string, unknown> | null;
  mutationPlan?: Record<string, unknown>;
}

const RUN_CONFIG: HostedGroomerConfig = {
  enabled: true,
  dryRun: false,
  llmBaseUrl: "https://llm.corpus.invalid",
  apiKey: "corpus-offline",
  model: "corpus-candidate",
  responseFormat: true,
  timeoutMs: 1000,
  maxContextBytes: 8192,
  repoContextEnabled: false,
  maxContextFiles: 0,
  maxSearches: 0,
  maxFileBytes: 0,
  commentCooldownHours: 0,
  groomerToken: null,
  toolLoopEnabled: true,
  maxRounds: 1,
  maxSearchResults: 1,
  maxDirEntries: 1,
  exploration: { maxTotalBytes: 1, maxFileBytes: 1, timeoutMs: 1000, source: "medium" },
};

const OBSERVED_AT = "2026-09-26T00:00:00.000Z";

function relatedObservations(c: GroomingCase): RelatedWorkObservation[] {
  return (c.relatedWork ?? []).map((w) => ({ ...w, url: null, observedAt: OBSERVED_AT }));
}

function liveIssue(c: GroomingCase): GitHubIssue {
  return {
    number: c.issue.number,
    user: { login: "maintainer" },
    author_association: "OWNER",
    title: c.issue.title,
    body: c.issue.body,
    state: "open",
    html_url: `https://github.com/${c.repoFullName}/issues/${c.issue.number}`,
    labels: c.issue.labels.map((name) => ({ name, color: "" })),
    assignees: [],
    comments: c.comments?.length ?? 0,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-20T00:00:00Z",
    closed_at: null,
  };
}

/** Open tracked issues matching a Prisma `issue.findMany` dependency lookup. */
function openTrackedIssues(c: GroomingCase, args: unknown) {
  const numbers = (args as { where?: { number?: { in?: number[] } } })?.where?.number?.in ?? [];
  return (c.trackedIssues ?? [])
    .filter((t) => t.state === "open" && numbers.includes(t.number))
    .map((t) => ({ number: t.number, repository: { fullName: c.repoFullName } }));
}

/** Run one candidate through the real grooming path. Never touches the network. */
/** GroomingApplication rows (#1063); share one between runs to exercise replay. */
export type ApplicationRows = Map<string, Record<string, unknown> & { applicationKey: string }>;

/** GroomingChildClaim rows (#1066); share one between runs to exercise child-creation idempotency. */
export type ChildClaimRows = Map<string, Record<string, unknown> & { childKey: string }>;

export interface RunCandidateOptions {
  applications?: ApplicationRows;
  childClaims?: ChildClaimRows;
  /** Distinguishes GroomingRun ids when one case is run more than once. */
  runId?: string;
}

export async function runCandidate(
  c: GroomingCase,
  candidate: CaseCandidate,
  options: RunCandidateOptions = {},
): Promise<GroomingOutcome> {
  const writes: GitHubWrites = { labels: [], titleBody: [], comments: [], closes: 0, children: [] };
  let validation: GroomingPlanValidationResult | null = null;
  let catalog: EvidenceCatalog | null = null;
  let context = "";
  let issueData: Record<string, unknown> | null = null;
  const comments = c.comments ?? [];
  const read = c.repository.read ?? [];
  const surfaced = c.repository.surfaced ?? [];
  const related = relatedObservations(c);

  const selected: GroomingCandidate = {
    id: `issue-${c.issue.number}`,
    number: c.issue.number,
    title: c.issue.title,
    body: c.issue.body,
    url: `https://github.com/${c.repoFullName}/issues/${c.issue.number}`,
    repoFullName: c.repoFullName,
    labels: [...c.issue.labels],
    currentLane: c.issue.lane ?? null,
    groomingSummary: null,
    commentsCount: comments.length,
    selectionReason: "classification",
  };

  const exploration: ExploreResult = {
    findings: "",
    files: [],
    ask: null,
    sources: [...read, ...surfaced],
    readSources: [...read],
    readContents: read.flatMap((path) =>
      c.repository.contents?.[path] !== undefined
        ? [{ path, ref: c.repository.headSha, content: c.repository.contents[path] }]
        : [],
    ),
    toolCalls: [],
    bytes: 0,
    warnings: [],
    relatedWorkQueries: [],
    relatedWorkRefs: related.map((w) => w.key),
    relatedWork: related,
  };

  const applications: ApplicationRows = options.applications ?? new Map();
  const childClaims: ChildClaimRows = options.childClaims ?? new Map();
  const runId = options.runId ?? `run-${c.id}`;
  const prisma = {
    automationRepo: { findUnique: async () => ({ id: "repo-1", fullName: c.repoFullName, enabled: true }) },
    groomingRun: {
      create: async () => ({ id: runId, stage: "selected" }),
      update: async () => ({}),
      findFirst: async () => null,
    },
    issue: {
      update: async (args: { data: Record<string, unknown> }) => {
        issueData = { ...args.data };
        return { id: selected.id };
      },
      findMany: async (args: unknown) => openTrackedIssues(c, args),
    },
    issueLane: { create: async () => ({ id: "lane-1" }) },
    agentRun: { create: async () => ({ id: "agent-run-1" }) },
    auditLog: { create: async () => ({ id: "audit-1" }) },
    // Plan application claims (#1063), in memory for this run.
    groomingApplication: {
      findUnique: async ({ where }: { where: { applicationKey: string } }) => applications.get(where.applicationKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const key = String(data.applicationKey);
        // The unique applicationKey, as Postgres enforces it.
        if (applications.has(key)) throw Object.assign(new Error("Unique constraint failed on applicationKey"), { code: "P2002" });
        const row = { ...structuredClone(data), applicationKey: key, attempts: 1 };
        applications.set(key, row);
        return row;
      },
      update: async ({ where, data }: { where: { applicationKey: string }; data: Record<string, unknown> }) => {
        const row = applications.get(where.applicationKey)!;
        Object.assign(row, structuredClone(data));
        return row;
      },
      updateMany: async ({ where }: { where: { applicationKey: string; status?: string; attempts?: number } }) => {
        const row = applications.get(where.applicationKey);
        if (!row || (where.status !== undefined && row.status !== where.status)) return { count: 0 };
        if (where.attempts !== undefined && Number(row.attempts) !== where.attempts) return { count: 0 };
        row.attempts = Number(row.attempts) + 1;
        return { count: 1 };
      },
    },
    // Child-issue creation claims (#1066), in memory for this run.
    groomingChildClaim: {
      findUnique: async ({ where }: { where: { childKey: string } }) => childClaims.get(where.childKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const key = String(data.childKey);
        // The unique childKey, as Postgres enforces it.
        if (childClaims.has(key)) throw Object.assign(new Error("Unique constraint failed on childKey"), { code: "P2002" });
        // A created row has no childNumber/childUrl until the creation is
        // recorded; updatedAt is stamped at create, mirroring @updatedAt.
        const row = { ...structuredClone(data), childKey: key, childNumber: null, childUrl: null, updatedAt: new Date() };
        childClaims.set(key, row);
        return row;
      },
      update: async ({ where, data }: { where: { childKey: string }; data: Record<string, unknown> }) => {
        const row = childClaims.get(where.childKey)!;
        Object.assign(row, structuredClone(data));
        return row;
      },
    },
  };

  const deps: GroomerDeps = {
    selectCandidate: async () => selected,
    fetchComments: async () => comments.map((comment) => ({ ...comment })),
    buildContext: async (input) => {
      context = await buildIssueContext(input);
      return context;
    },
    callLLM: async (args) => {
      catalog = args.evidenceCatalog ?? null;
      if (args.repair && candidate.repair !== undefined) return candidate.repair as Record<string, unknown>;
      return candidate.output as Record<string, unknown>;
    },
    validateOutput: (raw, ctx) => {
      validation = validateGroomingPlan(raw, ctx);
      return validation;
    },
    getConfig: () => RUN_CONFIG,
    updateLabels: async (_repo, _n, labels) => {
      writes.labels.push([...labels]);
    },
    addComment: async (_repo, _n, body) => {
      writes.comments.push(body);
      return { url: `https://github.com/${c.repoFullName}/issues/${c.issue.number}#issuecomment-1` };
    },
    updateTitleAndBody: async (_repo, _n, fields) => {
      writes.titleBody.push({ ...fields });
    },
    closeIssue: async () => {
      writes.closes++;
    },
    createIssue: async (repoFullName, input) => {
      const number = 1000 + writes.children.length;
      const url = `https://github.com/${repoFullName}/issues/${number}`;
      writes.children.push({ number, url });
      return { number, html_url: url };
    },
    // The children step's umbrella: a separate additive write, not part of the
    // labels-step writes.labels.
    addLabel: async () => {},
    findActiveLeases: async () => [],
    upsertLease: async () => ({ created: true, lease: { id: "lease-1" } }),
    releaseLease: async () => ({ id: "lease-1" }),
    fetchCollaboratorPermission: async () => ({ status: "ok", permission: "write" }),
    prisma: prisma as unknown as GroomerDeps["prisma"],
    buildRepositoryContext: async () => ({ text: "", sources: [], warnings: [], bytes: 0, queries: [], emptyQueries: [] }),
    exploreRepository: async () => exploration,
    collectEvidence: (input) =>
      collectGroomingEvidenceSnapshot(input, {
        fetchIssue: async () => liveIssue(c),
        fetchRepositoryMetadata: async () => ({ defaultBranch: c.repository.defaultBranch ?? "main" }),
        fetchLatestCommit: async () => (c.repository.headSha ? { sha: c.repository.headSha } : null),
      }),
    acquireGroomerLock: async () => ({ locked: true, token: "corpus" }),
    heartbeatGroomerLock: async () => undefined,
    releaseGroomerLock: async () => undefined,
  };

  let result: Awaited<ReturnType<typeof runHostedGroomer>> = null;
  try {
    result = await runHostedGroomer({}, deps);
  } catch (err) {
    const v = validation as GroomingPlanValidationResult | null;
    if (!v || v.valid) throw err;
  }

  const v = validation as GroomingPlanValidationResult | null;
  const accepted = v?.valid === true;
  return {
    accepted,
    errors: v?.errors ?? [],
    plan: result?.plan,
    output: result?.output as GroomerOutput | undefined,
    catalog,
    context,
    labelsBefore: [...c.issue.labels],
    labelsAfter: writes.labels.at(-1) ?? [...c.issue.labels],
    writes,
    issueData,
    mutationPlan: result?.mutationPlan,
  };
}

// ─── Freshness probes ─────────────────────────────────────────────────────────

const BASELINE_COLUMNS = [
  "groomedRunId",
  "groomedHeadSha",
  "groomedDefaultBranch",
  "groomedIssueFingerprint",
  "groomedCommentCount",
  "groomedEvidenceCapturedAt",
  "groomedEvidenceScope",
  "groomedEvidencePaths",
  "groomedDependencyKeys",
  "groomedOpenBlockerKeys",
  "groomedRelatedWork",
  "groomingVerifiedSha",
] as const;

/**
 * Apply one event after an applied groom and run the real freshness pass
 * against the baseline that groom recorded. Returns the stale reasons
 * (empty when the result stays fresh).
 */
export async function runFreshnessProbe(
  c: GroomingCase,
  outcome: GroomingOutcome,
  probe: FreshnessProbe,
): Promise<{ stale: GroomingStaleReason[]; warnings: string[] }> {
  if (!outcome.issueData || !outcome.issueData.groomedIssueFingerprint) {
    throw new Error(`candidate "${probe.from}" recorded no freshness baseline`);
  }
  const data = outcome.issueData;
  const applied = outcome.writes.titleBody.at(-1) ?? {};
  const row = {
    id: `issue-${c.issue.number}`,
    number: c.issue.number,
    title: applied.title ?? c.issue.title,
    body: applied.body ?? c.issue.body,
    state: "open",
    labels: [...outcome.labelsAfter],
    commentsCount: c.comments?.length ?? 0,
    ...Object.fromEntries(BASELINE_COLUMNS.map((column) => [column, data[column] ?? null])),
  } as FreshnessIssueRow;
  row.groomedEvidencePaths ??= [];
  row.groomedDependencyKeys ??= [];
  row.groomedOpenBlockerKeys ??= [];

  const headSha = c.repository.headSha;
  let head = headSha;
  let comparison: CommitComparison = { ok: true, status: "identical", files: [], truncated: false };
  const tracked = new Map((c.trackedIssues ?? []).map((t) => [t.number, t.state]));
  const relatedStates = new Map((c.relatedWork ?? []).map((w) => [w.key, w.state]));
  let recentComments: Array<{ author: string; createdAt: string }> = [];

  const { event } = probe;
  switch (event.kind) {
    case "none":
      break;
    case "issue_edit":
      if (event.title !== undefined) row.title = event.title;
      if (event.body !== undefined) row.body = event.body;
      row.labels = [...row.labels.filter((l) => !(event.removeLabels ?? []).includes(l)), ...(event.addLabels ?? [])];
      break;
    case "comment": {
      const captured = (row.groomedEvidenceCapturedAt as Date | null)?.getTime() ?? Date.now();
      row.commentsCount += 1;
      recentComments = [{ author: event.author, createdAt: new Date(captured + 60_000).toISOString() }];
      break;
    }
    case "commit":
      head = `${headSha ?? "unpinned"}-next`;
      comparison = { ok: true, status: "ahead", files: event.files, truncated: false };
      break;
    case "dependency_state":
      tracked.set(event.number, event.state);
      break;
    case "related_state":
      relatedStates.set(event.key, event.state);
      break;
  }

  const stale = new Map<string, GroomingStaleReason[]>();
  const store: FreshnessStore = {
    findFreshIssues: async () => [row],
    findOpenIssueKeys: async (numbers) =>
      new Set(numbers.filter((n) => tracked.get(n) === "open").map((n) => dependencyKey(c.repoFullName, n))),
    findCachedIssueStates: async () => new Map(),
    markStale: async (issue, mark) => {
      stale.set(issue.id, [...mark.reasons]);
      return true;
    },
    advance: async () => undefined,
    recordAudit: async () => undefined,
  };
  const stateOf = (kind: "issue" | "pr", repo: string, number: number) =>
    relatedStates.get(`github:${kind}:${repo}#${number}`) ?? null;
  const github: FreshnessGitHub = {
    fetchHeadSha: async () => head,
    compareCommits: async () => comparison,
    fetchRecentComments: async () => recentComments,
    fetchIssueState: async (repo, number) => stateOf("issue", repo, number) as "open" | "closed" | null,
    fetchPullRequestState: async (repo, number) => stateOf("pr", repo, number),
  };

  const result = await runGroomingFreshnessPass(
    [{ id: "repo-1", fullName: c.repoFullName }],
    store,
    github,
    DEFAULT_FRESHNESS_BUDGET,
    () => new Date(),
  );
  return { stale: stale.get(row.id) ?? [], warnings: result.warnings };
}
