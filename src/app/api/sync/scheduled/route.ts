import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchIssues, fetchRepo, fetchWorkflows, fetchRecentRunsAllWorkflows, fetchReleases, fetchPullRequests, fetchLatestCommit, fetchPackages, fetchRunJobs } from "@/lib/github";
import { getSyncRepos, getTrackedRepos } from "@/lib/config";
import { syncIssuesForRepos, SyncResponse } from "@/lib/issue-sync";
import { isAuthorizedAgentToken } from "@/lib/dispatch-env";

// ---------------------------------------------------------------------------
// Lock acquisition — DB-backed single-row guard to prevent overlapping runs.
// Uses upsert on a single "global" row; the first writer wins.
// ---------------------------------------------------------------------------

async function acquireLock(): Promise<{ locked: true; runId: string } | { locked: false }> {
  const existing = await prisma.syncLock.findUnique({ where: { id: "global" } });

  if (existing && existing.syncRunId) {
    const maxAgeMs = 30 * 60 * 1000;
    const age = Date.now() - existing.acquiredAt.getTime();
    if (age < maxAgeMs) {
      return { locked: false };
    }
    // Stale lock — clear it and proceed
    await prisma.syncLock.delete({ where: { id: "global" } });
  }

  const runId = `sync-run-${Date.now()}`;

  try {
    // Atomically create the lock row. If another concurrent request already
    // created it, this will throw a unique constraint error and we'll return
    // { locked: false }.
    await prisma.$transaction(async (tx) => {
      // Double-check inside the transaction for race safety
      const stillExisting = await tx.syncLock.findUnique({ where: { id: "global" } });
      if (stillExisting && stillExisting.syncRunId) {
        throw new Error("already_locked");
      }

      await tx.syncLock.create({
        data: { id: "global", syncRunId: runId, acquiredAt: new Date() },
      });

      const created = await tx.issueSyncRun.create({
        data: { status: "running", syncType: "scheduled", startedAt: new Date() },
      });

      return created.id;
    });

    return { locked: true, runId };
  } catch (err) {
    if (err instanceof Error && err.message === "already_locked") {
      return { locked: false };
    }
    // Re-throw unexpected errors
    throw err;
  }
}

