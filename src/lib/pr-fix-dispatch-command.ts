/**
 * The `/dispatch-fix` PR comment command (#1622): a per-PR operator handoff
 * of a human-authored PR into the pr-fix queue.
 *
 * Human-authored PRs are invisible to the pr-fix ingestion by design —
 * `isAllowedBotAuthor` gates both the pull-scan and the webhook so the loop
 * only ever auto-fixes AI-authored PRs. Handing one of your own PRs to the
 * fix loop therefore used to be a two-step, raw-API process: swap the linked
 * issue's `agent/` label, then hand-construct a `POST
 * /api/pr-fix-queue/enqueue` call with the review body as feedback. This
 * command performs exactly that handoff from a PR thread: explicit, per-PR,
 * never a blanket identity grant, audited with the commenter as actor.
 *
 * The ingestion gate stays absolute: a human-authored PR is never
 * auto-ingested. The command is the ONLY path that turns a human PR into
 * queue work, and it only acts when an authenticated human (the PR author or
 * a repo admin/maintainer) posts the command on that PR.
 *
 * Ordering guarantee (#1622, review M2): the optional `lane=<profile>`
 * agent-label swap happens BEFORE the enqueue, and its result is MIRRORED
 * INTO the Prisma `Issue.labels` cache before `enqueuePrFixItem` runs.
 * `enqueuePrFixItem` resolves the row's ORIGINAL CLAIMANT once, at creation,
 * from the cached `Issue.labels`/lease state (#1569 — it never reads
 * GitHub), and a recorded claimant is never transferred by re-ingestion —
 * so the cache, not just GitHub, must already show the post-swap label when
 * the enqueue reads the issue, or the row would be frozen with the pre-swap
 * owner and the operator's lane reassignment would never reach the queue.
 * (Precedent: the claim route mirrors its label change into the cache the
 * same way.) GitHub's own labeled/unlabeled deliveries later re-confirm the
 * same state.
 */

import { asPrFixQueueClient, prisma } from "@/lib/prisma";
import {
  addIssueComment,
  addIssueLabel,
  fetchCollaboratorPermission,
  fetchIssueLabels,
  removeIssueLabel,
  repoLabelExists,
} from "@/lib/github-issues";
import {
  fetchPullRequestDetail,
  fetchPullRequestReviews,
  type PullRequestReview,
} from "@/lib/github-prs";
import { AGENT_PREFIX, type PrFixStatus } from "@/types";
import { computeEvidenceContentSignature, computeEvidenceVersion } from "@/lib/pr-fix-evidence";
import { enqueuePrFixItem, normalizeQueueRepo } from "@/lib/pr-fix-queue";
import { DISPATCH_FIX_REPLY_MARKER } from "@/lib/pr-fix-surfacing";
import { extractLinkedIssue, isBotIdentity, reviewLane } from "@/lib/pr-followup-ingestion";
import { enforceRateLimit } from "@/lib/rate-limit";

/** The command token a PR comment must start with to be a handoff request. */
const COMMAND = "/dispatch-fix";

/**
 * A lane profile name is interpolated into a GitHub label
 * (`agent/courier-<profile>`), so it is validated strictly before any forge
 * write: lowercase alphanumerics and interior dashes, bounded at 32 chars.
 */
const LANE_PROFILE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,31})$/;

/** The only non-terminal status a repeat command short-circuits on (#1622
 * check 5, review M5): QUEUED means the same work is already pending. The
 * held statuses (BLOCKED/PARKED/WAITING_EXTERNAL) deliberately fall through
 * to `enqueuePrFixItem`, whose evidence-driven recovery decision (#1253)
 * owns reactivation — fresh actionable evidence from a genuinely new review
 * round must be able to revive a held row, and its `hold` arm already
 * refuses to reopen a human-decision BLOCKED. */
const DUPLICATE_BLOCKING_STATUS: PrFixStatus = "QUEUED";

/**
 * Comment-loop bounds (#1622): a command that keeps failing eligibility
 * would otherwise reply to itself in an unbounded loop with the repo's
 * automation. 3 commands per (actor, PR) per minute is far above any
 * legitimate use — a human posts one, maybe corrects it once — and far
 * below a feedback loop's cadence.
 */
const COMMAND_RATE_LIMIT = { limit: 3, windowMs: 60_000 } as const;

/**
 * Parse a comment body into a `/dispatch-fix` command.
 *
 * Returns null when the body is not a command at all (the webhook then lets
 * the comment flow into ordinary ingestion). Returns `{ ok: false, reason }`
 * for a command that parsed but carries unusable arguments — the caller must
 * refuse these and post the reason (review M1: silently ignoring a bad
 * `lane=` argument would enqueue the PR while the operator believes the lane
 * was applied) — and `{ ok: true, lane? }` for a usable one. `lane` is the
 * optional lane profile: `/dispatch-fix` alone enqueues the fix item;
 * `lane=hyper` also reassigns the linked issue's agent label to
 * `agent/courier-hyper`.
 */
