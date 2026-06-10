import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  fetchRepo,
  fetchWorkflows,
  fetchRecentRunsAllWorkflows,
  fetchReleases,
  fetchPullRequests,
  fetchLatestCommit,
  fetchPackages,
  fetchRunJobs,
} from "@/lib/github";
import { getTrackedRepos } from "@/lib/config";
import { authorizeRequest } from "@/lib/auth";
import { acquireLock, releaseLock } from "@/lib/sync-lock";

async function syncRepo(repoFullName: string) {
  const parts = repoFullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { success: false, error: `Invalid repo full name: "${repoFullName}". Expected format: owner/repo`, syncRunId: null };
  }
  const [owner, name] = parts;

  let repo = await prisma.automationRepo.upsert({
    where: { fullName: repoFullName },
    create: {
      fullName: repoFullName,
      name,
      owner,
      defaultBranch: "main",
    },
    update: {},
  });

  const syncRun = await prisma.automationSyncRun.create({
    data: { repoId: repo.id, status: "running", reposFetched: 0, workflowsFetched: 0, runsFetched: 0 },
  });

  let repoUpdated = false;

  try {
    const [githubRepo, workflows, runs, releases, prs, packages] = await Promise.all([
      fetchRepo(repoFullName),
      fetchWorkflows(repoFullName),
      fetchRecentRunsAllWorkflows(repoFullName, 20),
      fetchReleases(repoFullName, 10),
      fetchPullRequests(repoFullName, 20),
      fetchPackages(repoFullName).catch(() => []),
    ]);

    repo = await prisma.automationRepo.update({
      where: { id: repo.id },
      data: {
        name: githubRepo.name,
        owner: githubRepo.owner.login,
        defaultBranch: githubRepo.default_branch,
      },
    });
    repoUpdated = true;

    await prisma.automationSyncRun.update({
      where: { id: syncRun.id },
      data: { reposFetched: 1 },
    });

    const latestCommit = await fetchLatestCommit(repoFullName, githubRepo.default_branch);
    await prisma.automationRepo.update({
      where: { id: repo.id },
      data: {
        latestCommitSha: latestCommit?.sha || null,
        openPRCount: prs.filter((pr) => pr.state === "open").length,
        lastSyncedAt: new Date(),
        syncError: null,
      },
    });

    // Batch workflow upserts in a single transaction
    if (workflows.length > 0) {
      await prisma.$transaction(
        workflows.map((wf) =>
          prisma.githubWorkflow.upsert({
            where: { workflowId: wf.id },
            create: {
              repoId: repo.id,
              workflowId: wf.id,
              name: wf.name,
              path: wf.path,
              state: wf.state,
              createdAt: new Date(wf.created_at),
              updatedAt: new Date(wf.updated_at),
              lastRunAt: wf.last_run ? new Date(wf.last_run.created_at) : null,
            },
            update: {
              name: wf.name,
              path: wf.path,
              state: wf.state,
              updatedAt: new Date(wf.updated_at),
              lastRunAt: wf.last_run ? new Date(wf.last_run.created_at) : null,
            },
          })
        ),
        { timeout: 30_000 }
      );
    }

    await prisma.automationSyncRun.update({
      where: { id: syncRun.id },
      data: { workflowsFetched: workflows.length },
    });

    // Batch run upserts in a single transaction
    if (runs.length > 0) {
      const runUpserts = runs.map((run) => {
        const prUrl = run.pull_requests?.[0]?.url || null;
        let durationSecs: number | null = null;
        if (run.status === "completed" && run.run_started_at) {
          const start = new Date(run.run_started_at).getTime();
          const end = new Date(run.updated_at).getTime();
          durationSecs = Math.round((end - start) / 1000);
        }
        return prisma.githubWorkflowRun.upsert({
          where: { runId: run.id },
          create: {
            workflowId: "placeholder", // filled below
            runId: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            branch: run.head_branch,
            headSha: run.head_sha,
            actor: run.actor.login,
            runStartedAt: new Date(run.run_started_at),
            updatedAt: new Date(run.updated_at),
            durationSecs,
            pullRequestUrl: prUrl,
          },
          update: {
            status: run.status,
            conclusion: run.conclusion,
            branch: run.head_branch,
            actor: run.actor.login,
            updatedAt: new Date(run.updated_at),
            durationSecs,
            pullRequestUrl: prUrl,
          },
        });
      });

      // First, resolve workflow IDs for runs that reference unknown workflows
      const dbWorkflows = await prisma.githubWorkflow.findMany({
        where: { repoId: repo.id },
        select: { id: true, name: true },
      });
      const workflowMap = new Map<string, string>();
      for (const wf of dbWorkflows) {
        workflowMap.set(wf.name, wf.id);
      }

      // Create placeholder workflows for runs with unknown workflow names
      const unknownRuns = runs.filter((run) => !workflowMap.has(run.name));
      if (unknownRuns.length > 0) {
        const placeholders = await prisma.$transaction(
          unknownRuns.map((run) =>
            prisma.githubWorkflow.create({
              data: {
                repoId: repo.id,
                workflowId: BigInt(run.id),
                name: run.name,
                path: "unknown",
                state: "unknown",
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            })
          )
        );
        for (const ph of placeholders) {
          workflowMap.set(ph.name, ph.id);
        }
      }

      // Now batch all run upserts with correct workflow IDs
      const resolvedUpserts = runs.map((run) => {
        let wfId = workflowMap.get(run.name);
        if (!wfId) {
          // Shouldn't happen after placeholder creation, but guard anyway
          return null;
        }
        const prUrl = run.pull_requests?.[0]?.url || null;
        let durationSecs: number | null = null;
        if (run.status === "completed" && run.run_started_at) {
          const start = new Date(run.run_started_at).getTime();
          const end = new Date(run.updated_at).getTime();
          durationSecs = Math.round((end - start) / 1000);
        }
        return prisma.githubWorkflowRun.upsert({
          where: { runId: run.id },
          create: {
            workflowId: wfId,
            runId: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            branch: run.head_branch,
            headSha: run.head_sha,
            actor: run.actor.login,
            runStartedAt: new Date(run.run_started_at),
            updatedAt: new Date(run.updated_at),
            durationSecs,
            pullRequestUrl: prUrl,
          },
          update: {
            status: run.status,
            conclusion: run.conclusion,
            branch: run.head_branch,
            actor: run.actor.login,
            updatedAt: new Date(run.updated_at),
            durationSecs,
            pullRequestUrl: prUrl,
          },
        });
      }).filter((item): item is any => item !== null);

      if (resolvedUpserts.length > 0) {
        await prisma.$transaction(resolvedUpserts, { timeout: 60_000 });
      }

      // Batch job upserts for completed runs — only fetch jobs for completed runs once
      const completedRuns = runs.filter((run) => run.status === "completed");
      if (completedRuns.length > 0) {
        for (const run of completedRuns) {
          const jobs = await fetchRunJobs(repoFullName, run.id).catch(() => []);
          if (jobs.length === 0) continue;

          // Get the run record we just upserted (no redundant findUnique needed)
          const savedRun = await prisma.githubWorkflowRun.findUnique({
            where: { runId: run.id },
          });
          if (!savedRun) continue;

          // Batch job upserts in a single transaction
          await prisma.$transaction(
            jobs.map((job) =>
              prisma.githubWorkflowJob.upsert({
                where: { runId_jobId: { runId: savedRun.id, jobId: job.id } },
                create: {
                  runId: savedRun.id,
                  jobId: job.id,
                  name: job.name,
                  status: job.status,
                  conclusion: job.conclusion,
                  startedAt: job.started_at ? new Date(job.started_at) : null,
                  completedAt: job.completed_at ? new Date(job.completed_at) : null,
                },
                update: {
                  status: job.status,
                  conclusion: job.conclusion,
                  startedAt: job.started_at ? new Date(job.started_at) : null,
                  completedAt: job.completed_at ? new Date(job.completed_at) : null,
                },
              })
            ),
            { timeout: 30_000 }
          );
        }
      }
    }

    await prisma.automationSyncRun.update({
      where: { id: syncRun.id },
      data: { runsFetched: runs.length },
    });

    // Batch release upserts in a single transaction
    if (releases.length > 0) {
      await prisma.$transaction(
        releases.map((rel) =>
          prisma.githubRelease.upsert({
            where: { repoId_releaseId: { repoId: repo.id, releaseId: rel.id } },
            create: {
              repoId: repo.id,
              releaseId: rel.id,
              tagName: rel.tag_name,
              name: rel.name,
              draft: rel.draft,
              prerelease: rel.prerelease,
              targetCommit: rel.target_commitish,
              url: rel.html_url,
              publishedAt: new Date(rel.published_at),
            },
            update: {
              tagName: rel.tag_name,
              name: rel.name,
              draft: rel.draft,
              prerelease: rel.prerelease,
              targetCommit: rel.target_commitish,
              url: rel.html_url,
              publishedAt: new Date(rel.published_at),
            },
          })
        ),
        { timeout: 30_000 }
      );
    }

    // Batch PR upserts in a single transaction
    const prsToUpsert = prs.slice(0, 50);
    if (prsToUpsert.length > 0) {
      await prisma.$transaction(
        prsToUpsert.map((pr) =>
          prisma.githubPullRequest.upsert({
            where: { repoId_number: { repoId: repo.id, number: pr.number } },
            create: {
              repoId: repo.id,
              number: pr.number,
              url: pr.url,
              title: pr.title,
              state: pr.state,
              author: pr.user.login,
              branch: pr.head.ref,
              baseBranch: pr.base.ref,
              createdAt: new Date(pr.created_at),
              updatedAt: new Date(pr.updated_at),
              mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
              isDraft: pr.draft,
            },
            update: {
              title: pr.title,
              state: pr.state,
              author: pr.user.login,
              branch: pr.head.ref,
              baseBranch: pr.base.ref,
              updatedAt: new Date(pr.updated_at),
              mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
              isDraft: pr.draft,
            },
          })
        ),
        { timeout: 30_000 }
      );
    }

    // Batch package upserts in a single transaction
    if (packages.length > 0) {
      await prisma.$transaction(
        packages.map((pkg) => {
          const latestTag = pkg.metadata?.container?.tags?.[0] || null;
          return prisma.githubPackage.upsert({
            where: { repoId_name: { repoId: repo.id, name: pkg.name } },
            create: {
              repoId: repo.id,
              packageType: pkg.package_type,
              name: pkg.name,
              visibility: pkg.visibility,
              url: pkg.html_url,
              latestTag,
              updatedAt: new Date(pkg.updated_at),
            },
            update: {
              latestTag,
              visibility: pkg.visibility,
              url: pkg.html_url,
              updatedAt: new Date(pkg.updated_at),
            },
          });
        }),
        { timeout: 30_000 }
      );
    }

    await prisma.automationEvent.create({
      data: {
        repoId: repo.id,
        eventType: "sync_completed",
        title: `Sync completed for ${repoFullName}`,
        description: `Fetched ${workflows.length} workflows, ${runs.length} runs, ${releases.length} releases`,
        actor: "system",
      },
    });

    await prisma.automationSyncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "completed",
        completedAt: new Date(),
      },
    });

    return { success: true, syncRunId: syncRun.id };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await prisma.automationRepo.update({
      where: { id: repo.id },
      data: { syncError: errorMessage, lastSyncedAt: new Date() },
    }).catch(() => {});

    await prisma.automationSyncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "failed",
        errorMessage,
        completedAt: new Date(),
      },
    });

    return { success: false, error: errorMessage, syncRunId: syncRun.id };
  }
}

export async function GET() {
  const repos = await prisma.automationRepo.findMany({
    orderBy: { fullName: "asc" },
    include: {
      _count: { select: { workflows: true, releases: true, automationEvents: true } },
    },
  });
  return NextResponse.json(repos);
}

export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const repoFullName = body.repo || body.fullName;

  // Acquire shared DB lock to prevent overlapping runs across all sync types
  const lockResult = await acquireLock("automation");
  if (!lockResult.locked) {
    return NextResponse.json(
      { error: "A sync is already running. Try again later.", locked: true },
      { status: 409 },
    );
  }

  const { runId } = lockResult;

  try {
    if (repoFullName) {
      const result = await syncRepo(repoFullName);
      if (result.success) {
        return NextResponse.json({ success: true, syncRunId: result.syncRunId });
      } else {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }
    }

    const repos = await getTrackedRepos();
    const results = [];
    for (const repo of repos) {
      results.push({ repo, result: await syncRepo(repo) });
    }

    return NextResponse.json({
      synced: results.filter((r) => r.result.success).length,
      failed: results.filter((r) => !r.result.success).length,
      results,
    });
  } finally {
    await releaseLock(runId).catch(() => {});
  }
}
