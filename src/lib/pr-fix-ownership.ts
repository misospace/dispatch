/**
 * #1569: PR-fix ownership evidence contract.
 *
 * PR-fix work must preserve its OWNING LANE and its ORIGINAL CLAIMANT, and
 * both must be observable separately from the receiving consumer of a
 * hand-out. Dispatch records and exposes the evidence; it never maps
 * claimants to lanes or tiers itself (that binding is the consuming client's
 * own configuration), and it never infers ownership from an agent display
 * name, a prefix, or any per-agent special case.
 *
 * Boundaries (three different identities, one row):
 * - `originalClaimant` — who OWNED the work when the row was ingested.
 * - `author`           — the PR author login (who pushed the branch).
 * - the task's `agentName` — the RECEIVING consumer of THIS hand-out.
 * A new hand-out recipient is not the original claimant; a groomer
 * lane change does not transfer ownership.
 *
 * Provenance of the claimant (resolution order, first match wins):
 * 1. "lease"       — a live `Lease` on the linked issue names the holder.
 * 2. "agent-label" — exactly one distinct `agent/<name>` label on the issue.
 * 3. "owner-label" — exactly one distinct `owner/<name>` label on the issue.
 * 4. "pr-author"   — no linked issue: the PR author login is the fallback
 *                    owner of PR repair work.
 * 5. "operator"    — an explicit operator stamp (recovery path).
 * Failure states:
 * - "ambiguous" — the available sources DISAGREE (a live lease and a
 *   different agent label, two different agent labels, two different owner
 *   labels — the owner conflict parks the row even when a lease or agent
 *   label would otherwise resolve). Conflicting ownership is never resolved
 *   by preference: it parks for recovery.
 * - "missing"   — no source resolved (issue with no lease and no owner/agent
 *   label, or a row with neither issue nor author).
 * - "legacy"    — a row created before this contract (`claimantSource` NULL).
 *   Treated exactly like "missing" for authorization.
 *
 * Authorization rule (fail closed): "missing" / "ambiguous" / "legacy"
 * NEVER authorize an automatic hand-out, in ANY rollout mode, to a
 * declared-lane consumer or to the unfiltered operator poll (#1046).
 * Recovery is explicit: re-ingestion re-resolves while unresolved, an
 * operator requeue re-resolves, or `POST /api/pr-fix-queue/claimant` stamps
 * an identity as "operator".
 *
 * Versioning: the evidence object carries `contract: 1` and rides on the
 * #1532 intake negotiation. A consumer receives it only after declaring and
 * being granted the `pr-ownership-evidence:1` capability — an un-negotiated
 * peer gets the byte-identical legacy payload (safe mixed-version behavior),
 * while a negotiated peer can REQUIRE ownership evidence before accepting a
 * hand-out. The block rides on a granted hand-out only, and the gate refuses
 * an unresolved row in every mode, so a shipped block always names an
 * identity. The queue listing shows a null `originalClaimant` for a row that
 * still needs recovery.
 */

export const PR_FIX_OWNERSHIP_CONTRACT_VERSION = 1 as const;

/** Capability a poll declares to receive + require ownership evidence. */
export const PR_OWNERSHIP_EVIDENCE_CAPABILITY = "pr-ownership-evidence";
export const PR_OWNERSHIP_EVIDENCE_CAPABILITY_VERSION = 1;

/** How a resolved claimant was established. */
export type PrFixClaimantSource =
  | "lease"
  | "agent-label"
  | "owner-label"
  | "pr-author"
  | "operator";

/** Non-resolving states stored in / derived from `claimantSource`. */
export type PrFixOwnershipUnresolved = "missing" | "ambiguous" | "legacy";

export type PrFixOwnershipProvenance = PrFixClaimantSource | PrFixOwnershipUnresolved;

/** The versioned evidence block shipped with a negotiated followup-pr task. */
export interface PrFixOwnershipEvidence {
  contract: typeof PR_FIX_OWNERSHIP_CONTRACT_VERSION;
  /** The row's authoritative owning lane (its `lane` column). */
  owningLane: string;
  /** The original claimant identity; null when unresolved. */
  originalClaimant: string | null;
  provenance: PrFixOwnershipProvenance;
  /**
   * The PR author login (`author` column) when present — the transport
   * identity that authored the branch, kept separate from the claimant.
   */
  prAuthor?: string | null;
}

