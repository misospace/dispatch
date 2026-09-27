import { prisma } from "@/lib/prisma";
import { addIssueComment, closeIssue, updateIssueLabels, updateIssueTitleAndBody } from "@/lib/github";
import { findActiveLeasesForIssue, releaseLease, upsertLease } from "@/lib/lease";
import { acquireGroomerLock, heartbeatGroomerLock, HEARTBEAT_MS, releaseGroomerLock } from "./groomer-lock";
import { selectGroomingCandidate } from "./selector";
import { buildIssueContext, fetchIssueComments } from "./context";
import { callGroomerLLM } from "./llm";
import { inFlightStatus, validateGroomingPlan, type GroomingPlan } from "./plan";
import { buildEvidenceCatalog } from "./plan-evidence";
import { getHostedGroomerConfig } from "./config";
import { buildRepositoryContext } from "./repository-context";
import { exploreRepository } from "./explore";
import {
  addEvidenceSources,
  addRelatedWorkEvidence,
  collectGroomingEvidenceSnapshot,
  summarizeEvidenceForPersistence,
  type GroomingEvidenceSnapshot,
} from "./evidence-snapshot";
import type { RepositoryContextInput, RepositoryContextConfig } from "./repository-context";
import { createGroomingRunRecord, completeGroomingRunRecord, updateGroomingRunRecord } from "./history";
import { freshnessBaselineIssueData } from "./freshness-invalidation";
import { compareCommits } from "@/lib/github-code-search";
import { validateApplyPreconditions, type LiveComment, type PreconditionReader } from "./mutation-validator";
import {
  applyGroomingMutations,
  computeApplicationKey,
  computeMutationDiff,
  makePrismaApplicationStore,
  type ApplicationStore,
  type ApplierGitHub,
  type ApplyResult,
} from "./mutation-applier";

export interface GroomerRunResult {
  candidateNumber: number;
  repoFullName: string;
  dryRun: boolean;
  output: any;
  /** The validated GroomingPlan; `output` is its legacy GroomerOutput view. */
  plan?: GroomingPlan;
  plannedLabels: string[];
  groomingRunId?: string;
  contextWarnings?: string[];
  mutationPlan?: Record<string, unknown>;
  appliedMutations?: Record<string, unknown>;
}

export interface RunHostedGroomerOptions {
  dryRun?: boolean;
  repoFullName?: string;
  issueNumber?: number;
  force?: boolean;
}

const GROOMER_LEASE_TTL_MS = 10 * 60 * 1000;

export interface GroomerDeps {
  selectCandidate: typeof selectGroomingCandidate;
  fetchComments: typeof fetchIssueComments;
  buildContext: typeof buildIssueContext;
  callLLM: typeof callGroomerLLM;
  validateOutput: typeof validateGroomingPlan;
  getConfig: typeof getHostedGroomerConfig;
  updateLabels: typeof updateIssueLabels;
  addComment: typeof addIssueComment;
  updateTitleAndBody: typeof updateIssueTitleAndBody;
  closeIssue: typeof closeIssue;
  findActiveLeases: typeof findActiveLeasesForIssue;
  upsertLease: typeof upsertLease;
  releaseLease: typeof releaseLease;
  prisma: typeof prisma;
  buildRepositoryContext: typeof buildRepositoryContext;
  exploreRepository: typeof exploreRepository;
  collectEvidence: typeof collectGroomingEvidenceSnapshot;
  acquireGroomerLock: typeof acquireGroomerLock;
  heartbeatGroomerLock: typeof heartbeatGroomerLock;
  releaseGroomerLock: typeof releaseGroomerLock;
  /** Apply-time head comparison (#1063); defaults to the GitHub compare API. */
  compareCommits?: typeof compareCommits;
  /** Plan application claims (#1063); defaults to GroomingApplication via `prisma`. */
  applicationStore?: ApplicationStore;
}

const defaultDeps: GroomerDeps = {
  selectCandidate: selectGroomingCandidate,
  fetchComments: fetchIssueComments,
  buildContext: buildIssueContext,
  callLLM: callGroomerLLM,
  validateOutput: validateGroomingPlan,
  getConfig: getHostedGroomerConfig,
  updateLabels: updateIssueLabels,
  addComment: addIssueComment,
  updateTitleAndBody: updateIssueTitleAndBody,
  closeIssue,
  findActiveLeases: findActiveLeasesForIssue,
  upsertLease,
  releaseLease,
  prisma,
  buildRepositoryContext,
  exploreRepository,
  collectEvidence: collectGroomingEvidenceSnapshot,
  acquireGroomerLock,
  heartbeatGroomerLock,
  releaseGroomerLock,
  compareCommits,
};