export function parseDispatchFixCommand(
  body: string | null | undefined,
): { ok: true; lane?: string } | { ok: false; reason: string } | null {
  if (!body) return null;
  // Collapse newlines so the command and its argument may be split across
  // lines (`/dispatch-fix\nlane=hyper`).
  const trimmed = body.trim().replace(/\s+/g, " ");
  if (trimmed !== COMMAND && !trimmed.startsWith(`${COMMAND} `)) return null;
  const rest = trimmed.slice(COMMAND.length).trim();
  if (!rest) return { ok: true };
  const match = rest.match(/^lane=([^\s]+)$/);
  if (!match) {
    return { ok: false, reason: "Unrecognized arguments — expected `/dispatch-fix` or `/dispatch-fix lane=<profile>`." };
  }
  const lane = match[1];
  if (!LANE_PROFILE_PATTERN.test(lane)) {
    return {
      ok: false,
      reason: `Invalid lane profile \`${lane}\` — use lowercase letters, digits and dashes (max 32 chars), e.g. \`lane=hyper\`.`,
    };
  }
  return { ok: true, lane };
}

/**
 * A review's submission time as a sortable epoch. An unparseable timestamp
 * sorts as "oldest" rather than poisoning the ordering with NaN: every NaN
 * comparison is false, so a NaN timestamp would make the per-user selection
 * keep the FIRST review seen for that user instead of their newest — the
 * selection rule the standing-request decision depends on (#1636).
 */
