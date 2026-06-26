import { prisma } from "@/lib/prisma";
import { addIssueComment, updateIssueLabels } from "@/lib/github";
import { findActiveLeasesForIssue, releaseLease, upsertLease } from "@/lib/lease";
import { selectGroomingCandidate } from "./selector";
import { buildIssueContext, fetchIssueComments } from "./context";
import { callGroomerLLM } from "./llm";
import { validateGroomerOutput } from "./schema";
import { getHostedGroomerConfig } from "./config";

export interface GroomerRunResult {
  candidateNumber: number;
  repoFullName: string;
  dryRun: boolean;
  output: any;
  plannedLabels: string[];
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
  findActiveLeases: typeof findActiveLeasesForIssue;
  upsertLease: typeof upsertLease;
  releaseLease: typeof releaseLease;
  prisma: typeof prisma;
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
  findActiveLeases: findActiveLeasesForIssue,
  upsertLease,
  releaseLease,
  prisma,
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

  // Build context
  const context = await deps.buildContext({
    number: candidate.number,
    title: candidate.title,
    body: candidate.body,
    labels: candidate.labels,
    currentLane: candidate.currentLane,
    comments,
    maxContextBytes: config.maxContextBytes,
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

  const newLabels = applyLabelChanges(candidate.labels, output.labelsToAdd, output.labelsToRemove);

  if (dryRun) {
    return {
      candidateNumber: candidate.number,
      repoFullName: candidate.repoFullName,
      dryRun: true,
      output,
      plannedLabels: newLabels,
    };
  }

  // Write mode: apply mutations
  await deps.updateLabels(candidate.repoFullName, candidate.number, newLabels);

  if (output.githubComment?.trim()) {
    await deps.addComment(
      candidate.repoFullName,
      candidate.number,
      output.githubComment.trim().slice(0, MAX_GITHUB_COMMENT_CHARS),
    );
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
  await deps.prisma.agentRun.create({
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

    return {
      candidateNumber: candidate.number,
      repoFullName: candidate.repoFullName,
      dryRun: false,
      output,
      plannedLabels: newLabels,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown groomer error";
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