async function releaseLock(runId: string): Promise<void> {
  await prisma.syncLock.updateMany({
    where: { id: "global", syncRunId: runId },
    data: { syncRunId: null, acquiredAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  // Auth check — require Bearer token matching DISPATCH_AGENT_TOKEN
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!isAuthorizedAgentToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const options = body as Record<string, unknown>;
  const syncIssues = options.issues !== false; // default true
  const syncAutomation = options.automation === true; // default false

  // Acquire DB lock to prevent overlapping runs
  const lockResult = await acquireLock();
  if (!lockResult.locked) {
    return NextResponse.json(
      { error: "A scheduled sync is already running. Try again later.", locked: true },
      { status: 409 },
    );
  }

  const { runId } = lockResult;
  const startedAt = new Date();

  try {
    let issueSync: SyncResponse | null = null;
    let automationResult: { synced: number; failed: number } | null = null;

    // Issue sync (default enabled)
    if (syncIssues) {
      const repos = await getSyncRepos();
      issueSync = await syncIssuesForRepos(repos, fetchIssues, {
        findIssue(repositoryId, number) {
          return prisma.issue.findUnique({
            where: { repositoryId_number: { repositoryId, number } },
          });
        },
        async updateIssue(id, data) {
          await prisma.issue.update({ where: { id }, data });
        },
        async createIssue(repositoryId, data) {
          await prisma.issue.create({ data: { ...data, repositoryId } });
        },
      });
    }

    // Automation sync (optional, opt-in)
    if (syncAutomation) {
      const trackedRepos = await getTrackedRepos();
      const results: { repo: string; result: { success: boolean } }[] = [];

      for (const repo of trackedRepos) {
        const parts = repo.split("/");
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          results.push({ repo, result: { success: false } });
          continue;
        }
        const [owner, name] = parts;

        try {
          const githubRepo = await fetchRepo(repo);
          const workflows = await fetchWorkflows(repo);
          const runs = await fetchRecentRunsAllWorkflows(repo, 20);
          const releases = await fetchReleases(repo, 10);
          const prs = await fetchPullRequests(repo, 20);
          const packagesList = await fetchPackages(repo).catch(() => []);

          let dbRepo = await prisma.automationRepo.upsert({
            where: { fullName: repo },
            create: { fullName: repo, name, owner, defaultBranch: "main" },
            update: { name: githubRepo.name, owner: githubRepo.owner.login, defaultBranch: githubRepo.default_branch },
          });

          const syncRun = await prisma.automationSyncRun.create({
            data: { repoId: dbRepo.id, status: "running", reposFetched: 1, workflowsFetched: workflows.length, runsFetched: runs.length },
          });

          const latestCommit = await fetchLatestCommit(repo, githubRepo.default_branch);
          await prisma.automationRepo.update({
            where: { id: dbRepo.id },
            data: { latestCommitSha: latestCommit?.sha || null, openPRCount: prs.filter((p) => p.state === "open").length, lastSyncedAt: new Date(), syncError: null },
          });

          for (const wf of workflows) {
            await prisma.githubWorkflow.upsert({
              where: { workflowId: wf.id },
              create: { repoId: dbRepo.id, workflowId: wf.id, name: wf.name, path: wf.path, state: wf.state, createdAt: new Date(wf.created_at), updatedAt: new Date(wf.updated_at), lastRunAt: wf.last_run ? new Date(wf.last_run.created_at) : null },
              update: { name: wf.name, path: wf.path, state: wf.state, updatedAt: new Date(wf.updated_at), lastRunAt: wf.last_run ? new Date(wf.last_run.created_at) : null },
            });
          }

          const workflowMap = new Map<string, string>();
          const dbWorkflows = await prisma.githubWorkflow.findMany({ where: { repoId: dbRepo.id }, select: { id: true, name: true } });
          for (const wf of dbWorkflows) workflowMap.set(wf.name, wf.id);

          for (const run of runs) {
            const prUrl = run.pull_requests?.[0]?.url || null;
            let durationSecs: number | null = null;
            if (run.status === "completed" && run.run_started_at) {
              const start = new Date(run.run_started_at).getTime();
              const end = new Date(run.updated_at).getTime();
              durationSecs = Math.round((end - start) / 1000);
            }

            let wfId = workflowMap.get(run.name);
            if (!wfId) {
              const placeholderWf = await prisma.githubWorkflow.create({
                data: { repoId: dbRepo.id, workflowId: BigInt(run.id), name: run.name, path: "unknown", state: "unknown", createdAt: new Date(), updatedAt: new Date() },
              });
              wfId = placeholderWf.id;
              workflowMap.set(run.name, wfId);
            }

            await prisma.githubWorkflowRun.upsert({
              where: { runId: run.id },
              create: { workflowId: wfId, runId: run.id, name: run.name, status: run.status, conclusion: run.conclusion, branch: run.head_branch, headSha: run.head_sha, actor: run.actor.login, runStartedAt: new Date(run.run_started_at), updatedAt: new Date(run.updated_at), durationSecs, pullRequestUrl: prUrl },
              update: { status: run.status, conclusion: run.conclusion, branch: run.head_branch, actor: run.actor.login, updatedAt: new Date(run.updated_at), durationSecs, pullRequestUrl: prUrl },
            }).catch(() => {});

            const savedRun = await prisma.githubWorkflowRun.findUnique({ where: { runId: run.id } });
            if (savedRun && run.status === "completed") {
              const jobs = await fetchRunJobs(repo, run.id).catch(() => []);
              for (const job of jobs) {
                await prisma.githubWorkflowJob.upsert({
                  where: { runId_jobId: { runId: savedRun.id, jobId: job.id } },
                  create: { runId: savedRun.id, jobId: job.id, name: job.name, status: job.status, conclusion: job.conclusion, startedAt: job.started_at ? new Date(job.started_at) : null, completedAt: job.completed_at ? new Date(job.completed_at) : null },
                  update: { status: job.status, conclusion: job.conclusion, startedAt: job.started_at ? new Date(job.started_at) : null, completedAt: job.completed_at ? new Date(job.completed_at) : null },
                });
              }
            }
          }

          for (const rel of releases) {
            await prisma.githubRelease.upsert({
              where: { repoId_releaseId: { repoId: dbRepo.id, releaseId: rel.id } },
              create: { repoId: dbRepo.id, releaseId: rel.id, tagName: rel.tag_name, name: rel.name, draft: rel.draft, prerelease: rel.prerelease, targetCommit: rel.target_commitish, url: rel.html_url, publishedAt: new Date(rel.published_at) },
              update: { tagName: rel.tag_name, name: rel.name, draft: rel.draft, prerelease: rel.prerelease, targetCommit: rel.target_commitish, url: rel.html_url, publishedAt: new Date(rel.published_at) },
            });
          }

          const prsToUpsert = prs.slice(0, 50);
          for (const pr of prsToUpsert) {
            await prisma.githubPullRequest.upsert({
              where: { repoId_number: { repoId: dbRepo.id, number: pr.number } },
              create: { repoId: dbRepo.id, number: pr.number, url: pr.url, title: pr.title, state: pr.state, author: pr.user.login, branch: pr.head.ref, baseBranch: pr.base.ref, createdAt: new Date(pr.created_at), updatedAt: new Date(pr.updated_at), mergedAt: pr.merged_at ? new Date(pr.merged_at) : null, isDraft: pr.draft },
              update: { title: pr.title, state: pr.state, author: pr.user.login, branch: pr.head.ref, baseBranch: pr.base.ref, updatedAt: new Date(pr.updated_at), mergedAt: pr.merged_at ? new Date(pr.merged_at) : null, isDraft: pr.draft },
            });
          }

          for (const pkg of packagesList) {
            const latestTag = pkg.metadata?.container?.tags?.[0] || null;
            await prisma.githubPackage.upsert({
              where: { repoId_name: { repoId: dbRepo.id, name: pkg.name } },
              create: { repoId: dbRepo.id, packageType: pkg.package_type, name: pkg.name, visibility: pkg.visibility, url: pkg.html_url, latestTag, updatedAt: new Date(pkg.updated_at) },
              update: { latestTag, visibility: pkg.visibility, url: pkg.html_url, updatedAt: new Date(pkg.updated_at) },
            });
          }

          await prisma.automationEvent.create({
            data: { repoId: dbRepo.id, eventType: "sync_completed", title: `Sync completed for ${repo}`, description: `Fetched ${workflows.length} workflows, ${runs.length} runs, ${releases.length} releases`, actor: "system" },
          });

          await prisma.automationSyncRun.update({ where: { id: syncRun.id }, data: { status: "completed", completedAt: new Date() } });
          results.push({ repo, result: { success: true } });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          results.push({ repo, result: { success: false } });
          console.error(`Automation sync failed for ${repo}:`, errorMessage);
        }
      }

      automationResult = {
        synced: results.filter((r) => r.result.success).length,
        failed: results.filter((r) => !r.result.success).length,
      };
    }

    // Update the sync run record
    const finishedAt = new Date();
    await prisma.issueSyncRun.updateMany({
      where: { id: runId, status: "running" },
      data: {
        status: "completed",
        completedAt: finishedAt,
        reposFetched: issueSync?.repos ?? 0,
        syncedCount: issueSync?.syncedCount ?? 0,
        notes: JSON.stringify({
          issueResults: issueSync?.results,
          automationResult,
        }),
      },
    });

    await releaseLock(runId);

    // Build response
    const response: Record<string, unknown> = {
      success: true,
      startedAt,
      finishedAt,
    };

    if (syncIssues && issueSync) {
      response.issues = {
        repos: issueSync.repos,
        syncedCount: issueSync.syncedCount,
        results: issueSync.results,
      };
    }

    if (syncAutomation && automationResult) {
      response.automation = {
        synced: automationResult.synced,
        failed: automationResult.failed,
      };
    }

    return NextResponse.json(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Scheduled sync failed:", error);

    // Update the sync run record with error
    await prisma.issueSyncRun.updateMany({
      where: { id: runId, status: "running" },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage,
      },
    }).catch(() => {});

    await releaseLock(runId).catch(() => {});

    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