function parseSubmittedAt(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The aggregate review decision over a PR's reviews — the same shape and the
 * same dismissal semantics as `deriveReviewDecision` in github-prs.ts (#1636):
 * a DISMISSED review is IGNORED outright, because GitHub's branch-protection
 * rule is "dismissed reviews are ignored; remaining requests still count".
 * Each reviewer's newest NON-dismissed review therefore decides their
 * standing state, and a standing CHANGES_REQUESTED blocks.
 *
 * Two edges this settles, one in each direction:
 * - A withdrawn request still unblocks: GitHub mutates a dismissed review IN
 *   PLACE (state → DISMISSED, same submitted_at), so "the reviewer requested
 *   changes and that request was withdrawn" is a SINGLE record. Ignored as
 *   dismissed, it leaves that reviewer with nothing standing (#1622 review
 *   round 5, M1) — and the withdrawn review's own feedback is never handed
 *   off.
 * - A dismissal of a reviewer's RE-REVIEW no longer masks their older
 *   standing request (#1636): two CHANGES_REQUESTED reviews with the newer
 *   one dismissed leave the older request standing, which is what GitHub
 *   itself would enforce. Refusing that shape was a false refusal.
 */
export function deriveBlockingReview(
  reviews: PullRequestReview[],
  headSha: string | null,
): { review: PullRequestReview; stale: boolean } | null {
  const latestByUser = new Map<string, { review: PullRequestReview; submittedAt: number; blocking: boolean }>();
  for (const review of reviews) {
    const state = review.state?.toUpperCase();
    // DISMISSED is ignored outright (#1636): a dismissed review is neither a
    // standing request of its own nor a supersession of the reviewer's other
    // reviews. COMMENTED never was one.
    if (!review.user || (state !== "APPROVED" && state !== "CHANGES_REQUESTED")) continue;
    const submittedAt = parseSubmittedAt(review.submittedAt);
    const prev = latestByUser.get(review.user);
    if (!prev || submittedAt >= prev.submittedAt) {
      latestByUser.set(review.user, { review, submittedAt, blocking: state === "CHANGES_REQUESTED" });
    }
  }
  const blocking = Array.from(latestByUser.values())
    .filter((entry) => entry.blocking)
    .sort((a, b) => b.submittedAt - a.submittedAt);
  if (blocking.length === 0) return null;
  // A newer CHANGES_REQUESTED anchored to an older head must not mask a
  // current-head request from another reviewer (review round 4, M1): the
  // stale request is evidence against a head that no longer exists, so the
  // newest current-head request wins and stale is reported only when every
  // standing request was written against an earlier head.
  const onCurrentHead = headSha
    ? blocking.filter((entry) => entry.review.commitId === headSha)
    : [];
  const chosen = onCurrentHead[0] ?? blocking[0];
  return { review: chosen.review, stale: onCurrentHead.length === 0 };
}

/** A repo-qualified issue reference (`owner/repo#N`) whose qualifier is not
 * this PR's repo. `extractLinkedIssue` strips the qualifier, so such a
 * reference would resolve to a same-numbered issue of the PR's own repo and
 * the command would enqueue against — and with `lane=` relabel — the WRONG
 * issue (review M4). */
function crossRepoReferences(text: string, repoFullName: string): string[] {
  const refs = text.match(/[\w.-]+\/[\w.-]+#\d+/g) ?? [];
  const lowered = repoFullName.toLowerCase();
  return refs.filter((ref) => ref.slice(0, ref.lastIndexOf("#")).toLowerCase() !== lowered);
}

export interface DispatchFixCommandInput {
  repoFullName: string;
  prNumber: number;
  commenter: string;
  commentBody: string;
}

export type DispatchFixCommandResult = {
  handled: true;
  outcome: "enqueued" | "duplicate" | "refused" | "rate_limited" | "unauthorized" | "error";
  detail: string;
};

/** The cached row's labels with the agent set replaced by `agentSet`,
 * preserving every non-agent label (status/*, priority/*, …). */
function mergeAgentLabels(cachedLabels: string[], agentSet: string[]): string[] {
  return [...cachedLabels.filter((label) => !label.startsWith(AGENT_PREFIX)), ...agentSet];
}

/** Order-insensitive set equality for label lists. */
function sameLabelSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((label) => b.includes(label));
}

/**
 * Mirror the authoritative agent-label set into the cached Issue row so the
 * claimant resolution the enqueue is about to run (#1569 — it reads the
 * cache, never GitHub) sees the post-swap owner. The write is a CAS against
 * the snapshot the eligibility check read; a lost race re-reads and retries,
 * and if the cache still does not show the post-swap agent set after the
 * bounded retries, the mirror is written unconditionally: this command
 * authored the authoritative label state on GitHub moments before, and
 * enqueueing against a stale cached claimant (review M1, second round) is
 * worse than clobbering a concurrent label edit in the tiny window — note
 * the fallback replaces the WHOLE agent set, so it deliberately wins over a
 * concurrent agent-label assignment too (review round 3, minor 3). A
 * vanished row or a failing write throws into the caller's outer catch —
 * the command replies and enqueues nothing.
 */
async function mirrorAgentLabelSet(issueId: string, agentSet: string[], snapshot: string[]): Promise<void> {
  let base = snapshot;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { count } = await prisma.issue.updateMany({
      where: { id: issueId, labels: { equals: base } },
      data: { labels: mergeAgentLabels(base, agentSet) },
    });
    if (count > 0) return;
    const fresh = await prisma.issue.findFirst({ where: { id: issueId }, select: { labels: true } });
    if (!fresh) break;
    // A concurrent label delivery (e.g. the webhook echo of this very swap)
    // may have already refreshed the cache to the post-swap state — then
    // the mirror is done without another write.
    const freshAgent = (fresh.labels ?? []).filter((label) => label.startsWith(AGENT_PREFIX));
    if (sameLabelSet(freshAgent, agentSet)) return;
    base = fresh.labels ?? [];
  }
  const fresh = await prisma.issue.findFirst({ where: { id: issueId }, select: { labels: true } });
  await prisma.issue.update({
    where: { id: issueId },
    data: { labels: mergeAgentLabels(fresh?.labels ?? [], agentSet) },
  });
}

/** Sentinel for a command result the caller only logs. */
function result(
  outcome: DispatchFixCommandResult["outcome"],
  detail: string,
): DispatchFixCommandResult {
  return { handled: true, outcome, detail };
}

/**
 * Handle one `/dispatch-fix` PR comment. Never throws: every failure either
 * replies on the PR thread or is logged and returned as a result, so the
 * webhook route can return 200 and GitHub does not redeliver into a
 * duplicate enqueue.
 */
export async function handleDispatchFixCommand(input: DispatchFixCommandInput): Promise<DispatchFixCommandResult> {
  const { repoFullName, prNumber, commenter, commentBody } = input;
  // The linked issue's agent-label state as this command observed and (if
  // the lane swap ran) changed it — read by the catch below so a failure
  // after a landed swap audits the real label columns.
  let trackedBeforeLabels: string[] = [];
  let trackedAfterLabels: string[] = [];
  // Set the moment `enqueuePrFixItem` resolves. A failure AFTER this point
  // (queue count, confirmation reply, success audit) must never be reported
  // as "nothing was enqueued" — the queue row exists — and must never skip
  // the audit because a reply failed (review round 8, major 1). The row
  // fields let the degraded reply report what actually landed.
  let enqueued: {
    evidenceKey: string;
    linkedIssue: number;
    beforeLabels: string[];
    afterLabels: string[];
    lane: string;
    status: string;
    claimant: string | null;
    claimantSource: string | null;
    laneSwap: string;
  } | null = null;
  // Whether the confirmation reply (or any reply) already reached the
  // thread after the enqueue: the degraded failure reply is skipped when
  // one did, so a failing success-audit cannot post a second, seemingly
  // contradictory comment (review round 8, minor).
  let postedAfterEnqueue = false;
  const parsed = parseDispatchFixCommand(commentBody);
  // Not a command — the route never calls here without a parse first, but a
  // null here keeps the contract total.
  if (!parsed) return result("refused", "not a command");

  try {
    // Rate limit per actor + PR before any read or forge write (#1622).
    const limited = enforceRateLimit(`dispatch-fix-command:${repoFullName}#${prNumber}:${commenter}`, COMMAND_RATE_LIMIT);
    if (limited) {
      await replyUnlessBot(commenter, repoFullName, prNumber, "Rate limit reached for `/dispatch-fix` on this PR — try again in a minute.");
      await auditCommand(repoFullName, null, commenter, false, "rate limited");
      return result("rate_limited", "rate limited");
    }

    // A malformed command is refused with its reason, never silently
    // de-argued into a laneless enqueue (review M1).
    if (!parsed.ok) {
      await replyUnlessBot(commenter, repoFullName, prNumber, `\`/dispatch-fix\` refused: ${parsed.reason}`);
      await auditCommand(repoFullName, null, commenter, false, parsed.reason);
      return result("refused", parsed.reason);
    }

    // Only work for repos Dispatch tracks (review m6): an untracked repo has
    // no issue cache to verify the linked issue against, and its full_name
    // would be interpolated raw into every forge URL below.
    const normalizedRepo = normalizeQueueRepo(repoFullName);
    const trackedRepo = await prisma.repository.findUnique({ where: { fullName: repoFullName } });
    if (!trackedRepo) {
      await replyUnlessBot(commenter, repoFullName, prNumber, `\`/dispatch-fix\` refused: ${repoFullName} is not tracked by this Dispatch instance.`);
      await auditCommand(repoFullName, null, commenter, false, "repo not tracked");
      return result("refused", "repo not tracked");
    }

    // Read the PR once; every eligibility check below runs against this
    // snapshot. Unavailable forge state is an error, not a refusal: the
    // command posts a retryable notice rather than a verdict.
    const prDetail = await fetchPullRequestDetail(repoFullName, prNumber);
    if (!prDetail) {
      await replyUnlessBot(commenter, repoFullName, prNumber, "`/dispatch-fix` failed: the PR's current state could not be read from GitHub — nothing was enqueued. Retry later.");
      await auditCommand(repoFullName, null, commenter, false, "PR detail unavailable");
      return result("error", "PR detail unavailable");
    }

    // Authorization: the PR author, or a repo admin/maintainer — the same
    // operator tier that may call the enqueue endpoint directly. The
    // webhook payload's commenter login is GitHub-attested (HMAC-verified
    // delivery), so no additional token identity is involved. Fail closed
    // on a permission-lookup error: an unreadable permission never
    // authorizes a handoff.
    const isAuthor = !!prDetail.author && prDetail.author === commenter;
    let isOperator = false;
    if (!isAuthor) {
      const permission = await fetchCollaboratorPermission(repoFullName, commenter);
      isOperator = permission.status === "ok" && (permission.permission === "admin" || permission.permission === "maintain");
      if (!isOperator) {
        await replyUnlessBot(
          commenter,
          repoFullName,
          prNumber,
          "`/dispatch-fix` refused: only the PR author or a repo admin/maintainer can hand this PR to the fix loop.",
        );
        await auditCommand(repoFullName, null, commenter, false, "unauthorized");
        return result("unauthorized", `permission=${permission.status === "ok" ? permission.permission : permission.status}`);
      }
    } else if (parsed.lane) {
      // The lane swap rewrites the linked issue's assignment (review M6), a
      // repo-visible ownership mutation an unprivileged PR author must not
      // perform. A lookup failure counts as NOT operator (fail closed).
      const permission = await fetchCollaboratorPermission(repoFullName, commenter);
      isOperator = permission.status === "ok" && (permission.permission === "admin" || permission.permission === "maintain");
    }

    // Eligibility check 1 (#1622): open, not merged, not draft — mirroring
    // the requeue path's merged/closed refusal.
    if (prDetail.state !== "open" || prDetail.mergedAt) {
      await replyUnlessBot(commenter, repoFullName, prNumber, `\`/dispatch-fix\` refused: this PR is ${prDetail.mergedAt ? "merged" : (prDetail.state ?? "closed")} — nothing to fix.`);
      await auditCommand(repoFullName, null, commenter, false, `pr not open (state=${prDetail.state}, merged=${!!prDetail.mergedAt})`);
      return result("refused", "pr not open");
    }
    if (prDetail.draft) {
      await replyUnlessBot(commenter, repoFullName, prNumber, "`/dispatch-fix` refused: this PR is a draft — mark it ready for review first.");
      await auditCommand(repoFullName, null, commenter, false, "pr is draft");
      return result("refused", "pr is draft");
    }

    // Fork PRs are refused (review m10): the item's `branch` would name a
    // branch of the fork while the fix worker would operate on the base
    // repo, where the same branch name usually does not exist. When the
    // head repository is unavailable (`head.repo.full_name = null`, e.g. a
    // deleted fork) the base-repo ownership of the branch cannot be
    // verified at all — fail closed rather than accept (review M6).
    if (!prDetail.headRepoFullName) {
      await replyUnlessBot(
        commenter,
        repoFullName,
        prNumber,
        "`/dispatch-fix` refused: the PR's head repository could not be verified (likely a deleted or inaccessible fork) — the fix loop only works on branches of the base repository. Re-open the PR from a base-repo branch and retry.",
      );
      await auditCommand(repoFullName, null, commenter, false, "head repo unverifiable (deleted or inaccessible)");
      return result("refused", "head repo unverifiable (deleted or inaccessible)");
    }
    if (prDetail.headRepoFullName.toLowerCase() !== repoFullName.toLowerCase()) {
      await replyUnlessBot(commenter, repoFullName, prNumber, `\`/dispatch-fix\` refused: this PR comes from a fork (\`${prDetail.headRepoFullName}\`) — the fix loop only works on branches of the base repository.`);
      await auditCommand(repoFullName, null, commenter, false, `fork PR (head repo ${prDetail.headRepoFullName})`);
      return result("refused", "fork pr");
    }

    // Eligibility check 2 (#1622): the latest substantive review on the
    // CURRENT head must be CHANGES_REQUESTED. Evidence-keyed feedback
    // against a stale head would park after one attempt.
    const reviews = await fetchPullRequestReviews(repoFullName, prNumber);
    if (!reviews) {
      await replyUnlessBot(commenter, repoFullName, prNumber, "`/dispatch-fix` failed: the PR's reviews could not be read from GitHub — nothing was enqueued. Retry later.");
      await auditCommand(repoFullName, null, commenter, false, "reviews unavailable");
      return result("error", "reviews unavailable");
    }
    const blocking = deriveBlockingReview(reviews, prDetail.headSha);
    if (!blocking) {
      await replyUnlessBot(commenter, repoFullName, prNumber, "`/dispatch-fix` refused: no pending CHANGES_REQUESTED review on this PR.");
      await auditCommand(repoFullName, null, commenter, false, "no changes-requested review");
      return result("refused", "no changes-requested review");
    }
    if (blocking.stale) {
      await replyUnlessBot(
        commenter,
        repoFullName,
        prNumber,
        `\`/dispatch-fix\` refused: the CHANGES_REQUESTED review is stale — it was written against an earlier head (\`${(blocking.review.commitId ?? "unknown").slice(0, 8)}\`, current head \`${(prDetail.headSha ?? "unknown").slice(0, 8)}\`). Push or re-review first.`,
      );
      await auditCommand(repoFullName, null, commenter, false, "review stale (older head)");
      return result("refused", "review stale");
    }
    const review = blocking.review;
    // An empty review body carries nothing to hand off (review m11): the
    // operator gets a legible refusal instead of a work item whose only
    // feedback entry is "".
    const reviewBody = review.body ?? "";
    if (!reviewBody.trim()) {
      await replyUnlessBot(commenter, repoFullName, prNumber, "`/dispatch-fix` refused: the CHANGES_REQUESTED review carries no written feedback — nothing to hand off.");
      await auditCommand(repoFullName, null, commenter, false, "empty review body");
      return result("refused", "empty review body");
    }

    // Eligibility check 3 (#1622): exactly one linked issue. More than one
    // distinct `#N` reference in the title/body is ambiguous — the handoff
    // would have to guess which issue owns the work and which one the
    // `lane=` label swap reassigns — and a reference qualified with another
    // repository is refused outright (review M4).
    const linkageText = [prDetail.title, prDetail.body].filter(Boolean).join("\n");
    const crossRepo = crossRepoReferences(linkageText, repoFullName);
    if (crossRepo.length > 0) {
      await replyUnlessBot(
        commenter,
        repoFullName,
        prNumber,
        `\`/dispatch-fix\` refused: the PR references an issue in another repository (${Array.from(new Set(crossRepo)).join(", ")}) — reference an issue of \`${repoFullName}\` only.`,
      );
      await auditCommand(repoFullName, null, commenter, false, "cross-repo issue reference");
      return result("refused", "cross-repo issue reference");
    }
    const distinctRefs = new Set(linkageText.match(/#(\d+)/g) ?? []);
    if (distinctRefs.size > 1) {
      await replyUnlessBot(
        commenter,
        repoFullName,
        prNumber,
        `\`/dispatch-fix\` refused: ambiguous issue linkage — the PR references ${Array.from(distinctRefs).join(", ")}. Reference exactly one issue.`,
      );
      await auditCommand(repoFullName, null, commenter, false, "ambiguous linked issue");
      return result("refused", "ambiguous linked issue");
    }
    const linkedIssue = extractLinkedIssue({ title: prDetail.title, body: prDetail.body });
    if (!linkedIssue) {
      await replyUnlessBot(commenter, repoFullName, prNumber, "`/dispatch-fix` refused: no linked issue found — reference the issue in the PR title or body (e.g. `Fixes #123`).");
      await auditCommand(repoFullName, null, commenter, false, "no linked issue");
      return result("refused", "no linked issue");
    }

    // Eligibility check 4 (#1622): at most one `agent/*` label on the
    // linked issue, read from GitHub (the authoritative label state —
    // review M3: the Prisma cache lags the forge and a stale read here
    // would produce a two-label issue, whose claimant resolution is
    // "ambiguous" and which the ownership gate refuses in every mode).
    // The issue must also exist as a real issue of this repo: an uncached
    // one cannot be verified (review M4).
    const cachedIssue = await prisma.issue.findFirst({
      where: { repository: { fullName: { equals: normalizedRepo, mode: "insensitive" } }, number: linkedIssue },
      select: { id: true, labels: true },
    });
    if (!cachedIssue) {
      await replyUnlessBot(commenter, repoFullName, prNumber, `\`/dispatch-fix\` refused: linked issue #${linkedIssue} is not in Dispatch's issue cache yet — wait for the next sync and retry.`);
      await auditCommand(repoFullName, linkedIssue, commenter, false, "linked issue not cached");
      return result("refused", "linked issue not cached");
    }
    const issueLabels = await fetchIssueLabels(repoFullName, linkedIssue);
    if (!issueLabels) {
      await replyUnlessBot(commenter, repoFullName, prNumber, `\`/dispatch-fix\` failed: the linked issue's labels could not be read from GitHub — nothing was enqueued. Retry later.`);
      await auditCommand(repoFullName, linkedIssue, commenter, false, "linked issue labels unavailable");
      return result("error", "linked issue labels unavailable");
    }
    const agentLabels = issueLabels.filter((label) => label.startsWith(AGENT_PREFIX));
    trackedBeforeLabels = agentLabels;
    trackedAfterLabels = agentLabels;
    if (agentLabels.length > 1) {
      await replyUnlessBot(
        commenter,
        repoFullName,
        prNumber,
        `\`/dispatch-fix\` refused: linked issue #${linkedIssue} carries multiple agent labels (${agentLabels.join(", ")}) — resolve the assignment first.`,
      );
      await auditCommand(repoFullName, linkedIssue, commenter, false, "multiple agent labels on linked issue");
      return result("refused", "multiple agent labels");
    }

    // Eligibility check 5 (#1622, narrowed by review M5): only an already
    // QUEUED item is reported as a duplicate. Held rows fall through so
    // the enqueue's evidence-driven recovery decision (#1253) can revive
    // them, and terminal tombstones are the enqueue's own recovery rules.
    const existingItem = await prisma.prFixQueueItem.findUnique({
      where: { repo_pr: { repo: normalizedRepo, pr: prNumber } },
    });
    if (existingItem && existingItem.status === DUPLICATE_BLOCKING_STATUS) {
      await replyUnlessBot(
        commenter,
        repoFullName,
        prNumber,
        `\`/dispatch-fix\`: this PR already has a QUEUED pr-fix queue item (lane ${existingItem.lane}) — not enqueueing a duplicate.`,
      );
      await auditCommand(repoFullName, linkedIssue, commenter, false, `duplicate (item status=QUEUED lane=${existingItem.lane})`);
      return result("duplicate", "existing item status=QUEUED");
    }

    // The lane reassignment (#1622), performed BEFORE the enqueue so the
    // claimant resolution at creation (#1569) sees the post-swap label
    // (review M2). Restricted to the operator tier (review M6): a PR author
    // without admin/maintain rights may hand off their own PR but not
    // rewrite the linked issue's assignment. The multi-label state was
    // already refused above, so the swap is: remove the one other `agent/*`
    // label if any, add the target, then converge the Prisma cache to the
    // authoritative GitHub set (the verify-and-mirror step right before the
    // enqueue) — the enqueue's claimant resolution reads the cache, not
    // GitHub (review M2 second round), and a recorded claimant is never
    // re-resolved later.
    let laneSwap = "";
    let afterLabels = agentLabels;
    if (parsed.lane) {
      const targetLabel = `${AGENT_PREFIX}courier-${parsed.lane}`;
      if (!agentLabels.includes(targetLabel) && !isOperator) {
        laneSwap = ` (note: \`lane=${parsed.lane}\` was NOT applied — reassigning the linked issue's agent label requires a repo admin/maintainer.)`;
      } else if (!agentLabels.includes(targetLabel)) {
        // Managed-label gate (review round 5, M2): the swap only ever
        // assigns a label the repository already declares — it never
        // mints a new `agent/courier-<profile>` label, so the assignable
        // label space stays exactly the operator-declared set (e.g. via
        // `.github/labels.yaml` label sync) instead of proliferating with
        // every profile name a commenter tries. The check runs BEFORE the
        // removals so a missing label leaves the issue's assignment
        // untouched; an unreadable check is retryable, not a refusal.
        const labelExists = await repoLabelExists(repoFullName, targetLabel);
        if (labelExists === null) {
          await replyUnlessBot(
            commenter,
            repoFullName,
            prNumber,
            `\`/dispatch-fix\` failed: the label \`${targetLabel}\` could not be checked on GitHub — nothing was enqueued. Retry later.`,
          );
          await auditCommand(repoFullName, linkedIssue, commenter, false, "lane label check unavailable");
          return result("error", "lane label check unavailable");
        }
        if (!labelExists) {
          await replyUnlessBot(
            commenter,
            repoFullName,
            prNumber,
            `\`/dispatch-fix\` refused: the label \`${targetLabel}\` does not exist in this repository — declare it first (e.g. via \`.github/labels.yaml\`), then retry. Nothing was enqueued.`,
          );
          await auditCommand(repoFullName, linkedIssue, commenter, false, "lane label not declared");
          return result("refused", "lane label not declared");
        }
        const others = agentLabels.filter((l) => l !== targetLabel);
        try {
          // Remove the old agent label BEFORE adding the target (review
          // M2, second round): the issue then holds at most one agent
          // label at every moment of the swap. Add-first would leave TWO
          // agent labels when a removal failed — a state whose claimant
          // resolution is "ambiguous" and which the ownership gate refuses
          // in every mode — while a remove-first failure leaves zero or
          // one label, both recoverable and unambiguous.
          for (const label of others) {
            await removeIssueLabel(repoFullName, linkedIssue, label);
          }
          afterLabels = [];
          trackedAfterLabels = afterLabels;
          await addIssueLabel(repoFullName, linkedIssue, targetLabel);
          afterLabels = [targetLabel];
          trackedAfterLabels = afterLabels;
          laneSwap = others.length > 0
            ? ` Linked issue #${linkedIssue} reassigned ${others.join(", ")} → ${targetLabel}.`
            : ` Linked issue #${linkedIssue} assigned ${targetLabel}.`;
        } catch (error) {
          // The swap failed: do NOT enqueue. A row created now would freeze
          // its claimant on the pre-swap label state (review M2). The audit
          // reflects the PARTIAL swap result (review MINOR-2): `afterLabels`
          // tracks exactly what landed — removals only (`[]`), or nothing —
          // and the reply names labels already removed, so the operator can
          // restore the assignment (review round 3, minor 4).
          const removedNote = afterLabels.length === 0 && agentLabels.length > 0
            ? ` The previous agent label ${agentLabels.join(", ")} was already removed from the issue.`
            : "";
          console.error(`[/dispatch-fix] agent-label swap failed for ${repoFullName}#${linkedIssue}:`, error);
          await replyUnlessBot(
            commenter,
            repoFullName,
            prNumber,
            `\`/dispatch-fix\` failed: the agent-label swap to \`${targetLabel}\` did not fully land — nothing was enqueued.${removedNote} Check that the \`${targetLabel}\` label exists in this repository, then retry the command.`,
          );
          await auditCommand(repoFullName, linkedIssue, commenter, false, "agent-label swap failed; nothing enqueued", undefined, agentLabels, afterLabels);
          return result("error", "agent-label swap failed");
        }
      }
    }

    // Verify-and-mirror (review M1, second round; hoisted in round 3 so it
    // covers EVERY enqueue path — plain `/dispatch-fix`, landed swap, and
    // already-on-target): the enqueue's claimant resolution reads the cached
    // `Issue.labels` only, so the cached agent set must match the
    // authoritative GitHub set before the enqueue runs. Re-read the cache
    // here (a concurrent sync/webhook writer may have moved it since the
    // eligibility check) and converge when it lags; the re-read also shrinks
    // — without closing — the window between the mirror and the enqueue's
    // own claimant read (review round 3, minor 5).
    const cachedNow = await prisma.issue.findFirst({ where: { id: cachedIssue.id }, select: { labels: true } });
    const cachedAgentNow = (cachedNow?.labels ?? []).filter((l) => l.startsWith(AGENT_PREFIX));
    if (!sameLabelSet(cachedAgentNow, afterLabels)) {
      await mirrorAgentLabelSet(cachedIssue.id, afterLabels, cachedNow?.labels ?? []);
    }

    // Enqueue through the same path the operator endpoint uses (#1622):
    // identical validation, the full review body as feedback, a
    // deterministic evidence key, and ledger fields mirroring the review
    // ingestion projection so a replayed command is inert. No claimant is
    // passed — `enqueuePrFixItem` resolves the original claimant itself
    // (#1569), from the mirrored post-swap cache state.
    //
    // Evidence-key shape (#1622, issue-pinned): `pr-review:<pr>:<head8>` is
    // per-(PR, head) rather than the ingestion path's per-review
    // `review:<repo>#<pr>:<reviewId>`. This is deliberate: the command
    // hands off "the current blocking review state of this PR at this
    // head" — a per-head baseline, not a per-review-object history — so
    // two distinct CHANGES_REQUESTED reviews on the same head are ONE
    // evidence identity here (their version `state=…|commit=…` is equal,
    // so a re-run is inert rather than a second attempt). The trade-off is
    // that the command's evidence never reactivates a held row on its own;
    // the enqueue's recovery decision only sees it as fresh when the head
    // has moved — which is exactly when a genuinely new review round
    // exists. The `pr-review:` prefix is also not a recognized post-dispatch
    // evidence kind, but that path is unreachable from this command: its
    // own QUEUED dedupe refuses any enqueue onto an already-queued row
    // before a post-dispatch entry could ever be recorded.
    const headSha = prDetail.headSha ?? "";
    const evidenceKey = `pr-review:${prNumber}:${headSha.slice(0, 8)}`;
    const item = await enqueuePrFixItem(asPrFixQueueClient(prisma), {
      repo: repoFullName,
      pr: prNumber,
      issue: linkedIssue,
      lane: reviewLane(reviewBody),
      type: "REVIEW_FEEDBACK",
      reason: "PR review: CHANGES_REQUESTED (operator handoff via /dispatch-fix)",
      feedback: reviewBody,
      evidenceKey,
      branch: prDetail.headRef,
      url: prDetail.htmlUrl,
      title: prDetail.title,
      headSha: prDetail.headSha,
      author: prDetail.author,
      evidenceKind: "review",
      evidenceVersion: computeEvidenceVersion("review", { state: "CHANGES_REQUESTED", commitId: review.commitId }),
      evidenceContentSignature: computeEvidenceContentSignature({
        body: reviewBody,
        actorLogin: review.user,
        state: "CHANGES_REQUESTED",
        commitId: review.commitId,
      }),
      evidenceObservedAt: review.submittedAt,
      evidenceActionable: true,
      evidenceHeadSha: prDetail.headSha,
      evidenceSource: "webhook",
    });
    enqueued = {
      evidenceKey,
      linkedIssue,
      beforeLabels: agentLabels,
      afterLabels,
      lane: item.lane,
      status: item.status,
      claimant: item.claimant ?? null,
      claimantSource: item.claimantSource ?? null,
      laneSwap,
    };

    // Confirmation reply (#1622): legible handover — where the item landed,
    // (for lane swaps) which agent profile now owns the linked issue, and
    // the claimant the ownership gate will see, REPORTED FROM THE ROW THE
    // ENQUEUE RETURNED rather than predicted from labels: the resolution
    // precedence (live lease, owner labels, #1615 worker-space and
    // rebase-executor rules) and an existing row's never-transferred
    // claimant all live inside `enqueuePrFixItem` (#1569), so only the row
    // knows what the gate will actually see (review round 3, major 1).
    // The queue position is scoped to this repo's lane queue (review m8).
    const queuePosition = await prisma.prFixQueueItem.count({
      where: { repo: normalizedRepo, lane: item.lane, status: "QUEUED" },
    });
    const claimantNote = item.claimant
      ? ` Claimant recorded on the queue row: \`${item.claimant}\` (source: ${item.claimantSource ?? "legacy"}).`
      : " No claimant was recorded on the queue row — the ownership gate will refuse its hand-out until the claimant is resolved.";
    await replyUnlessBot(
      commenter,
      repoFullName,
      prNumber,
      `\`/dispatch-fix\` handed this PR to the fix loop: queue item is \`${item.status}\` on queue lane \`${item.lane}\` (position ${queuePosition} in that queue), evidence \`${evidenceKey}\`.${laneSwap}${claimantNote}`,
    );
    postedAfterEnqueue = true;
    await auditCommand(
      repoFullName,
      linkedIssue,
      commenter,
      true,
      null,
      `pr=${prNumber} queueLane=${item.lane} laneProfile=${parsed.ok && parsed.lane ? parsed.lane : "-"} source=/dispatch-fix evidence=${evidenceKey}`,
      agentLabels,
      afterLabels,
    );
    return result("enqueued", `item status=${item.status} lane=${item.lane}`);
  } catch (error) {
    // Never throw: report on the thread (best-effort — a failing forge read
    // must not mask the original failure) and leave a failure audit row
    // (#1622 audit, review m1). The audit's label columns reflect what this
    // command actually did before failing: a failure AFTER a landed
    // lane swap audited with empty labels would misstate a repo-visible
    // ownership mutation (review MINOR-2).
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[/dispatch-fix] command failed for ${repoFullName}#${prNumber}:`, error);
    if (enqueued) {
      // The enqueue LANDED; only a post-enqueue step (queue count,
      // confirmation reply, or the success audit) failed. Reporting
      // "nothing was enqueued" here would be false — the queue row exists
      // and a blind re-run is refused as a duplicate — and the audit must
      // not depend on the reply: reply and audit are attempted
      // independently, so a failing reply can never suppress the audit row
      // (review round 8, major 1). The row audits success (the enqueue is
      // the command's core action) with the follow-up failure in
      // errorMessage/notes so failure counters and filters stay honest.
      if (!postedAfterEnqueue) {
        const claimantNote = enqueued.claimant
          ? ` Claimant recorded on the queue row: \`${enqueued.claimant}\` (source: ${enqueued.claimantSource ?? "legacy"}).`
          : " No claimant was recorded on the queue row — the ownership gate will refuse its hand-out until the claimant is resolved.";
        try {
          await replyUnlessBot(
            commenter,
            repoFullName,
            prNumber,
            `\`/dispatch-fix\` handed this PR to the fix loop: queue item is \`${enqueued.status}\` on queue lane \`${enqueued.lane}\`, evidence \`${enqueued.evidenceKey}\`.${enqueued.laneSwap}${claimantNote} A follow-up step failed after the enqueue — check the pr-fix queue before re-running the command (a re-run is refused while the item is QUEUED).`,
          );
        } catch (replyError) {
          console.error("[/dispatch-fix] post-enqueue failure reply also failed:", replyError);
        }
      }
      try {
        await auditCommand(
          repoFullName,
          enqueued.linkedIssue,
          commenter,
          true,
          `post-enqueue follow-up failed: ${message}`,
          `pr=${prNumber} item enqueued (status=${enqueued.status} lane=${enqueued.lane}) source=/dispatch-fix evidence=${enqueued.evidenceKey}`,
          enqueued.beforeLabels,
          enqueued.afterLabels,
        );
      } catch (auditError) {
        console.error("[/dispatch-fix] post-enqueue audit write also failed:", auditError);
      }
      return result("error", `enqueued, but the post-enqueue follow-up failed: ${message}`);
    }
    // "Nothing was enqueued" stays true on this path — the catch is only
    // reachable past the swap by an enqueue throw, and the row that throw
    // failed to write cannot exist. Reply and audit are still independent:
    // a failing reply must not suppress the audit row.
    try {
      await replyUnlessBot(commenter, repoFullName, prNumber, `\`/dispatch-fix\` failed with an internal error — nothing was enqueued. Retry later.`);
    } catch (replyError) {
      console.error("[/dispatch-fix] failure reply also failed:", replyError);
    }
    try {
      await auditCommand(
        repoFullName,
        null,
        commenter,
        false,
        message,
        undefined,
        trackedBeforeLabels,
        trackedAfterLabels,
      );
    } catch (auditError) {
      console.error("[/dispatch-fix] failure audit write also failed:", auditError);
    }
    return result("error", message);
  }
}

/** Post a reply comment on the PR (PRs are issues for the comments API). */
async function reply(repoFullName: string, prNumber: number, body: string): Promise<void> {
  // Hidden marker (review round 9, minor): the command's own confirmation or
  // refusal must never be re-ingested as ordinary comment feedback. On a
  // bot-authored PR the reply is attributed to the (bot) PR author and passes
  // the ingestion bot-author gate; the marker routes it to the informational
  // filter instead. It must not be the comment's first bytes, so it can never
  // make a human reply look like a command comment either.
  await addIssueComment(repoFullName, prNumber, `${body}\n\n${DISPATCH_FIX_REPLY_MARKER}`);
}

/**
 * Reply only to humans (#1622): answering another bot's command is how
 * bot-to-bot reply loops start. Every reply — refusal, retryable failure,
 * or confirmation — goes through this guard, so a bot commenter's command
 * is handled silently (the audit row still records the outcome).
 */
async function replyUnlessBot(commenter: string, repoFullName: string, prNumber: number, body: string): Promise<void> {
  if (isBotIdentity(commenter)) return;
  await reply(repoFullName, prNumber, body);
}

/** Audit row in the operator-enqueue shape, with the commenter as actor. */
async function auditCommand(
  repoFullName: string,
  issueNumber: number | null,
  actor: string,
  success: boolean,
  errorMessage: string | null,
  notes?: string,
  beforeLabels: string[] = [],
  afterLabels: string[] = [],
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actor,
      action: "pr_fix_enqueue",
      repoFullName,
      issueNumber,
      success,
      beforeLabels,
      afterLabels,
      ...(errorMessage ? { errorMessage } : {}),
      ...(notes ? { notes } : {}),
    },
  });
}
