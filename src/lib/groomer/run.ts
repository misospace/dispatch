import { prisma } from "@/lib/prisma";
import { addIssueComment, updateIssueLabels, updateIssueTitleAndBody } from "@/lib/github";
import { findActiveLeasesForIssue, releaseLease, upsertLease } from "@/lib/lease";
import { selectGroomingCandidate } from "./selector";
import { buildIssueContext, fetchIssueComments } from "./context";
import { callGroomerLLM } from "./llm";
import { validateGroomerOutput, type GroomerOutput } from "./schema";
import { getHostedGroomerConfig } from "./config";
import { buildRepositoryContext } from "./repository-context";
import type { RepositoryContextInput, RepositoryContextConfig } from "./repository-context";
import { createGroomingRunRecord, completeGroomingRunRecord, updateGroomingRunRecord } from "./history";

export interface GroomerRunResult {
  candidateNumber: number;
  repoFullName: string;
  dryRun: boolean;
  output: any;
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
const MAX_GITHUB_COMMENT_CHARS = 4096;

export interface GroomerDeps {
  selectCandidate: typeof selectGroomingCandidate;
  fetchComments: typeof fetchIssueComments;
  buildContext: typeof buildIssueContext;
  callLLM: typeof callGroomerLLM;
  validateOutput: typeof validateGroomerOutput;
  getConfig: typeof getHostedGroomerConfig;
  updateLabels: typeof updateIssueLabels;
  addComment: typeof addIssueComment;
  updateTitleAndBody: typeof updateIssueTitleAndBody;
  findActiveLeases: typeof findActiveLeasesForIssue;
  upsertLease: typeof upsertLease;
  releaseLease: typeof releaseLease;
  prisma: typeof prisma;
  buildRepositoryContext: typeof buildRepositoryContext;
}

const defaultDeps: GroomerDeps = {
  selectCandidate: selectGroomingCandidate,
  fetchComments: fetchIssueComments,
  buildContext: buildIssueContext,
  callLLM: callGroomerLLM,
  validateOutput: validateGroomerOutput,
  getConfig: getHostedGroomerConfig,
  updateLabels: updateIssueLabels,
  addComment: addIssueComment,
  updateTitleAndBody: updateIssueTitleAndBody,
  findActiveLeases: findActiveLeasesForIssue,
  upsertLease,
  releaseLease,
  prisma,
  buildRepositoryContext,
};

export async function runHostedGroomer(
  options: RunHostedGroomerOptions = {},
  deps: GroomerDeps = defaultDeps,
): Promise<GroomerRunResult | null> {
  const config = deps.getConfig();
  const dryRun = options.dryRun ?? config.dryRun;

  // Select candidate
  const candidate = await deps.selectCandidate({
    repoFullName: options.repoFullName,
    issueNumber: options.issueNumber,
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

  try {
    let comments: Awaited<ReturnType<typeof fetchIssueComments>> = [];
    try {
      comments = await deps.fetchComments(candidate.repoFullName, candidate.number);
    } catch {
      comments = [];
    }

    // Build repository context
    const repositoryContext = await deps.buildRepositoryContext(
      { repoFullName: candidate.repoFullName, issueTitle: candidate.title, issueBody: candidate.body },
      {
        enabled: config.repoContextEnabled,
        maxSearches: config.maxSearches,
        maxFiles: config.maxContextFiles,
        maxFileBytes: config.maxFileBytes,
        maxTotalBytes: Math.max(0, Math.floor(config.maxContextBytes * 0.4)),
      },
    );

    // Persist stage context_built with warnings and summary
    const contextWarnings = repositoryContext.warnings;
    await updateGroomingRunRecord(deps.prisma, groomingRun.id, {
      stage: "context_built",
      contextWarnings,
      contextSummary: {
        commentCount: comments.length,
        repositorySources: repositoryContext.sources,
        repositoryQueries: repositoryContext.queries,
        repositoryBytes: repositoryContext.bytes,
      },
    });

    // Build context
    const context = await deps.buildContext({
      number: candidate.number,
      title: candidate.title,
      body: candidate.body,
      labels: candidate.labels,
      currentLane: candidate.currentLane,
      comments,
      maxContextBytes: config.maxContextBytes,
      repositoryContext,
    });

    // Call LLM
    const rawOutput = await deps.callLLM({
      baseUrl: config.llmBaseUrl!,
      apiKey: config.apiKey!,
      model: config.model,
      prompt: context,
      timeoutMs: config.timeoutMs,
    });

    // Validate output
    const validation = deps.validateOutput(rawOutput);
    if (!validation.valid) {
      throw new Error(`Groomer output validation failed: ${validation.errors?.join(", ")}`);
    }

    const output = validation.parsed!;


    // Record structured alias-resolution warnings for observability
    if (validation.resolutions && validation.resolutions.length > 0) {
      for (const r of validation.resolutions) {
        contextWarnings.push(`enum:${r.field}: resolved '${r.rawValue}' -> '${r.resolvedValue}' via alias`);
      }
    }

    const newLabels = applyLabelChanges(candidate.labels, output.labelsToAdd, output.labelsToRemove);

    // Compute title/body enrichment decisions
    const titleBodyMutations = computeTitleBodyMutations(candidate, output);

    // Build mutationPlan
    const mutationPlan: Record<string, unknown> = {
      labelsToAdd: output.labelsToAdd,
      labelsToRemove: output.labelsToRemove,
      lane: output.lane,
      summary: output.summary ?? null,
      willComment: Boolean(output.githubComment?.trim()),
      titleRewritten: titleBodyMutations.shouldRewrite,
      originalTitle: titleBodyMutations.shouldRewrite ? candidate.title : undefined,
      proposedTitle: titleBodyMutations.proposedTitle,
      bodyEnriched: titleBodyMutations.shouldEnrich,
      proposedBody: titleBodyMutations.proposedBody,
    };

    // Persist stage planned
    await updateGroomingRunRecord(deps.prisma, groomingRun.id, {
      stage: "planned",
      rawOutput,
      validatedOutput: output,
      labelsToAdd: output.labelsToAdd,
      labelsToRemove: output.labelsToRemove,
      labelsAfter: newLabels,
      laneAfter: output.lane.id,
      mutationPlan,
      commentBodyPreview: output.githubComment?.trim()?.slice(0, 500) ?? null,
    });

    if (dryRun) {
      await completeGroomingRunRecord(deps.prisma, groomingRun.id, {
        status: "dry_run_completed",
        stage: "planned",
      });

      return {
        candidateNumber: candidate.number,
        repoFullName: candidate.repoFullName,
        dryRun: true,
        output,
        plannedLabels: newLabels,
        groomingRunId: groomingRun.id,
        contextWarnings,
        mutationPlan,
      };
    }

    // Write mode: apply mutations
    const appliedMutations: Record<string, unknown> = {};

    await deps.updateLabels(candidate.repoFullName, candidate.number, newLabels);
    appliedMutations.labelsUpdated = true;

    // Apply title and/or body updates if guardrails pass
    const titleBodyFields: Record<string, unknown> = {};
    if (titleBodyMutations.shouldRewrite && titleBodyMutations.proposedTitle) {
      titleBodyFields.title = titleBodyMutations.proposedTitle;
    }
    if (titleBodyMutations.shouldEnrich && titleBodyMutations.proposedBody) {
      titleBodyFields.body = titleBodyMutations.proposedBody;
    }
    if (Object.keys(titleBodyFields).length > 0) {
      await deps.updateTitleAndBody(candidate.repoFullName, candidate.number, titleBodyFields as Parameters<typeof updateIssueTitleAndBody>[2]);
      appliedMutations.titleUpdated = titleBodyMutations.shouldRewrite;
      appliedMutations.bodyUpdated = titleBodyMutations.shouldEnrich;
    }

    // Comment with cooldown enforcement
    if (output.githubComment?.trim()) {
      let commentPosted = false;
      let commentUrl: string | null = null;

      // Check cooldown unless force or cooldown disabled
      const shouldCheckCooldown = !options.force && config.commentCooldownHours > 0;
      if (shouldCheckCooldown) {
        const cooldownSince = new Date(Date.now() - config.commentCooldownHours * 60 * 60 * 1000);
        const recentComment = await deps.prisma.groomingRun.findFirst({
          where: {
            issueId: candidate.id,
            commentUrl: { not: null },
            createdAt: { gte: cooldownSince },
          },
        });
        if (recentComment) {
          appliedMutations.commentSkippedReason = "cooldown";
        } else {
          const result = await deps.addComment(
            candidate.repoFullName,
            candidate.number,
            output.githubComment.trim().slice(0, MAX_GITHUB_COMMENT_CHARS),
          );
          commentUrl = result.url ?? null;
          if (commentUrl) appliedMutations.commentUrl = commentUrl;
          commentPosted = true;
        }
      } else {
        const result = await deps.addComment(
          candidate.repoFullName,
          candidate.number,
          output.githubComment.trim().slice(0, MAX_GITHUB_COMMENT_CHARS),
        );
        commentUrl = result.url ?? null;
        if (commentUrl) appliedMutations.commentUrl = commentUrl;
        commentPosted = true;
      }

      if (!commentPosted && !("commentSkippedReason" in appliedMutations)) {
        appliedMutations.commentPosted = false;
      }
    }

    // Update issue grooming fields
    const issueData: Record<string, unknown> = {
      groomedAt: new Date(),
      groomedBy: "hosted-groomer",
      currentLane: output.lane.id,
    };
    if (output.summary) issueData.groomingSummary = output.summary;
    if (output.needsInfoReason) issueData.needsInfoReason = output.needsInfoReason;
    if (output.blockedReason) issueData.blockedReason = output.blockedReason;
    if (output.nextGroomingAction) issueData.nextGroomingAction = output.nextGroomingAction;

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

    // Create AgentRun row
    const agentRun = await deps.prisma.agentRun.create({
      data: {
        agentName: "hosted-groomer",
        runType: "groom",
        status: "completed",
        startedAt: new Date(),
        finishedAt: new Date(),
        summary: output.summary ?? null,
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
        beforeLabels: candidate.labels,
        afterLabels: newLabels,
        success: true,
      },
    });

    // Complete GroomingRun
    await completeGroomingRunRecord(deps.prisma, groomingRun.id, {
      status: "completed",
      stage: "applied",
      appliedMutations,
      agentRunId: agentRun.id,
      commentUrl: (appliedMutations.commentUrl as string | null) ?? null,
    });

    return {
      candidateNumber: candidate.number,
      repoFullName: candidate.repoFullName,
      dryRun: false,
      output,
      plannedLabels: newLabels,
      groomingRunId: groomingRun.id,
      contextWarnings,
      mutationPlan,
      appliedMutations,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown groomer error";

    // Complete GroomingRun as failed if it was created
    if (groomingRun?.id) {
      try {
        await completeGroomingRunRecord(deps.prisma, groomingRun.id, {
          status: "failed",
          stage: getCurrentStage(groomingRun),
          errorMessage: message,
          retryable: true,
        });
      } catch {
        // Don't mask the original error
      }
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

function getCurrentStage(run: { stage?: string }): string {
  return run.stage ?? "selected";
}

/**
 * Check if a title is "bad" and should be rewritten.
 * Bad titles: length < 10 chars, or matches generic patterns (single word like "P0", "TODO", etc.),
 * or is clearly just a priority/label token.
 */
function shouldRewriteTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < 10) return true;

  // Single word that looks like a generic token
  const words = trimmed.split(/\s+/);
  if (words.length === 1) {
    const lower = trimmed.toLowerCase();
    const GENERIC_TOKENS = ["p0", "p1", "p2", "p3", "p4", "todo", "bug", "fix", "fixme", "wip", "help", "urgent", "critical"];
    if (GENERIC_TOKENS.includes(lower)) return true;

    // Priority/label-like tokens: starts with a letter/digit, no spaces, looks like a label prefix
    if (/^[a-z0-9]+$/i.test(trimmed) && trimmed.length <= 6) return true;
  }

  return false;
}

/**
 * Check if a body is "sparse" and should be enriched.
 * Sparse bodies: missing, empty, or < 100 chars (excluding markdown/HTML comments).
 */
function shouldEnrichBody(body: string | null): boolean {
  if (body === null || body.trim().length === 0) return true;

  // Strip HTML comments
  let stripped = body.replace(/<!--[sS]*?-->/g, "");
  // Strip markdown-style block comments (if any)
  stripped = stripped.replace(/^<!--[\s\S]*?-->/gm, "");

  if (stripped.trim().length < 100) return true;
  return false;
}

/**
 * Compute title/body enrichment decisions and build the mutation plan entries.
 */
function computeTitleBodyMutations(
  candidate: { title: string; body: string | null },
  output: GroomerOutput,
): {
  shouldRewrite: boolean;
  shouldEnrich: boolean;
  proposedTitle?: string;
  proposedBody?: string;
} {
  const proposedTitle = typeof output.proposedTitle === "string" ? output.proposedTitle : undefined;
  const proposedBody = typeof output.proposedBody === "string" ? output.proposedBody : undefined;

  const shouldRewrite = proposedTitle !== undefined && shouldRewriteTitle(candidate.title);
  const shouldEnrich = proposedBody !== undefined && shouldEnrichBody(candidate.body);

  return {
    shouldRewrite,
    shouldEnrich,
    ...(shouldRewrite ? { proposedTitle } : {}),
    ...(shouldEnrich ? { proposedBody } : {}),
  };
}

function applyLabelChanges(
  current: string[],
  toAdd: string[],
  toRemove: string[],
): string[] {
  let labels = [...current];
  for (const label of toAdd) {
    if (!labels.includes(label)) {
      labels.push(label);
    }
  }
  for (const label of toRemove) {
    labels = labels.filter((l) => l !== label);
  }
  return labels;
}
