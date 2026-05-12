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

    for (const wf of workflows) {
      await prisma.githubWorkflow.upsert({
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
      });
    }

    const workflowMap = new Map<string, string>();
    const dbWorkflows = await prisma.githubWorkflow.findMany({
      where: { repoId: repo.id },
      select: { id: true, name: true },
    });
    for (const wf of dbWorkflows) {
      workflowMap.set(wf.name, wf.id);
    }

    await prisma.automationSyncRun.update({
      where: { id: syncRun.id },
      data: { workflowsFetched: workflows.length },
    });

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
          data: {
            repoId: repo.id,
            workflowId: BigInt(run.id),
            name: run.name,
            path: "unknown",
            state: "unknown",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        wfId = placeholderWf.id;
        workflowMap.set(run.name, wfId);
      }

      await prisma.githubWorkflowRun.upsert({
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
      }).catch(() => {});

      const savedRun = await prisma.githubWorkflowRun.findUnique({
        where: { runId: run.id },
      });
      if (savedRun && run.status === "completed") {
        const jobs = await fetchRunJobs(repoFullName, run.id).catch(() => []);
        for (const job of jobs) {
          await prisma.githubWorkflowJob.upsert({
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
          });
        }
      }
    }

    await prisma.automationSyncRun.update({
      where: { id: syncRun.id },
      data: { runsFetched: runs.length },
    });

    for (const rel of releases) {
      await prisma.githubRelease.upsert({
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
      });
    }

    const prsToUpsert = prs.slice(0, 50);
    for (const pr of prsToUpsert) {
      await prisma.githubPullRequest.upsert({
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
      });
    }

    for (const pkg of packages) {
      const latestTag = pkg.metadata?.container?.tags?.[0] || null;
      await prisma.githubPackage.upsert({
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
  const body = await request.json().catch(() => ({}));
  const repoFullName = body.repo || body.fullName;

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
}