export const AGENT_LABEL_PREFIX = "agent/";
export const OWNER_LABEL_PREFIX = "owner/";

/** Facts read from authoritative records for one linked issue. */
export interface ClaimantIssueFacts {
  /** Agent named by a LIVE (unexpired) Lease on the linked issue, if any. */
  leaseAgent: string | null;
  /** Names behind `agent/<name>` labels on the linked issue. */
  agentLabelNames: string[];
  /** Names behind `owner/<name>` labels on the linked issue. */
  ownerLabelNames: string[];
}

export type ClaimantResolution =
  | { state: "resolved"; claimant: string; source: PrFixClaimantSource }
  | { state: "ambiguous" }
  | { state: "missing" }
  /**
   * A claimant-fact read FAILED (database/transport error). Deliberately not
   * a persisted state: storing "missing" here would record confident knowledge
   * of an absence that was never observed. Callers write nothing and retry on
   * the next observation.
   */
  | { state: "unavailable" };

/**
 * #1615: resolution options for claimant sources that name a DIFFERENT
 * worker pool. The only exclusion today is the rebase-executor pool
 * (`DISPATCH_REBASE_AGENTS`): a rebase executor is not a fix-work owner, so
 * on a non-REBASE item its name is not ownership evidence from ANY source —
 * an `agent/<name>` label is filtered out, and a live lease held by an
 * excluded name is treated as absent. Resolution falls through to the next
 * source (owner label, then missing) instead of propagating a claimant no
 * fix connector can own; a refusal the operator can recover (a "missing"
 * state takes a stamp) is strictly better than a recorded poison claimant
 * no path can clear. The exclusion compares names case-insensitively (the
 * pool is parsed lowercase).
 */
export interface ClaimantResolutionOptions {
  /** Identity names that must never resolve as the claimant. */
  excludeClaimantNames?: ReadonlySet<string>;
}

function isExcludedClaimant(
  name: string,
  options: ClaimantResolutionOptions | undefined,
): boolean {
  return options?.excludeClaimantNames?.has(name.toLowerCase()) ?? false;
}

/**
 * The durable claimant patch for one ingestion observation, or null when the
 * observation must NOT write: a resolved identity, an honest failure state
 * ("missing" / "ambiguous"), and never a read failure.
 */
export function ingestionClaimantPatch(
  resolution: ClaimantResolution,
): { claimant: string | null; claimantSource: string } | null {
  if (resolution.state === "resolved") {
    return { claimant: resolution.claimant, claimantSource: resolution.source };
  }
  if (resolution.state === "unavailable") return null;
  return { claimant: null, claimantSource: resolution.state };
}

function distinct(names: Iterable<string>): string[] {
  return [...new Set(names)];
}

/**
 * Pure claimant resolution from authoritative issue facts (no Courier
 * knowledge, no per-agent special case):
 * - conflicting owner evidence (two or more distinct owner labels) is
 *   "ambiguous" FIRST, even when a live lease or agent label would otherwise
 *   resolve — a higher source never silently out-votes contradictory
 *   ownership (conflicting ownership never resolves by preference);
 * - live lease + agent labels: every candidate must name the SAME identity,
 *   otherwise "ambiguous";
 * - live lease alone → "lease"; single distinct agent label → "agent-label";
 * - no lease, no agent labels, no owner conflict: a single distinct owner
 *   label → "owner-label";
 * - nothing → "missing".
 *
 * #1615: `options.excludeClaimantNames` removes names from consideration
 * BEFORE every check above — an excluded name is filtered from the agent
 * labels and from the live lease, so it neither resolves nor creates an
 * "ambiguous" disagreement, and resolution falls through to the owner label
 * or "missing".
 *
 * A SINGLE owner label coexisting with a lease/agent identity is category
 * evidence, not a conflict: `owner/*` names the board owner, `agent/*` and
 * the lease name the working claimant (the owner-label source only fires
 * when nothing higher exists).
 */
