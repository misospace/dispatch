/**
 * Automation sync pipeline: pulls a repo's GitHub automation surface
 * (workflows, runs, jobs, releases, PRs, packages) into Prisma.
 *
 * Shared by the automation sync route (manual/per-repo) and the scheduled
 * sync route (per tracked repo).
 */

import { prisma } from "@/lib/prisma";
import {
  fetchRepo,
  fetchWorkflows,
  fetchRecentRunsAllWorkflows,
  fetchReleases,
  fetchPullRequests,
  fetchClosedPullRequests,
  fetchLatestCommit,
  fetchCompare,
  fetchStableBaselineRelease,
  fetchPackages,
  fetchRunJobs,
  type GithubCommit,
  type GithubCompare,
  type GithubRelease,
} from "@/lib/github";

/**
 * Release delta (#1480): authoritative unreleased count from the newest
 * *stable* release (drafts/prereleases never baseline) to the pinned
 * default-branch head.
 *
 * State vocabulary (persisted verbatim; consumers must never read
 * `releaseAheadBy` as an unreleased count outside identical/ahead):
 * - `identical` — head is the baseline commit itself; 0 unreleased.
 * - `ahead`     — head is N commits past the baseline; `releaseAheadBy` is N.
 * - `diverged`  — baseline is not an ancestor of head (rebase/force-push or a
 *   head behind the tag); surfaced explicitly, count withheld.
 * - `no-baseline` — the repo has no stable release. Distinct from "0 commits";
 *   never a count.
 * - `unknown`   — fail-closed (tag unresolvable, GitHub unreadable, head
 *   unresolved, compare impossible) with a bounded error; the last good
 *   release history is untouched.
 *
 * Never throws: a delta failure degrades to `unknown` + `releaseError` and
 * leaves the rest of the sync intact.
 */
export type ReleaseDeltaState = "identical" | "ahead" | "diverged" | "unknown" | "no-baseline";

export interface ReleaseDeltaSnapshot {
  releaseState: ReleaseDeltaState;
  releaseBaselineTag: string | null;
  releaseBaselineSha: string | null;
  releaseBaselinePublishedAt: Date | null;
  releaseHeadSha: string | null;
  releaseAheadBy: number | null;
  releaseError: string | null;
}

const RELEASE_ERROR_MAX_CHARS = 500;

function boundedReleaseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return "unknown error";
  return message.length > RELEASE_ERROR_MAX_CHARS
    ? `${message.slice(0, RELEASE_ERROR_MAX_CHARS - 1)}…`
    : message;
}

export interface StableReleaseSearchResult {
  release: GithubRelease | null;
  // True when stable-release absence is verified (listing fully enumerated);
  // false when the bounded deep search hit its cap without finding one.
  complete: boolean;
}

export interface ReleaseDeltaDeps {
  resolveRef: (repoFullName: string, ref: string) => Promise<GithubCommit | null>;
  compare: (repoFullName: string, baseRef: string, headRef: string) => Promise<GithubCompare | null>;
  // Deepens the release search when the provided window holds no stable
  // release (drafts/prereleases can crowd every stable release out of the
  // persisted ≤50 window). Optional so test mocks of "@/lib/github" that
  // predate this export keep the window-only behavior.
  findStableRelease?: (
    repoFullName: string,
    initialReleases: GithubRelease[]
  ) => Promise<StableReleaseSearchResult>;
}

// Lazy wrappers: resolved at call time so test mocks of "@/lib/github" that
// predate this export still load the module; a missing compare export then
// fails closed into the bounded `unknown` delta below, never a crash.
const defaultReleaseDeltaDeps: ReleaseDeltaDeps = {
  resolveRef: (repoFullName, ref) => fetchLatestCommit(repoFullName, ref),
  compare: (repoFullName, baseRef, headRef) => fetchCompare(repoFullName, baseRef, headRef),
  findStableRelease: (repoFullName, initialReleases) =>
    fetchStableBaselineRelease(repoFullName, initialReleases),
};

function newestStableIn(releases: GithubRelease[]): GithubRelease | null {
  return (
    releases
      .filter((rel) => !rel.draft && !rel.prerelease)
      .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())[0] ??
    null
  );
}

