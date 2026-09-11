import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { authorizeRequest } from "@/lib/auth";
import { getTrackedRepos } from "@/lib/config";
import {
  fetchRepositoryMetadata,
  fetchRecentRunsAllWorkflows,
  fetchRunJobs,
  fetchFailedJobLogExcerpt,
  fetchIssues,
  createIssue,
  addIssueComment,
  closeIssue,
} from "@/lib/github";
import {
  buildCloseComment,
  buildIssueDraft,
  classifyWorkflow,
  computeFailureSignature,
  decideAction,
  extractFailureMarker,
  extractFailureWorkflow,
  hasOpenIssueForSignature,
  groupDefaultBranchRuns,
  isScanFailure,
  parseScanFindings,
  type CiRun,
  type FailureKind,
  type FiledIssue,
} from "@/lib/ci-failure-ingestion";
import { enforceRateLimit } from "@/lib/rate-limit";
import { acquireLock, releaseLock, type AcquiredLock, type LockConflict } from "@/lib/sync-lock";

/**
 * Files an issue when a workflow fails twice in a row on a repo's default
 * branch, and closes it when the workflow goes green again.
 *
 * `pr-followup` covers failing checks on a pull request. This covers the same
 * failure with no PR attached, which previously reached nothing at all.
 *
 * Holds no state: consecutiveness comes from the workflow's own recent runs,
 * and "already filed" from a marker in the issue body. See
 * `lib/ci-failure-ingestion.ts` for the policy and why each part of it is the
 * way it is.
 */

/** Labels applied to a filed issue. Configurable so this carries no
 *  assumption about any one deployment's taxonomy. Scan blockers additionally
 *  carry type/security: they are security findings, and the label is what
 *  downstream tooling (and the groomer) keys on to keep them on the
 *  escalation lane (#988). */
function issueLabels(kind?: FailureKind): string[] {
  const raw = process.env.DISPATCH_CI_FAILURE_LABELS;
  const base =
    raw === undefined
      ? ["type/bug", "status/ready"]
      : raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  if (kind === "scan" && !base.includes("type/security")) {
    return [...base, "type/security"];
  }
  return base;
}