export function resolveClaimantFromIssueFacts(
  facts: ClaimantIssueFacts,
  options?: ClaimantResolutionOptions,
): ClaimantResolution {
  // #1615: an excluded name (a rebase executor on a non-REBASE item) is NOT
  // ownership evidence at all — the name is filtered from the agent labels
  // AND from the live lease before the agreement checks, so it can neither
  // resolve nor manufacture an ambiguity against the identities that remain.
  const agentLabels = distinct(facts.agentLabelNames).filter(
    (name) => !isExcludedClaimant(name, options),
  );
  const ownerLabels = distinct(facts.ownerLabelNames);
  const leaseCandidate = facts.leaseAgent?.trim() || null;
  const lease = leaseCandidate !== null && !isExcludedClaimant(leaseCandidate, options) ? leaseCandidate : null;

  if (ownerLabels.length > 1) return { state: "ambiguous" };

  if (lease !== null && agentLabels.length > 0) {
    const candidates = distinct([lease, ...agentLabels]);
    if (candidates.length === 1) return { state: "resolved", claimant: lease, source: "lease" };
    return { state: "ambiguous" };
  }
  if (lease !== null) return { state: "resolved", claimant: lease, source: "lease" };
  if (agentLabels.length === 1) return { state: "resolved", claimant: agentLabels[0], source: "agent-label" };
  if (agentLabels.length > 1) return { state: "ambiguous" };
  if (ownerLabels.length === 1) return { state: "resolved", claimant: ownerLabels[0], source: "owner-label" };
  return { state: "missing" };
}

export function splitClaimantLabels(labels: readonly string[] | null | undefined): {
  agentLabelNames: string[];
  ownerLabelNames: string[];
} {
  const agentLabelNames: string[] = [];
  const ownerLabelNames: string[] = [];
  for (const label of labels ?? []) {
    if (label.startsWith(AGENT_LABEL_PREFIX)) {
      const name = label.slice(AGENT_LABEL_PREFIX.length).trim();
      if (name !== "") agentLabelNames.push(name);
    } else if (label.startsWith(OWNER_LABEL_PREFIX)) {
      const name = label.slice(OWNER_LABEL_PREFIX.length).trim();
      if (name !== "") ownerLabelNames.push(name);
    }
  }
  return { agentLabelNames, ownerLabelNames };
}

/** Minimal read surface needed to resolve claimant facts (testable). */
export interface ClaimantFactsClient {
  issue?: { findFirst(args?: any): Promise<{ id: string; labels: string[] } | null | undefined> };
  lease?: { findFirst(args?: any): Promise<{ agentName: string } | null | undefined> };
}

/**
 * Read the authoritative facts for one linked issue and resolve the claimant.
 * A read failure returns null — "could not evaluate", NOT "missing": callers
 * must never downgrade an existing record on a failed read, and must not
 * store a confident failure state either.
 * `repo` is the queue-folded repo; `Issue.repository.fullName` keeps GitHub
 * casing, so the issue lookup matches case-insensitively (#1145 convention).
 */
export async function resolvePrFixClaimantFacts(
  client: ClaimantFactsClient,
  repo: string,
  issueNumber: number,
  now: Date = new Date(),
  options?: ClaimantResolutionOptions,
): Promise<ClaimantResolution | null> {
  try {
    const row = await client.issue?.findFirst({
      where: {
        repository: { fullName: { equals: repo, mode: "insensitive" } },
        number: issueNumber,
      },
      select: { id: true, labels: true },
    });
    if (!row) {
      // No issue row is a DEFINITIVE "no source": like the #1503 missing-row
      // rule, a pruned row cannot conceal a live claim, and treating it as a
      // read failure would strand the row forever.
      return { state: "missing" };
    }
    const { agentLabelNames, ownerLabelNames } = splitClaimantLabels(row.labels as string[]);
    let leaseAgent: string | null = null;
    if (client.lease) {
      const lease = await client.lease.findFirst({
        where: { issueId: row.id, expiredAt: { gt: now } },
        orderBy: { expiredAt: "desc" },
        select: { agentName: true },
      });
      leaseAgent = lease?.agentName ?? null;
    }
    return resolveClaimantFromIssueFacts({ leaseAgent, agentLabelNames, ownerLabelNames }, options);
  } catch {
    return null;
  }
}

/**
 * Resolve the claimant for a row being ingested: linked issue when present
 * (issue facts win over the PR author), else the PR author login. A failed
 * issue read returns "unavailable" — nothing is recorded, and a later
 * ingestion/recovery re-resolves it, so a transient database error can never
 * be stored as a provenance the row does not actually have.
 */