export async function computeReleaseDelta(
  repoFullName: string,
  releases: GithubRelease[],
  headSha: string | null,
  deps: ReleaseDeltaDeps = defaultReleaseDeltaDeps
): Promise<ReleaseDeltaSnapshot> {
  // Newest stable first (drafts/prereleases never baseline). The listing is
  // the same bounded history the sync already persists (≤50 newest); when no
  // stable release is in that window, the deepening search below resolves
  // the actual newest stable before any absence is claimed.
  let stable = newestStableIn(releases);
  let searchComplete = true;
  if (!stable && deps.findStableRelease) {
    try {
      const search = await deps.findStableRelease(repoFullName, releases);
      stable = search.release;
      searchComplete = search.complete;
    } catch (error) {
      return {
        releaseState: "unknown",
        releaseBaselineTag: null,
        releaseBaselineSha: null,
        releaseBaselinePublishedAt: null,
        releaseHeadSha: headSha,
        releaseAheadBy: null,
        releaseError: boundedReleaseError(error).slice(0, RELEASE_ERROR_MAX_CHARS),
      };
    }
  }

  if (!stable) {
    if (!searchComplete) {
      // The bounded deep search hit its cap without finding a stable
      // release: absence is unverified, so fail closed to `unknown` instead
      // of manufacturing a `no-baseline`.
      return {
        releaseState: "unknown",
        releaseBaselineTag: null,
        releaseBaselineSha: null,
        releaseBaselinePublishedAt: null,
        releaseHeadSha: headSha,
        releaseAheadBy: null,
        releaseError:
          "no stable release found before the bounded release search hit its cap".slice(
            0,
            RELEASE_ERROR_MAX_CHARS
          ),
      };
    }
    // Distinct "no baseline" state — not 0 commits, not an error.
    return {
      releaseState: "no-baseline",
      releaseBaselineTag: null,
      releaseBaselineSha: null,
      releaseBaselinePublishedAt: null,
      releaseHeadSha: headSha,
      releaseAheadBy: null,
      releaseError: null,
    };
  }

  const baselineInfo = {
    releaseBaselineTag: stable.tag_name,
    releaseBaselineSha: null as string | null,
    releaseBaselinePublishedAt: new Date(stable.published_at),
    releaseHeadSha: headSha,
  };

  const unknownDelta = (error: string): ReleaseDeltaSnapshot => ({
    ...baselineInfo,
    releaseState: "unknown",
    releaseAheadBy: null,
    releaseError: error.slice(0, RELEASE_ERROR_MAX_CHARS),
  });

  if (!headSha) {
    return unknownDelta("default-branch head SHA unresolved; compare skipped");
  }

  let baselineCommit: GithubCommit | null;
  try {
    baselineCommit = await deps.resolveRef(repoFullName, stable.tag_name);
  } catch (error) {
    return unknownDelta(boundedReleaseError(error));
  }
  if (!baselineCommit?.sha) {
    return unknownDelta(`release tag ${stable.tag_name} did not resolve to a commit`);
  }

  let comparison: GithubCompare | null;
  try {
    // Pin both endpoints to immutable SHAs (head was pinned by the caller
    // from the same fetch that persisted latestCommitSha) so the persisted
    // numbers describe exactly what was compared.
    comparison = await deps.compare(repoFullName, baselineCommit.sha, headSha);
  } catch (error) {
    return unknownDelta(boundedReleaseError(error));
  }
  if (!comparison) {
    return unknownDelta(`compare ${stable.tag_name}...${headSha} unavailable`);
  }

  const resolved = {
    ...baselineInfo,
    releaseBaselineSha: baselineCommit.sha,
    releaseError: null,
  };

  // `behind` (head lacks the release commit) is not a normal unreleased
  // state either: fold it into `diverged` rather than reporting ahead_by.
  if (comparison.status === "behind" || comparison.status === "diverged") {
    return { ...resolved, releaseState: "diverged", releaseAheadBy: null };
  }
  return {
    ...resolved,
    releaseState: comparison.status === "identical" ? "identical" : "ahead",
    releaseAheadBy: comparison.aheadBy,
  };
}

export interface AutomationSyncResult {
  success: boolean;
  error?: string;
  syncRunId: string | null;
}