async function filedIssuesFor(repoFullName: string): Promise<FiledIssue[]> {
  const issues = await fetchIssues(repoFullName, { includeClosed: true });
  const filed: FiledIssue[] = [];
  for (const issue of issues) {
    const signature = extractFailureMarker(issue.body);
    if (!signature) continue;
    filed.push({
      number: issue.number,
      state: issue.state === "closed" ? "closed" : "open",
      signature,
      workflowName: extractFailureWorkflow(issue.body),
    });
  }
  return filed;
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const limited = enforceRateLimit(`ci-failures-sync:${auth.actor}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (limited) return limited;

  let lock: AcquiredLock | LockConflict | undefined;
  lock = await acquireLock("ci-failures");
  if (!lock?.locked) {
    return NextResponse.json(
      { error: "CI failure sync is already running", locked: true },
      { status: 409 },
    );
  }

  const filedIssues: { repo: string; number: number; workflow: string }[] = [];
  const closedIssues: { repo: string; number: number; workflow: string }[] = [];
  const skipped: { repo: string; workflow: string; reason: string }[] = [];
  const errors: { repo: string; error: string }[] = [];

  try {
    for (const repoFullName of await getTrackedRepos()) {
      try {
        const [meta, runs] = await Promise.all([
          fetchRepositoryMetadata(repoFullName),
          fetchRecentRunsAllWorkflows(repoFullName, 50),
        ]);
        const histories = groupDefaultBranchRuns(runs as CiRun[], meta.defaultBranch);
        if (histories.length === 0) continue;

        // One listing per repo, reused for every workflow: the marker lookup
        // is the same set of issues each time.
        const filed = await filedIssuesFor(repoFullName);

        for (const history of histories) {
          const state = classifyWorkflow(history);

          // Only a repeated failure needs the job and its log, so the
          // expensive calls stay off the healthy path entirely.
          let signature: string | null = null;
          let jobName = "";
          let logExcerpt = "";
          if (state.kind === "repeated-failure") {
            const jobs = await fetchRunJobs(repoFullName, state.latest.id);
            const failing = jobs.find((j) => j.conclusion === "failure");
            if (!failing) {
              skipped.push({
                repo: repoFullName,
                workflow: history.workflowName,
                reason: "run failed but no job reported failure",
              });
              continue;
            }
            jobName = failing.name;
            logExcerpt = await fetchFailedJobLogExcerpt(repoFullName, failing.id).catch(() => "");
            signature = computeFailureSignature({
              repoFullName,
              workflowName: history.workflowName,
              jobName,
              logExcerpt,
            });
          }

          const action = decideAction(state, signature, filed, history.workflowName);
          if (action.action === "none") {
            skipped.push({
              repo: repoFullName,
              workflow: history.workflowName,
              reason: action.reason,
            });
            continue;
          }

          if (action.action === "close") {
            const green = state.kind === "healthy" ? state.latest : null;
            if (!green) continue;
            await addIssueComment(repoFullName, action.issueNumber, buildCloseComment(green));
            await closeIssue(repoFullName, action.issueNumber);
            closedIssues.push({
              repo: repoFullName,
              number: action.issueNumber,
              workflow: history.workflowName,
            });
            continue;
          }

          if (state.kind !== "repeated-failure") continue;

          // Re-ask "is this already filed?" against a FRESH listing, because
          // `filed` was taken before any of this pass's work and a duplicate
          // is unrecoverable once created. dispatch#961 saw two byte-identical
          // issues for one signature filed 8.5h apart while the first stayed
          // open, which means the earlier listing was incomplete for a reason
          // the code cannot see. This guard does not need to know why.
          //
          // Fail CLOSED: if the re-listing itself fails we skip filing. A
          // missed filing is retried on the next pass 30 minutes later; a
          // duplicate costs a coder run and has to be closed by hand.
          let recheck: FiledIssue[] | null = null;
          try {
            recheck = await filedIssuesFor(repoFullName);
          } catch (e) {
            skipped.push({
              repo: repoFullName,
              workflow: history.workflowName,
              reason: `could not re-verify before filing: ${String(e)}`,
            });
            continue;
          }
          const duplicateOf = hasOpenIssueForSignature(recheck, action.signature);
          if (duplicateOf !== null) {
            skipped.push({
              repo: repoFullName,
              workflow: history.workflowName,
              reason: `already filed as #${duplicateOf} (caught on re-verify)`,
            });
            continue;
          }

          // CVE/scan blockers are a different kind of failure: the fix is
          // only verifiable by rebuilding the image and re-running the
          // scanner, so the issue carries parsed findings and the
          // reproduce-and-verify instructions, and the type/security label
          // keeps it on the escalation lane through grooming (#988).
          const kind: FailureKind | undefined = isScanFailure(
            history.workflowName,
            jobName,
            logExcerpt,
          )
            ? "scan"
            : undefined;
          const findings = kind === "scan" ? parseScanFindings(logExcerpt) : [];

          const draft = buildIssueDraft({
            repoFullName,
            workflowName: history.workflowName,
            jobName,
            signature: action.signature,
            latest: state.latest,
            previous: state.previous,
            logExcerpt,
            supersedes: action.supersedes,
            kind,
            findings,
          });
          const created = await createIssue(repoFullName, {
            title: draft.title,
            body: draft.body,
            labels: issueLabels(kind),
          });
          // Keep the local view current so a second workflow in the same repo
          // with the same signature does not file a duplicate in this pass.
          filed.push({
            number: created.number,
            state: "open",
            signature: action.signature,
            workflowName: history.workflowName,
          });
          filedIssues.push({
            repo: repoFullName,
            number: created.number,
            workflow: history.workflowName,
          });
        }
      } catch (error) {
        // Per-repo isolation: one unreachable repo must not abort the pass.
        errors.push({ repo: repoFullName, error: String(error) });
      }
    }
  } finally {
    if (lock && lock.locked) {
      await releaseLock(lock.runId).catch(() => undefined);
    }
  }

  return NextResponse.json({
    filed: filedIssues,
    closed: closedIssues,
    skipped,
    errors,
  });
}