export async function resolveIngestionClaimant(
  client: ClaimantFactsClient,
  repo: string,
  issueNumber: number | null | undefined,
  prAuthor: string | null | undefined,
  now: Date = new Date(),
  options?: ClaimantResolutionOptions,
): Promise<ClaimantResolution> {
  if (issueNumber !== null && issueNumber !== undefined) {
    const resolved = await resolvePrFixClaimantFacts(client, repo, issueNumber, now, options);
    if (resolved) return resolved;
    return { state: "unavailable" };
  }
  const author = prAuthor?.trim();
  if (author) return { state: "resolved", claimant: author, source: "pr-author" };
  return { state: "missing" };
}

/** Persisted `claimantSource` values written alongside a resolved claimant. */
export function claimantSourceValue(resolution: ClaimantResolution): string | null {
  if (resolution.state === "resolved") return resolution.source;
  // "unavailable" is a read failure, never a stored provenance.
  if (resolution.state === "unavailable") return null;
  return resolution.state;
}

/**
 * Derive the versioned evidence object from a queue row. Missing claimant
 * with no recorded source is "legacy" (pre-contract row); with a recorded
 * failure state it is that state. `author` rides along as `prAuthor` so a
 * negotiated consumer can distinguish PR transport identity from claimant.
 */
export function prFixOwnershipEvidence(row: {
  lane?: string | null;
  claimant?: string | null;
  claimantSource?: string | null;
  author?: string | null;
}): PrFixOwnershipEvidence {
  const claimant = typeof row.claimant === "string" && row.claimant.trim() !== "" ? row.claimant : null;
  let provenance: PrFixOwnershipProvenance;
  if (claimant !== null) {
    const source = row.claimantSource;
    provenance =
      source === "lease" || source === "agent-label" || source === "owner-label" || source === "pr-author" || source === "operator"
        ? source
        // A claimant with an unknown/absent source is still a recorded
        // identity; the honest provenance is "legacy" (pre-contract write).
        : "legacy";
  } else if (row.claimantSource === "ambiguous") {
    provenance = "ambiguous";
  } else if (row.claimantSource === "missing") {
    provenance = "missing";
  } else {
    provenance = "legacy";
  }
  return {
    contract: PR_FIX_OWNERSHIP_CONTRACT_VERSION,
    owningLane: row.lane ?? "NORMAL",
    originalClaimant: claimant,
    provenance,
    ...(row.author !== undefined ? { prAuthor: row.author } : {}),
  };
}

/**
 * The fail-closed issuance predicate: unresolved ownership ("missing",
 * "ambiguous", or a legacy row with no recorded claimant) never authorizes an
 * automatic hand-out. Only a resolved claimant identity authorizes one.
 */
export function ownershipAuthorizesHandout(evidence: PrFixOwnershipEvidence): boolean {
  return evidence.originalClaimant !== null;
}

/**
 * #1615: the HUMAN-OWNED classification. A claimant established by a source
 * that never authenticated the identity as a Dispatch worker — an
 * `agent/<name>` or `owner/<name>` board label, or the PR author login —
 * whose name is OUTSIDE the operator-declared PR-fix worker identity space
 * (`prFixWorkerAgentIdentitySet`, the `DISPATCH_PR_FIX_AGENTS` list) belongs
 * to a human: the row is that human's queue entry, and it must never be
 * auto-offered to a connector pool that cannot own it.
 *
 * Sources that DO authenticate the identity through Dispatch's own API are
 * never classified human: a live `lease` holder and an `operator` stamp are
 * bearer-authenticated acts, so they are worker identities by construction.
 *
 * Fail-open by design: with NO worker identity space configured (an empty
 * set — `DISPATCH_PR_FIX_AGENTS` unset or empty), classification is
 * unavailable and nothing is human-owned, which preserves the unclassified
 * dispatch behavior for deployments that have not declared the space.
 */
const UNAUTHENTICATED_CLAIMANT_SOURCES: ReadonlySet<string> = new Set(["agent-label", "owner-label", "pr-author"]);

export function claimantIsHumanOwned(
  evidence: PrFixOwnershipEvidence,
  workerAgents: ReadonlySet<string>,
): boolean {
  if (workerAgents.size === 0) return false;
  if (evidence.originalClaimant === null) return false;
  if (!UNAUTHENTICATED_CLAIMANT_SOURCES.has(evidence.provenance)) return false;
  return !workerAgents.has(evidence.originalClaimant.trim().toLowerCase());
}