export async function syncAutomationRepo(repoFullName: string): Promise<AutomationSyncResult> {
  const parts = repoFullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { success: false, error: `Invalid repo full name: "${repoFullName}". Expected format: owner/repo`, syncRunId: null };
  }
  const [owner, name] = parts;

  const repo = await prisma.automationRepo.upsert({
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

  // Once this pass's delta snapshot is persisted, later-stage failures must
  // not downgrade it — it describes a comparison that actually completed.
  // Before that point, a failed sync means GitHub was never fully readable,
  // so the catch below fails the delta closed to `unknown` rather than
  // leaving a stale count.
  let deltaPersisted = false;

  try {
    const [githubRepo, workflows, runs, releases, prs, closedPrs, packages] = await Promise.all([
      fetchRepo(repoFullName),
      fetchWorkflows(repoFullName),
      fetchRecentRunsAllWorkflows(repoFullName, 20),
      fetchReleases(repoFullName, 10),
      fetchPullRequests(repoFullName, 20),
      // A merged PR drops out of the state=open listing, so the open-only
      // fetch can never persist its merge time (#1313). One added listing per
      // sync (newest-updated first, single page). Its failure degrades
      // gracefully like packages: merge times land on the next sync instead
      // of failing the whole run.
      fetchClosedPullRequests(repoFullName, 50).catch(() => []),
      fetchPackages(repoFullName).catch(() => []),
    ]);

    await prisma.automationRepo.update({
      where: { id: repo.id },
      data: {
        name: githubRepo.name,
        owner: githubRepo.owner.login,
        defaultBranch: githubRepo.default_branch,
      },
    });

    await prisma.automationSyncRun.update({
      where: { id: syncRun.id },
      data: { reposFetched: 1 },
    });

    const latestCommit = await fetchLatestCommit(repoFullName, githubRepo.default_branch);
    const releaseDelta = await computeReleaseDelta(
      repoFullName,
      releases,
      latestCommit?.sha || null
    );
    await prisma.automationRepo.update({
      where: { id: repo.id },
      data: {
        latestCommitSha: latestCommit?.sha || null,
        openPRCount: prs.filter((pr) => pr.state === "open").length,
        lastSyncedAt: new Date(),
        syncError: null,
        ...releaseDelta,
        releaseDeltaSyncedAt: new Date(),
      },
    });
    deltaPersisted = true;

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
      const runsToUpsert = runs.flatMap((run) => {
        const wfId = workflowMap.get(run.name);
        if (!wfId) {
          // Shouldn't happen after placeholder creation, but guard anyway
          return [];
        }
        const prUrl = run.pull_requests?.[0]?.url || null;
        let durationSecs: number | null = null;
        if (run.status === "completed" && run.run_started_at) {
          const start = new Date(run.run_started_at).getTime();
          const end = new Date(run.updated_at).getTime();
          durationSecs = Math.round((end - start) / 1000);
        }
        return [{
          run,
          upsert: prisma.githubWorkflowRun.upsert({
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
          }),
        }];
      });

      const savedRuns = runsToUpsert.length > 0
        ? await prisma.$transaction(runsToUpsert.map((r) => r.upsert), { timeout: 60_000 })
        : [];

      // Batch job upserts for completed runs, using the rows returned by the
      // upsert transaction (savedRuns[i] corresponds to runsToUpsert[i]).
      // Job fetches are independent, so run them concurrently.
      const completedRuns = runsToUpsert
        .map(({ run }, i) => ({ run, savedRun: savedRuns[i] }))
        .filter(({ run }) => run.status === "completed");

      await Promise.all(
        completedRuns.map(async ({ run, savedRun }) => {
          const jobs = await fetchRunJobs(repoFullName, run.id).catch(() => []);
          if (jobs.length === 0) return;

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
        })
      );
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

    // Batch PR upserts in a single transaction.
    // The closed listing carries rows the open listing can never reflect:
    // merged rows hold the authoritative merged_at the open listing lacks
    // (#1313), and a PR that closed without merging drops out of the
    // state=open listing entirely — leaving it out here would keep its row
    // state "open" with updatedAt frozen at last sighting (#1321). A PR can
    // appear in both listings when it changes state between the two
    // concurrent snapshots; the closed row wins, so an open snapshot never
    // overwrites newer closed state (or nulls a merged row's merge time).
    const closedPrsToUpsert = closedPrs.slice(0, 50);
    const closedPrNumbers = new Set(closedPrsToUpsert.map((pr) => pr.number));
    const prsToUpsert = [
      ...closedPrsToUpsert,
      ...prs.filter((pr) => !closedPrNumbers.has(pr.number)).slice(0, 50),
    ];
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

    // Fail the delta closed when this pass never persisted its snapshot: a
    // half-failed sync means GitHub was not fully readable, so a previously
    // persisted `ahead`/count must not keep presenting itself as current.
    // Never downgrade a snapshot this same pass completed.
    const deltaFailClosed = deltaPersisted
      ? {}
      : {
          releaseState: "unknown" as const,
          releaseAheadBy: null,
          releaseError: boundedReleaseError(`sync failed before delta persisted: ${errorMessage}`),
        };

    await prisma.automationRepo.update({
      where: { id: repo.id },
      data: {
        syncError: errorMessage,
        lastSyncedAt: new Date(),
        ...deltaFailClosed,
      },
    }).catch((error) => {
      console.error(`Failed to update automation repo ${repo.id} with error state:`, error);
    });

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