export async function runHostedGroomer(
  options: RunHostedGroomerOptions = {},
  deps: GroomerDeps = defaultDeps,
): Promise<GroomerRunResult | null> {
  // Serialize runs behind a DB lock: without it, two concurrent groomer runs
  // can select the same candidate before either acquires the per-issue lease
  // (selection and lease acquisition are not atomic), double-grooming the issue.
  const lock = await deps.acquireGroomerLock();
  if (!lock.locked) return null;
  // Heartbeat the lock for the duration of the run. The lock's TTL is a small
  // multiple of the heartbeat interval (see groomer-lock.ts), so a live holder
  // keeps its lock fresh while a holder SIGKILL'd mid-run (rollout, eviction,
  // OOM) stops refreshing and its orphaned lock is reclaimable in ~90s
  // instead of 30 minutes (dispatch#967). A failed heartbeat must never fail
  // the run — the worst case is the old behaviour (stall until TTL).
  const heartbeat = setInterval(() => {
    deps.heartbeatGroomerLock(lock.token).catch(() => {
      /* best-effort; a lost heartbeat just means an earlier reclaim */
    });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await executeGroomerRun(options, deps);
  } finally {
    clearInterval(heartbeat);
    await deps.releaseGroomerLock(lock.token);
  }
}

async function executeGroomerRun(
  options: RunHostedGroomerOptions = {},
  deps: GroomerDeps = defaultDeps,
): Promise<GroomerRunResult | null> {
  const config = deps.getConfig();
  const dryRun = options.dryRun ?? config.dryRun;

  // Select candidate
  const candidate = await deps.selectCandidate({
    repoFullName: options.repoFullName,
    issueNumber: options.issueNumber,
    freshnessBackfill: true,
  });
  if (!candidate) return null;

  // Resolve AutomationRepo by fullName
  const automationRepo = await deps.prisma.automationRepo.findUnique({
    where: { fullName: candidate.repoFullName },
  });
  if (!automationRepo) {
    throw new Error(`Automation repository not found for ${candidate.repoFullName}`);
  }

  // Create GroomingRun record (before lease, after candidate selection)
  const groomingRun = await createGroomingRunRecord(deps.prisma, {
    issueId: candidate.id,
    repoId: automationRepo.id,
    repoFullName: candidate.repoFullName,
    issueNumber: candidate.number,
    issueUrl: candidate.url,
    dryRun,
    labelsBefore: candidate.labels,
    laneBefore: candidate.currentLane,
    model: config.model ?? null,
    provider: config.llmBaseUrl ? new URL(config.llmBaseUrl).host : null,
    timeoutMs: config.timeoutMs ?? null,
    maxContextBytes: config.maxContextBytes ?? null,
    candidateSource: candidateSourceOf(candidate),
    staleReasons: candidate.staleReasons,
  });

  const activeLeases = await deps.findActiveLeases(candidate.id);
  const hasOtherLease = activeLeases.some((lease: { agentName?: string }) => lease.agentName !== "hosted-groomer");
  if (hasOtherLease && !options.force) return null;

  const { lease } = await deps.upsertLease({
    agentName: "hosted-groomer",
    issueId: candidate.id,
    checkpoint: "issue_claimed",
    ttlMs: GROOMER_LEASE_TTL_MS,
  });

  // Freshness (#1064): a human comment after this instant is new evidence.
  const evidenceWindowStart = new Date();

  try {
    let comments: Awaited<ReturnType<typeof fetchIssueComments>> = [];
    try {
      comments = await deps.fetchComments(candidate.repoFullName, candidate.number);
    } catch {
      comments = [];
    }

    // Capture the evidence snapshot BEFORE model analysis: the pinned
    // default-branch head SHA plus the live issue/comment state that every
    // repository read in this run is pinned to. Never fatal — the collector
    // is contractually non-throwing, but a broken injected dep must not fail
    // the groom; it degrades to an unpinned shell and the run continues.
    let evidence: GroomingEvidenceSnapshot;
    try {
      evidence = await deps.collectEvidence({
        repoFullName: candidate.repoFullName,
        issueNumber: candidate.number,
        comments,
      });
    } catch (err) {
      // Defensive: a broken injected dep must not fail the groom. Fall back
      // to an unpinned shell (headSha/pinnedRef null, no sources) — the shell
      // means we lost the live capture.
      console.warn(
        `[groomer] evidence snapshot collection failed for ${candidate.repoFullName}#${candidate.number}; continuing unpinned:`,
        err,
      );
      evidence = {
        capturedAt: new Date().toISOString(),
        repoFullName: candidate.repoFullName,
        defaultBranch: null,
        headSha: null,
        pinnedRef: null,
        issue: {
          number: candidate.number,
          title: "",
          body: null,
          labels: [],
          state: "unknown",
          updatedAt: "",
          url: "",
        },
        issueFingerprint: "",
        comments: [],
        evidenceDigest: "",
        warnings: ["evidence: snapshot collection failed"],
        sources: [],
      };
    }

    // The issue the model analyzes is the one the snapshot pinned (#1063):
    // the apply-time preconditions compare live state against the snapshot,
    // so the prompt must be built from the same state, not Dispatch's cache.
    // Falls back to the cached issue only when the live capture failed (and
    // then the preconditions refuse to apply the plan).
    const liveCaptured = evidence.issue.state !== "unknown";
    const analyzed = liveCaptured
      ? { title: evidence.issue.title, body: evidence.issue.body, labels: evidence.issue.labels, state: evidence.issue.state }
      : { title: candidate.title, body: candidate.body, labels: candidate.labels, state: "open" };

    // Build repository context
    const repositoryContext = await deps.buildRepositoryContext(
      {
        repoFullName: candidate.repoFullName,
        issueTitle: analyzed.title,
        issueBody: analyzed.body,
        ref: evidence.pinnedRef ?? undefined,
      },
      {
        enabled: config.repoContextEnabled,
        maxSearches: config.maxSearches,
        maxFiles: config.maxContextFiles,
        maxFileBytes: config.maxFileBytes,
        maxTotalBytes: Math.max(0, Math.floor(config.maxContextBytes * 0.4)),
      },
    );

    // Persist stage context_built with warnings and summary. Repository
    // evidence sources are folded into the snapshot before it is persisted so
    // the summary's sources reflect what this run actually read.
    const contextWarnings = repositoryContext.warnings;
    evidence = addEvidenceSources(evidence, repositoryContext.sources);
    await updateGroomingRunRecord(deps.prisma, groomingRun.id, {
      stage: "context_built",
      contextWarnings,
      contextSummary: {
        commentCount: comments.length,
        repositorySources: repositoryContext.sources,
        repositoryQueries: repositoryContext.queries,
        repositoryBytes: repositoryContext.bytes,
        evidence: summarizeEvidenceForPersistence(evidence),
      },
    });

    // Build context
    const context = await deps.buildContext({
      number: candidate.number,
      title: analyzed.title,
      body: analyzed.body,
      labels: analyzed.labels,
      currentLane: candidate.currentLane,
      comments,
      maxContextBytes: config.maxContextBytes,
      repositoryContext,
    });

    // Let the groomer drive its own look at the repository. This is where it
    // finds the files the issue is actually about; the issue itself is usually
    // written by someone who does not know the codebase. Never fatal — a failed
    // exploration degrades grooming, it does not fail the run.
    const exploration = config.toolLoopEnabled
      ? await deps.exploreRepository({
          baseUrl: config.llmBaseUrl!,
          apiKey: config.apiKey!,
          model: config.model,
          repoFullName: candidate.repoFullName,
          prompt: context,
          timeoutMs: config.exploration.timeoutMs,
          maxRounds: config.maxRounds,
          maxTotalBytes: config.exploration.maxTotalBytes,
          maxSearchResults: config.maxSearchResults,
          maxFileBytes: config.exploration.maxFileBytes,
          maxDirEntries: config.maxDirEntries,
          pinnedRef: evidence.headSha ?? undefined,
        })
      : null;

    if (exploration) {
      // Fold exploration sources into the snapshot, then persist so a bad
      // grooming run can be read back afterwards. Before this, the only
      // evidence of what the groomer saw was whatever comment it happened to
      // leave on the issue. Related-work refs are GitHub state, not repository
      // content, so they enter as their own unpinned provenance.
      // Only read_file results were read at the pinned SHA; search hits and
      // submitted findings enter as surfaced (unpinned) repository evidence.
      evidence = addEvidenceSources(evidence, exploration.readSources ?? []);
      evidence = addEvidenceSources(evidence, exploration.sources, "surfaced");
      evidence = addRelatedWorkEvidence(evidence, exploration.relatedWork);
      await updateGroomingRunRecord(deps.prisma, groomingRun.id, {
        stage: "explored",
        contextWarnings: [...contextWarnings, ...exploration.warnings],
        contextSummary: {
          commentCount: comments.length,
          repositorySources: repositoryContext.sources,
          repositoryQueries: repositoryContext.queries,
          repositoryBytes: repositoryContext.bytes,
          relatedWorkQueries: exploration.relatedWorkQueries,
          relatedWorkRefs: exploration.relatedWorkRefs,
          evidence: summarizeEvidenceForPersistence(evidence),
          exploration: {
            budget: config.exploration,
            files: exploration.files,
            ask: exploration.ask,
            sources: exploration.sources,
            bytes: exploration.bytes,
            toolCalls: exploration.toolCalls,
          },
        },
      });
    }

    // The citable view of the snapshot: rendered into the prompt, used to
    // enum-constrain evidence ids, and the set the plan is validated against.
    const evidenceCatalog = buildEvidenceCatalog(evidence);

    // Call LLM
    const rawOutput = await deps.callLLM({
      baseUrl: config.llmBaseUrl!,
      apiKey: config.apiKey!,
      model: config.model,
      responseFormat: config.responseFormat,
      prompt: context,
      timeoutMs: config.timeoutMs,
      explorationFindings: exploration?.findings,
      evidenceCatalog,
    });

    // Validate the GroomingPlan against this run's evidence (dispatch#1062).
    // A rejected plan applies no mutation; its output and deterministic
    // errors are kept on the run so the rejection can be inspected.
    const validation = deps.validateOutput(rawOutput, { catalog: evidenceCatalog });
    if (!validation.valid) {
      await updateGroomingRunRecord(deps.prisma, groomingRun.id, {
        rawOutput,
        validationErrors: validation.errors ?? [],
      }).catch(() => {
        /* the validation failure below is the error that matters */
      });
      throw new Error(`Groomer output validation failed: ${validation.errors?.join(", ")}`);
    }

    const plan = validation.plan!;

    // Record structured alias-resolution warnings for observability
    if (validation.resolutions && validation.resolutions.length > 0) {
      for (const r of validation.resolutions) {
        contextWarnings.push(`enum:${r.field}: resolved '${r.rawValue}' -> '${r.resolvedValue}' via ${r.source}`);
      }
    }

    // The diff this plan would write, computed against the issue the model
    // analyzed (the snapshot's live state). The apply-time preconditions
    // below guarantee live state still equals it before anything is written,
    // so this is also the diff from current state. The close and ready
    // policies are applied here: a close or ready promotion they reject is
    // withheld and the plan lands as backlog (dispatch#1063).
    const diff = computeMutationDiff({ plan, live: analyzed, catalog: evidenceCatalog });
    // Legacy GroomerOutput view of what is applied: the mutation path below
    // and existing run/history consumers read this shape.
    const output = diff.output;
    const applicationKey = computeApplicationKey({
      repoFullName: candidate.repoFullName,
      issueNumber: candidate.number,
      plan,
      diff,
    });

    // mark_not_ready degrades instead of failing the run (dispatch#839). The
    // model is not obliged to emit notReadyReason, so a routine omission must
    // not 500 the whole run. Fallback order, best to worst:
    //  1. the model's notReadyReason (normal case),
    //  2. this run's own summary — it is about to be written to
    //     groomingSummary anyway and already reads like a not-ready reason.
    //     This is the common case for a first-time groom, where the issue has
    //     no prior summary; without it the action would persist with no
    //     reason, buildGroomingStateExclusionWhere would not engage, and the
    //     24h cooldown would be the only guard again (the re-groom treadmill
    //     #831 removed),
    //  3. the issue's existing groomingSummary,
    //  4. nothing — persist the action without a reason.
    let notReadyReason = output.notReadyReason?.trim() || undefined;
    if (output.nextGroomingAction === "mark_not_ready") {
      if (!notReadyReason && output.summary?.trim()) {
        notReadyReason = output.summary.trim();
        console.warn(
          `[groomer] ${candidate.repoFullName}#${candidate.number}: mark_not_ready omitted notReadyReason; used this run's summary: ${notReadyReason}`,
        );
      } else if (!notReadyReason && candidate.groomingSummary?.trim()) {
        notReadyReason = candidate.groomingSummary.trim();
        console.warn(
          `[groomer] ${candidate.repoFullName}#${candidate.number}: mark_not_ready omitted notReadyReason; fell back to existing groomingSummary: ${notReadyReason}`,
        );
      } else if (!notReadyReason) {
        console.warn(
          `[groomer] ${candidate.repoFullName}#${candidate.number}: mark_not_ready omitted notReadyReason and has no summary to fall back on; persisting the action without a reason`,
        );
      }
    }

    for (const [what, reasons] of Object.entries(diff.withheld)) {
      contextWarnings.push(`apply: withheld ${what === "close" ? "the already_done close" : "the ready promotion"}: ${reasons!.join("; ")}`);
    }

    // Post-condition invariant (dispatch#941): exactly one status/* label.
    // computeMutationDiff enforces it on the final label set.
    let newLabels = diff.labelsAfter;

    // Build mutationPlan
    const mutationPlan: Record<string, unknown> = {
      labelsToAdd: output.labelsToAdd,
      labelsToRemove: output.labelsToRemove,
      lane: output.lane,
      summary: output.summary ?? null,
      notReadyReason: notReadyReason ?? null,
      willComment: diff.comment !== null,
      willCloseIssue: diff.close,
      titleRewritten: diff.title !== null,
      originalTitle: diff.title !== null ? analyzed.title : undefined,
      proposedTitle: diff.title ?? undefined,
      bodyEnriched: diff.body !== null,
      proposedBody: diff.body !== null ? output.proposedBody : undefined,
      ...(output.proposedBody !== undefined && diff.body === null ? { bodySkippedReason: diff.bodySkippedReason } : {}),
      planSchemaVersion: plan.schemaVersion,
      evidenceDigest: plan.evidence.evidenceDigest,
      readiness: plan.readiness,
      closeRecommendation: plan.mutations.close,
      applicationKey,
      ...(Object.keys(diff.withheld).length > 0 ? { withheld: diff.withheld } : {}),
    };

    // An issue already claimed or under review (status/in-progress or
    // status/in-review) is not the groomer's to move. The plan is recorded,
    // but no label, lane, title/body, comment or close mutation is applied.
    // Checked on both Dispatch's cache and the live snapshot, so a claim the
    // cache has not synced yet is still respected.
    const inFlight = inFlightStatus(candidate.labels) ?? inFlightStatus(analyzed.labels);
    if (inFlight) {
      newLabels = [...candidate.labels];
      Object.assign(mutationPlan, {
        skippedReason: "in_flight_status",
        inFlightStatus: inFlight,
        willComment: false,
        willCloseIssue: false,
        titleRewritten: false,
        bodyEnriched: false,
      });
      delete mutationPlan.applicationKey;
    }

    // Persist stage planned
    await updateGroomingRunRecord(deps.prisma, groomingRun.id, {
      stage: "planned",
      rawOutput,
      validatedOutput: plan,
      labelsToAdd: inFlight ? [] : output.labelsToAdd,
      labelsToRemove: inFlight ? [] : output.labelsToRemove,
      labelsAfter: newLabels,
      laneAfter: inFlight ? candidate.currentLane : output.lane.id,
      mutationPlan,
      commentBodyPreview: inFlight ? null : (diff.comment?.slice(0, 500) ?? null),
    });

    const result = (extra: Partial<GroomerRunResult>): GroomerRunResult => ({
      candidateNumber: candidate.number,
      repoFullName: candidate.repoFullName,
      dryRun,
      output,
      plan,
      plannedLabels: newLabels,
      groomingRunId: groomingRun.id,
      contextWarnings,
      mutationPlan,
      ...extra,
    });

    if (inFlight && dryRun) {
      await completeGroomingRunRecord(deps.prisma, groomingRun.id, {
        status: "dry_run_completed",
        stage: "planned",
      });
      return result({});
    }

    if (inFlight) {
      // Only the Dispatch-local groomedAt stamp is written, so the 24h
      // re-groom cooldown still applies and an eligible in-flight issue is
      // not re-selected (and re-billed) every scheduler tick.
      const skipped: Record<string, unknown> = { skipped: "in_flight_status", inFlightStatus: inFlight };
      await deps.prisma.issue.update({
        where: { id: candidate.id },
        data: { groomedAt: new Date(), groomedBy: "hosted-groomer" },
      });
      const skippedRun = await deps.prisma.agentRun.create({
        data: {
          agentName: "hosted-groomer",
          runType: "groom",
          status: "completed",
          startedAt: new Date(),
          finishedAt: new Date(),
          summary: `No mutations applied: issue is ${inFlight}`,
          issueId: candidate.id,
          touchedIssueUrls: [candidate.url],
        },
      });
      await deps.prisma.auditLog.create({
        data: {
          actor: "hosted-groomer",
          action: "groom",
          repoFullName: candidate.repoFullName,
          issueNumber: candidate.number,
          beforeLabels: candidate.labels,
          afterLabels: candidate.labels,
          success: true,
        },
      });
      await completeGroomingRunRecord(deps.prisma, groomingRun.id, {
        status: "completed",
        stage: "skipped",
        appliedMutations: skipped,
        agentRunId: skippedRun.id,
      });
      return result({ appliedMutations: skipped });
    }

    // Precondition validation (dispatch#1063): immediately before the first
    // write, re-read the live issue, recent comments and the default-branch
    // head, and check the evidence this plan was built on still holds. Dry
    // runs run the same read-only checks.
    const reader: PreconditionReader = {
      recapture: () =>
        deps.collectEvidence({ repoFullName: candidate.repoFullName, issueNumber: candidate.number, comments }),
      fetchRecentComments: async (max) =>
        (await deps.fetchComments(candidate.repoFullName, candidate.number, max, "desc")).map(
          (comment): LiveComment => ({
            id: comment.id ?? null,
            author: comment.author,
            createdAt: comment.createdAt,
            body: comment.body,
            url: comment.url ?? null,
          }),
        ),
      compareCommits: (base, head) => (deps.compareCommits ?? compareCommits)(candidate.repoFullName, base, head),
    };
    const preconditions = await validateApplyPreconditions(
      {
        repoFullName: candidate.repoFullName,
        issueNumber: candidate.number,
        evidence,
        evidenceWindowStart,
        plan,
        repositoryQueries: repositoryContext.queries,
        explorationRan: exploration !== null,
        explorationToolCalls: exploration?.toolCalls ?? [],
      },
      reader,
    );
    const preconditionRecord = { ok: preconditions.ok, checks: preconditions.checks };
    mutationPlan.preconditions = preconditionRecord;
    const store = deps.applicationStore ?? makePrismaApplicationStore(deps.prisma);
    const validationFields = {
      applicationKey,
      preconditions: preconditionRecord,
      preconditionFailures: preconditions.failures,
      mutationPlan,
    };

    if (dryRun) {
      const existing = preconditions.ok ? await store.find(applicationKey) : null;
      const applyOutcome = !preconditions.ok ? "stale" : existing?.status === "applied" ? "would_replay" : "dry_run";
      mutationPlan.applyOutcome = applyOutcome;
      await completeGroomingRunRecord(deps.prisma, groomingRun.id, {
        status: "dry_run_completed",
        stage: "planned",
        ...validationFields,
        applyOutcome,
      });
      return result({ dryRun: true });
    }

    if (!preconditions.ok) {
      // Stale or unverifiable evidence: apply zero grooming mutations. The
      // issue's grooming fields are left untouched, so it stays exactly as
      // eligible for a fresh groom as it was when this run selected it.
      const stale: Record<string, unknown> = { outcome: "stale", preconditionFailures: preconditions.failures };
      const failed = preconditions.checks.filter((c) => c.status === "changed" || c.status === "unverifiable");
      const staleRun = await deps.prisma.agentRun.create({
        data: {
          agentName: "hosted-groomer",
          runType: "groom",
          status: "completed",
          startedAt: new Date(),
          finishedAt: new Date(),
          summary: `No mutations applied: preconditions failed (${failed.map((c) => c.name).join(", ")})`,
          issueId: candidate.id,
          touchedIssueUrls: [candidate.url],
        },
      });
      await deps.prisma.auditLog.create({
        data: {
          actor: "hosted-groomer",
          action: "groom",
          repoFullName: candidate.repoFullName,
          issueNumber: candidate.number,
          beforeLabels: candidate.labels,
          afterLabels: candidate.labels,
          success: true,
          notes: JSON.stringify({ outcome: "stale", preconditionFailures: preconditions.failures }),
        },
      });
      await completeGroomingRunRecord(deps.prisma, groomingRun.id, {
        status: "stale",
        stage: "validated",
        ...validationFields,
        applyOutcome: "stale",
        appliedMutations: stale,
        errorMessage: `Apply preconditions failed: ${preconditions.failures.join("; ")}`,
        retryable: true,
        agentRunId: staleRun.id,
      });
      return result({ appliedMutations: stale });
    }

    // Write mode: apply the diff idempotently, lowest impact first.
    const github: ApplierGitHub = {
      updateLabels: deps.updateLabels,
      addComment: deps.addComment,
      updateTitleAndBody: deps.updateTitleAndBody,
      closeIssue: deps.closeIssue,
      fetchRecentComments: (_repo, _number, max) => reader.fetchRecentComments(max),
    };
    const applied = await applyGroomingMutations(
      {
        repoFullName: candidate.repoFullName,
        issueNumber: candidate.number,
        issueId: candidate.id,
        groomingRunId: groomingRun.id,
        applicationKey,
        diff,
        recentComments: preconditions.recentComments,
        force: options.force === true,
        commentCooldownHours: config.commentCooldownHours,
      },
      github,
      store,
    );
    const appliedMutations = describeApplication(applied, diff.withheld);

    if (applied.outcome === "failed") {
      // The first needed write failed and nothing landed: fail the run
      // (retryable) with the step results kept on it.
      await updateGroomingRunRecord(deps.prisma, groomingRun.id, {
        ...validationFields,
        applyOutcome: "failed",
        appliedMutations,
      }).catch(() => {
        /* the failure below is the error that matters */
      });
      throw new Error(`Grooming mutation failed at ${applied.failure!.step}: ${applied.failure!.error}`);
    }

    if (applied.outcome === "busy") {
      // Another attempt claimed this exact application moments ago and has
      // not finished. Nothing is written, not even the cooldown stamp, so the
      // issue is retried once that claim completes or ages out.
      const busy: Record<string, unknown> = { outcome: "busy", claimedByRunId: applied.claimedByRunId };
      const busyRun = await deps.prisma.agentRun.create({
        data: {
          agentName: "hosted-groomer",
          runType: "groom",
          status: "completed",
          startedAt: new Date(),
          finishedAt: new Date(),
          summary: "No mutations applied: this plan application is in progress in another run",
          issueId: candidate.id,
          touchedIssueUrls: [candidate.url],
        },
      });
      await completeGroomingRunRecord(deps.prisma, groomingRun.id, {
        status: "completed",
        stage: "skipped",
        ...validationFields,
        applyOutcome: "busy",
        appliedMutations: busy,
        retryable: true,
        agentRunId: busyRun.id,
      });
      return result({ appliedMutations: busy });
    }

    if (applied.outcome === "replayed") {
      // This exact application already landed: nothing is written again,
      // not even lane history. Only the local cooldown stamp moves, so the
      // same plan is not re-billed every scheduler tick.
      await deps.prisma.issue.update({
        where: { id: candidate.id },
        data: { groomedAt: new Date(), groomedBy: "hosted-groomer" },
      });
      const replayRun = await deps.prisma.agentRun.create({
        data: {
          agentName: "hosted-groomer",
          runType: "groom",
          status: "completed",
          startedAt: new Date(),
          finishedAt: new Date(),
          summary: `No mutations applied: plan application already applied${applied.claimedByRunId ? ` by run ${applied.claimedByRunId}` : ""}`,
          issueId: candidate.id,
          touchedIssueUrls: [candidate.url],
        },
      });
      await deps.prisma.auditLog.create({
        data: {
          actor: "hosted-groomer",
          action: "groom",
          repoFullName: candidate.repoFullName,
          issueNumber: candidate.number,
          beforeLabels: analyzed.labels,
          afterLabels: analyzed.labels,
          success: true,
          notes: JSON.stringify({ outcome: "replayed", applicationKey }),
        },
      });
      await completeGroomingRunRecord(deps.prisma, groomingRun.id, {
        status: "completed",
        stage: "applied",
        ...validationFields,
        applyOutcome: "replayed",
        appliedMutations,
        agentRunId: replayRun.id,
        commentUrl: applied.commentUrl,
      });
      return result({ appliedMutations });
    }

    newLabels = applied.labels;

    // Update issue grooming fields
    const issueData: Record<string, unknown> = {
      groomedAt: new Date(),
      groomedBy: "hosted-groomer",
      currentLane: output.lane.id,
    };
    if (output.summary) issueData.groomingSummary = output.summary;
    if (output.needsInfoReason) issueData.needsInfoReason = output.needsInfoReason;
    if (output.blockedReason) issueData.blockedReason = output.blockedReason;
    if (notReadyReason) issueData.notReadyReason = notReadyReason;
    if (output.nextGroomingAction) issueData.nextGroomingAction = output.nextGroomingAction;
    // When the groomer closes the issue, mirror the closed state locally so
    // the selector stops considering it (state: "open" is the implicit filter)
    // and the next sync confirms what we just wrote. A close that did not
    // land leaves the issue open locally too, so it can be retried.
    if (applied.closed) {
      issueData.state = "closed";
      issueData.closedAt = new Date();
    }

    // Freshness baseline (#1064): the evidence this applied result was
    // validated against, including the post-apply state Dispatch actually
    // wrote (a partial application records only what landed), so the
    // groomer's own writes never read back as an external change.
    Object.assign(
      issueData,
      await freshnessBaselineIssueData(deps.prisma, {
        groomingRunId: groomingRun.id,
        repoFullName: candidate.repoFullName,
        issueNumber: candidate.number,
        evidence,
        candidate,
        appliedTitle: applied.title ?? undefined,
        appliedBody: applied.body ?? undefined,
        labelsAfter: applied.labels,
        closed: applied.closed,
        evidenceWindowStart,
        repositoryQueries: repositoryContext.queries,
        explorationRan: exploration !== null,
        explorationToolCalls: exploration?.toolCalls ?? [],
        citations: plan.citations,
      }),
    );
    // The preconditions just verified the evidence against the live head.
    const head = preconditions.checks.find((c) => c.name === "head");
    if (issueData.groomedIssueFingerprint && head?.status === "passed" && preconditions.liveHeadSha) {
      issueData.groomingVerifiedSha = preconditions.liveHeadSha;
    }

    await deps.prisma.issue.update({
      where: { id: candidate.id },
      data: issueData,
    });

    // Create IssueLane history row
    await deps.prisma.issueLane.create({
      data: {
        issueId: candidate.id,
        lane: output.lane.id,
        confidence: output.lane.confidence,
        reason: output.lane.reason,
        model: config.model,
      },
    });

    const partial = applied.outcome === "partial";
    const partialMessage = partial
      ? `Grooming partially applied: ${applied.failure!.step} failed (${applied.failure!.error}); later steps were not attempted`
      : null;

    // Create AgentRun row
    const agentRun = await deps.prisma.agentRun.create({
      data: {
        agentName: "hosted-groomer",
        runType: "groom",
        status: "completed",
        startedAt: new Date(),
        finishedAt: new Date(),
        summary: output.summary ?? null,
        ...(partialMessage ? { errorMessage: partialMessage } : {}),
        issueId: candidate.id,
        touchedIssueUrls: [candidate.url],
      },
    });

    // Create AuditLog entry
    await deps.prisma.auditLog.create({
      data: {
        actor: "hosted-groomer",
        action: "groom",
        repoFullName: candidate.repoFullName,
        issueNumber: candidate.number,
        beforeLabels: analyzed.labels,
        afterLabels: applied.labels,
        success: true,
        ...(partialMessage ? { errorMessage: partialMessage } : {}),
      },
    });

    // Complete GroomingRun. A partial application is explicit in history
    // and retryable: every landed step is recorded, so a retry of the same
    // application replays them instead of repeating them.
    await completeGroomingRunRecord(deps.prisma, groomingRun.id, {
      status: partial ? "partial" : "completed",
      stage: "applied",
      ...validationFields,
      applyOutcome: applied.outcome,
      appliedMutations,
      agentRunId: agentRun.id,
      commentUrl: applied.commentUrl,
      labelsAfter: applied.labels,
      ...(partial ? { errorMessage: partialMessage, retryable: true } : {}),
    });

    return result({ plannedLabels: newLabels, appliedMutations });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown groomer error";

    // Complete GroomingRun as failed
    try {
      await completeGroomingRunRecord(deps.prisma, groomingRun.id, {
        status: "failed",
        stage: groomingRun.stage ?? "selected",
        errorMessage: message,
        retryable: true,
      });
    } catch {
      // Don't mask the original error
    }

    await deps.prisma.agentRun.create({
      data: {
        agentName: "hosted-groomer",
        runType: "groom",
        status: "failed",
        startedAt: new Date(),
        finishedAt: new Date(),
        errorMessage: message,
        issueId: candidate.id,
        touchedIssueUrls: [candidate.url],
      },
    });
    await deps.prisma.auditLog.create({
      data: {
        actor: "hosted-groomer",
        action: "groom",
        repoFullName: candidate.repoFullName,
        issueNumber: candidate.number,
        beforeLabels: candidate.labels,
        afterLabels: candidate.labels,
        success: false,
        errorMessage: message,
      },
    });
    throw error;
  } finally {
    await deps.releaseLease(lease.id);
  }
}

function candidateSourceOf(candidate: { selectionReason?: string }): string {
  switch (candidate.selectionReason) {
    case "targeted":
    case "stale":
    case "freshness_unknown":
      return candidate.selectionReason;
    default:
      return "selector";
  }
}

/**
 * The legacy appliedMutations fields (read by /automation/groomer and the run
 * API) plus the per-step record of what this attempt applied.
 */
function describeApplication(applied: ApplyResult, withheld: Record<string, string[] | undefined>): Record<string, unknown> {
  const { steps } = applied;
  const out: Record<string, unknown> = {
    outcome: applied.outcome,
    steps,
    labelsUpdated: steps.labels?.status === "applied" || steps.done_label?.status === "applied",
  };
  if (applied.claimedByRunId) out.claimedByRunId = applied.claimedByRunId;
  if (Object.keys(withheld).length > 0) out.withheld = withheld;
  if (steps.content?.status === "applied" || steps.content?.status === "replayed") {
    out.titleUpdated = applied.title !== null;
    out.bodyUpdated = applied.body !== null;
  }
  const comment = steps.comment;
  if (comment && comment.status !== "noop") {
    if (applied.commentUrl) out.commentUrl = applied.commentUrl;
    if (comment.status === "skipped") out.commentSkippedReason = comment.detail ?? "skipped";
    if (comment.status === "failed" || comment.status === "not_attempted") out.commentPosted = false;
    if (comment.status === "failed") out.commentError = comment.error;
  }
  if (steps.close?.status === "applied" || steps.close?.status === "replayed") out.issueClosed = true;
  if (steps.close?.status === "failed") out.issueClosedError = steps.close.error;
  return out;
}
