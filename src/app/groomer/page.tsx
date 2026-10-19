"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { authedFetch } from "@/lib/client-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExternalLink, Play, RefreshCw, Loader2, AlertCircle, CheckCircle2, Hash, GitBranch, MessageSquareWarning, ChevronRight, ChevronDown, ShieldAlert, Pin, Link2 } from "lucide-react";
import { summarizeGroomingOutput } from "@/lib/groomer/plan-summary";
import type { GroomingRunView } from "@/lib/groomer/run-view";

interface PendingReplyRow {
  id: string;
  repoFullName: string;
  issueNumber: number;
  commentBody: string;
  reason: string;
  trustContext: { participants?: Array<{ login: string; role: string; reason: string; trusted: boolean }> };
  createdAt: string;
}

interface GroomingRunRow {
  id: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
  status: string;
  dryRun: boolean;
  model: string | null;
  labelsBefore: string[];
  labelsAfter: string[];
  laneBefore: string | null;
  laneAfter: string | null;
  errorMessage: string | null;
  createdAt: string;
  validatedOutput?: unknown;
  issue?: { title: string; state: string };
  view?: GroomingRunView;
}

function short(value: string | null | undefined, take = 12): string {
  if (!value) return "-";
  return value.slice(0, take);
}

function EvidenceCell({ view }: { view?: GroomingRunView }) {
  if (!view || !view.evidence.available) {
    return <span className="text-xs text-muted-foreground">no snapshot</span>;
  }
  const evidence = view.evidence;
  return (
    <div className="text-xs space-y-1">
      <div className="flex items-center gap-1" title={evidence.headSha ?? undefined}>
        <Pin className={`h-3 w-3 ${evidence.pinned ? "text-green-600" : "text-amber-600"}`} />
        {evidence.pinned ? (
          <span className="font-mono" title={evidence.headSha ?? undefined}>{short(evidence.headSha)}</span>
        ) : (
          <span className="font-mono text-amber-700">unpinned</span>
        )}
      </div>
      <div className="font-mono text-muted-foreground" title={evidence.evidenceDigest ?? undefined}>
        digest {short(evidence.evidenceDigest, 12)}
      </div>
      <div className="text-muted-foreground">
        {evidence.humanCommentCount} human / {evidence.automationCommentCount} automation
      </div>
    </div>
  );
}

function preconditionBadge(view: GroomingRunView) {
  if (view.precondition.stale) return <Badge className="bg-amber-100 text-amber-800">stale</Badge>;
  if (view.precondition.unverifiable) return <Badge className="bg-amber-100 text-amber-800">unverifiable</Badge>;
  if (view.precondition.ok === true) return <Badge className="bg-green-100 text-green-700">preconditions ok</Badge>;
  if (view.precondition.ok === false) return <Badge className="bg-red-100 text-red-700">preconditions failed</Badge>;
  return null;
}

function RunEvidencePanel({ run }: { run: GroomingRunRow }) {
  const view = run.view;
  if (!view) {
    return <p className="text-xs text-muted-foreground">No operator view recorded for this run.</p>;
  }
  const evidence = view.evidence;
  const decision = view.decision;
  return (
    <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-4" data-testid="run-evidence-panel">
      <div>
        <h4 className="font-medium mb-1">Evidence &amp; provenance</h4>
        {evidence.available ? (
          <div className="space-y-1 text-xs">
            <div>
              Repository revision:{" "}
              {evidence.headSha ? (
                <span className="font-mono">{evidence.headSha}</span>
              ) : (
                <span className="text-amber-700">unpinned (no head SHA captured)</span>
              )}
              {evidence.defaultBranch ? <> on <span className="font-mono">{evidence.defaultBranch}</span></> : null}
            </div>
            <div className="font-mono text-muted-foreground">evidence digest: {evidence.evidenceDigest ?? "-"}</div>
            <div className="font-mono text-muted-foreground">issue fingerprint: {evidence.issueFingerprint ?? "-"}</div>
            <div>
              Sources: {evidence.repositoryReadCount} read at the pinned revision, {evidence.repositorySurfacedCount} surfaced
              (unpinned), {evidence.relatedWorkCount} GitHub issue/PR/commit refs
            </div>
            {evidence.sources.length > 0 && (
              <ul className="list-disc pl-4">
                {evidence.sources.map((source, index) => {
                  if (source.kind === "repository") {
                    return (
                      <li key={`src-${index}`} className="font-mono">
                        {source.path ?? "unknown path"}{" "}
                        <span className="text-muted-foreground">
                          ({source.via === "surfaced" ? "surfaced, unpinned" : source.via === "read" ? `read at ${short(source.ref, 12)}` : "unknown provenance"})
                        </span>
                      </li>
                    );
                  }
                  return (
                    <li key={`src-${index}`} className="font-mono">
                      {source.url ? (
                        <a href={source.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{source.key ?? source.url}</a>
                      ) : (
                        source.key ?? "unknown ref"
                      )}{" "}
                      <span className="text-muted-foreground">
                        ({source.kind.replace(/^github_/, "")}
                        {source.state ? `, ${source.state}` : ""}
                        {source.via ? `, ${source.via}` : ""})
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <div>
              Comments: {evidence.humanCommentCount} human (authoritative),{" "}
              {evidence.automationCommentCount} automation (<span className="text-amber-700">non-authoritative</span>)
            </div>
            {evidence.capturedAt && (
              <div className="text-muted-foreground">Captured {new Date(evidence.capturedAt).toLocaleString()}</div>
            )}
            {evidence.warnings.length > 0 && (
              <ul className="list-disc pl-4 text-muted-foreground">
                {evidence.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No evidence snapshot was captured for this run (legacy run).</p>
        )}
      </div>

      <div>
        <h4 className="font-medium mb-1">Pipeline</h4>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">{view.status ?? "unknown"}</Badge>
          <Badge variant="outline">stage: {view.stage ?? "unknown"}</Badge>
          <Badge variant="outline">plan schema: {view.plan.schemaVersion ?? "legacy"}</Badge>
          {preconditionBadge(view)}
          {view.application.replayed && <Badge className="bg-blue-100 text-blue-700">replayed</Badge>}
          {view.application.freshApplication && <Badge className="bg-green-100 text-green-700">fresh application</Badge>}
        </div>
      </div>

      <div>
        <h4 className="font-medium mb-1">Precondition validation</h4>
        {view.precondition.recorded ? (
          <div className="space-y-1 text-xs">
            {view.precondition.checks.map((check, index) => (
              <div key={index} className="flex items-start gap-2">
                {check.status === "passed" ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                ) : check.status === "changed" ? (
                  <AlertCircle className="h-3.5 w-3.5 text-red-600 mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
                )}
                <span>
                  <span className="font-medium">{check.name}</span> — {check.status}
                  {check.detail ? `: ${check.detail}` : ""}
                </span>
              </div>
            ))}
            {view.precondition.failures.length > 0 && (
              <div className="text-destructive">{view.precondition.failures.join("; ")}</div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No apply-time precondition result recorded.</p>
        )}
      </div>

      <div>
        <h4 className="font-medium mb-1">Idempotent application</h4>
        <div className="text-xs space-y-1">
          <div>
            Outcome: <span className="font-medium">{view.application.applyOutcome ?? "not recorded"}</span>
            {view.application.replayed && " — a previous run with the same application key already applied this plan; nothing was written"}
          </div>
          {view.application.applicationKey && (
            <div className="font-mono text-muted-foreground">application key: {view.application.applicationKey}</div>
          )}
          {view.application.applicationCount !== null && (
            <div className="text-muted-foreground">Recorded applications: {view.application.applicationCount}</div>
          )}
          {view.application.lastApplicationAt && (
            <div className="text-muted-foreground">
              Last applied {new Date(view.application.lastApplicationAt).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      <div>
        <h4 className="font-medium mb-1">High-impact decisions</h4>
        {decision.close && (
          <div className="text-xs space-y-1 mb-2">
            <div className="flex items-center gap-1">
              <ShieldAlert className="h-3.5 w-3.5 text-red-600" />
              Close as <span className="font-medium">{decision.close.reason}</span>
              <span className="text-muted-foreground">(confidence: {decision.close.confidence ?? "unknown"})</span>
            </div>
            {decision.close.rationale && <div className="text-muted-foreground">{decision.close.rationale}</div>}
            {decision.close.evidenceRefs.length > 0 && (
              <div className="font-mono text-muted-foreground">evidence: {decision.close.evidenceRefs.join(", ")}</div>
            )}
          </div>
        )}
        {decision.readyPromotion && (
          <div className="text-xs space-y-1 mb-2">
            <div className="flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              Ready promotion{decision.readyPromotion.admission ? ` (${decision.readyPromotion.admission})` : ""}
              <span className="text-muted-foreground">(confidence: {decision.readyPromotion.confidence ?? "unknown"})</span>
            </div>
            {decision.readyPromotion.evidenceRefs.length > 0 && (
              <div className="font-mono text-muted-foreground">evidence: {decision.readyPromotion.evidenceRefs.join(", ")}</div>
            )}
          </div>
        )}
        {decision.decomposition && (
          <div className="text-xs space-y-1">
            <div className="flex items-center gap-1">
              <Link2 className="h-3.5 w-3.5 text-blue-600" />
              Decomposition{decision.decomposition.reason ? `: ${decision.decomposition.reason}` : ""}
              <span className="text-muted-foreground">(confidence: {decision.decomposition.confidence ?? "unknown"})</span>
            </div>
            {decision.decomposition.evidenceRefs.length > 0 && (
              <div className="font-mono text-muted-foreground">evidence: {decision.decomposition.evidenceRefs.join(", ")}</div>
            )}
            {decision.decomposition.childrenCreated.length > 0 && (
              <div>
                Created:{" "}
                {decision.decomposition.childrenCreated.map((child, index) => (
                  <a key={child.number} href={child.url ?? undefined} target="_blank" rel="noopener noreferrer" className="hover:underline mr-2">
                    #{child.number}
                  </a>
                ))}
              </div>
            )}
            {decision.decomposition.childrenReused.length > 0 && (
              <div>
                Reused:{" "}
                {decision.decomposition.childrenReused.map((child, index) => (
                  <a key={child.number} href={child.url ?? undefined} target="_blank" rel="noopener noreferrer" className="hover:underline mr-2">
                    #{child.number}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
        {!decision.close && !decision.readyPromotion && !decision.decomposition && (
          <p className="text-xs text-muted-foreground">No close, ready-promotion or decomposition decision on this run.</p>
        )}
      </div>
    </div>
  );
}

interface GroomResult {
  candidateNumber: number | null;
  repoFullName?: string;
  dryRun?: boolean;
  output?: string;
  plannedLabels?: string[];
  groomingRunId?: string;
  contextWarnings?: string[];
  mutationPlan?: Record<string, unknown>;
  appliedMutations?: Record<string, unknown>;
  error?: string;
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "completed" || status === "dry_run_completed"
      ? "bg-green-100 text-green-700"
      : status === "failed"
        ? "bg-red-100 text-red-700"
        : "bg-blue-100 text-blue-700";
  return <Badge className={cls}>{status.replace(/_/g, " ")}</Badge>;
}

/**
 * The run's verdict. Plan-contract runs show evidence-checked readiness;
 * runs recorded before it (legacy output) show their actionability only.
 */
function VerdictCell({ validatedOutput }: { validatedOutput: unknown }) {
  const verdict = summarizeGroomingOutput(validatedOutput);
  if (verdict.format === "unknown") return <span className="text-xs text-muted-foreground">-</span>;
  const label = verdict.actionability?.replace(/_/g, " ") ?? "unknown";
  const cls =
    verdict.ready === true
      ? "bg-green-100 text-green-700"
      : verdict.ready === false
        ? "bg-amber-100 text-amber-800"
        : "bg-muted text-muted-foreground";
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <Badge className={cls}>{label}</Badge>
        {verdict.admission && <Badge variant="outline" className="text-xs">{verdict.admission}</Badge>}
        {verdict.format === "legacy" && <Badge variant="outline" className="text-xs">legacy</Badge>}
      </div>
      {verdict.format === "grooming-plan" && (
        <div className="text-xs text-muted-foreground">
          {verdict.citationCount} cited
          {verdict.materialUncertaintyCount > 0 && `, ${verdict.materialUncertaintyCount} open question${verdict.materialUncertaintyCount === 1 ? "" : "s"}`}
        </div>
      )}
    </div>
  );
}

function GroomResultSummary({ result }: { result: GroomResult }) {
  const isComplete =
    result.candidateNumber !== null && result.candidateNumber !== undefined;

  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center gap-2">
        {isComplete ? (
          <CheckCircle2 className="h-5 w-5 text-green-600" />
        ) : (
          <AlertCircle className="h-5 w-5 text-yellow-600" />
        )}
        <span className="font-medium">
          {isComplete ? "Grooming complete" : "No candidate found"}
        </span>
      </div>
      {isComplete && (
        <div className="text-sm text-muted-foreground space-y-1">
          {result.repoFullName && (
            <div>
              <GitBranch className="h-3 w-3 inline mr-1" />
              {result.repoFullName} <Hash className="h-3 w-3 inline mx-1" />
              {result.candidateNumber}
            </div>
          )}
          {result.dryRun !== undefined && (
            <div>Mode: {result.dryRun ? "dry-run" : "write"}</div>
          )}
          {result.plannedLabels && result.plannedLabels.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {result.plannedLabels.map((label) => (
                <Badge key={label} variant="secondary" className="text-xs">
                  {label}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function GroomerHistoryPage() {
  const [runs, setRuns] = useState<GroomingRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingReplies, setPendingReplies] = useState<PendingReplyRow[]>([]);
  const [repliesLoading, setRepliesLoading] = useState(true);
  const [replyError, setReplyError] = useState("");
  const [replyActionId, setReplyActionId] = useState<string | null>(null);

  // Run detail expansion state (run id -> expanded)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  // Groom trigger state
  const [grooming, setGrooming] = useState(false);
  const [groomResult, setGroomResult] = useState<GroomResult | null>(null);
  const [groomError, setGroomError] = useState<string | null>(null);

  // Specific issue form state
  const [specificRepo, setSpecificRepo] = useState("");
  const [specificIssue, setSpecificIssue] = useState("");

  async function loadRuns() {
    setLoading(true);
    setError("");
    try {
      const res = await authedFetch("/api/groomer/runs?limit=100");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load grooming runs");
      setRuns(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load grooming runs");
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadPendingReplies() {
    setRepliesLoading(true);
    setReplyError("");
    try {
      const res = await authedFetch("/api/groomer/pending-replies");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load pending replies");
      setPendingReplies(Array.isArray(data) ? data : []);
    } catch (err) {
      setReplyError(err instanceof Error ? err.message : "Failed to load pending replies");
      setPendingReplies([]);
    } finally {
      setRepliesLoading(false);
    }
  }

  useEffect(() => {
    void loadRuns();
    void loadPendingReplies();
  }, []);

  async function handleReplyAction(reply: PendingReplyRow, action: "approve" | "dismiss") {
    setReplyActionId(`${reply.id}:${action}`);
    setReplyError("");
    try {
      const res = await authedFetch(`/api/groomer/pending-replies/${reply.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Failed to ${action} reply`);
      await loadPendingReplies();
    } catch (err) {
      setReplyError(err instanceof Error ? err.message : `Failed to ${action} reply`);
    } finally {
      setReplyActionId(null);
    }
  }

  async function handleGroomNext() {
    setGrooming(true);
    setGroomResult(null);
    setGroomError(null);
    try {
      // Let the hosted runner select its own candidate and enforce the reply gate.
      const runRes = await authedFetch("/api/groomer/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false }),
      });

      const runData: GroomResult = await runRes.json();
      if (!runRes.ok) {
        throw new Error(runData?.error || "Groomer run failed");
      }

      setGroomResult(runData);
    } catch (err) {
      setGroomError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setGrooming(false);
      // Refresh the history table after a short delay so the new run appears
      setTimeout(() => { void loadRuns(); void loadPendingReplies(); }, 500);
    }
  }

  async function handleGroomSpecific() {
    if (!specificIssue.trim()) {
      setGroomError("Issue number is required");
      return;
    }
    const issueNum = parseInt(specificIssue.trim(), 10);
    if (isNaN(issueNum)) {
      setGroomError("Issue number must be a valid integer");
      return;
    }

    setGrooming(true);
    setGroomResult(null);
    setGroomError(null);
    try {
      const body: Record<string, unknown> = {
        issueNumber: issueNum,
        dryRun: false,
      };
      if (specificRepo.trim()) {
        body.repoFullName = specificRepo.trim();
      }

      const runRes = await authedFetch("/api/groomer/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const runData: GroomResult = await runRes.json();
      if (!runRes.ok) {
        throw new Error(runData?.error || "Groomer run failed");
      }

      setGroomResult(runData);
    } catch (err) {
      setGroomError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setGrooming(false);
      setTimeout(() => { void loadRuns(); void loadPendingReplies(); }, 500);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Hosted Groomer</h1>
          <p className="text-muted-foreground">
            Visible history for Dispatch-hosted issue grooming runs.
          </p>
        </div>
        <Button variant="outline" onClick={() => { void loadRuns(); void loadPendingReplies(); }} disabled={grooming}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading || repliesLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Run Groomer Section */}
      <Card>
        <CardHeader>
          <CardTitle>Run Groomer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Primary: Groom Next */}
          <div className="flex items-center gap-3">
            <Button
              size="lg"
              onClick={handleGroomNext}
              disabled={grooming}
            >
              {grooming ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Grooming in progress...
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  Groom Next
                </>
              )}
            </Button>
            <span className="text-sm text-muted-foreground">
              Picks the next backlog issue and runs the groomer on it.
            </span>
          </div>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">
                or target a specific issue
              </span>
            </div>
          </div>

          {/* Secondary: Groom Specific Issue */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <label htmlFor="groom-repo" className="text-sm font-medium">
                Repo <span className="text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="groom-repo"
                placeholder="owner/repo (optional)"
                value={specificRepo}
                onChange={(e) => setSpecificRepo(e.target.value)}
                disabled={grooming}
                className="w-56"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="groom-issue" className="text-sm font-medium">
                Issue Number
              </label>
              <Input
                id="groom-issue"
                placeholder="e.g. 42"
                value={specificIssue}
                onChange={(e) => setSpecificIssue(e.target.value)}
                disabled={grooming}
                className="w-32"
                type="text"
              />
            </div>
            <Button
              onClick={handleGroomSpecific}
              disabled={grooming || !specificIssue.trim()}
              variant="outline"
            >
              {grooming ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Running...
                </>
              ) : (
                "Run"
              )}
            </Button>
          </div>

          {/* Loading indicator */}
          {grooming && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Groomer is running (10–100s for LLM call)...
            </div>
          )}

          {/* Error */}
          {groomError && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{groomError}</span>
            </div>
          )}

          {/* Result summary */}
          {groomResult && !grooming && (
            <GroomResultSummary result={groomResult} />
          )}
        </CardContent>
      </Card>

      {/* History Table */}
      <Card className={pendingReplies.length > 0 ? "border-amber-500/50" : ""}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquareWarning className="h-5 w-5 text-amber-600" />
            Replies awaiting approval
            {pendingReplies.length > 0 && <Badge className="bg-amber-100 text-amber-800">{pendingReplies.length}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {repliesLoading ? (
            <div className="py-8 text-center text-muted-foreground">Loading pending replies...</div>
          ) : replyError ? (
            <div className="text-destructive text-sm">{replyError}</div>
          ) : pendingReplies.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">No replies awaiting approval.</p>
              <p className="text-sm text-muted-foreground mt-1">Held replies appear here for operator review before they are posted.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repo / Issue</TableHead>
                  <TableHead>Proposed reply</TableHead>
                  <TableHead>Reason / Participants</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingReplies.map((reply) => {
                  const participants = reply.trustContext?.participants ?? [];
                  return (
                    <TableRow key={reply.id}>
                      <TableCell className="font-medium">{reply.repoFullName}#{reply.issueNumber}</TableCell>
                      <TableCell className="max-w-sm">
                        <p className="line-clamp-3 whitespace-pre-wrap text-sm" title={reply.commentBody}>{reply.commentBody}</p>
                      </TableCell>
                      <TableCell className="max-w-xs text-sm">
                        <div>{reply.reason.replace(/_/g, " ")}</div>
                        <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
                          {participants.map((participant) => `${participant.login || "unknown"} (${participant.role}${participant.trusted ? ", trusted" : ", untrusted"})`).join(", ") || "Trust context unavailable"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => void handleReplyAction(reply, "approve")} disabled={replyActionId !== null}>
                            {replyActionId === `${reply.id}:approve` ? "Approving..." : "Approve"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => void handleReplyAction(reply, "dismiss")} disabled={replyActionId !== null}>
                            {replyActionId === `${reply.id}:dismiss` ? "Dismissing..." : "Dismiss"}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Grooming Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-8 text-center">Loading...</div>
          ) : error ? (
            <div className="text-destructive text-sm">{error}</div>
          ) : runs.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No hosted grooming runs recorded yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead>Evidence</TableHead>
                  <TableHead>Lane</TableHead>
                  <TableHead>Labels</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <Fragment key={run.id}>
                    <TableRow
                      className={run.view ? "cursor-pointer" : undefined}
                      onClick={() => run.view && setExpandedRunId(expandedRunId === run.id ? null : run.id)}
                    >
                      <TableCell>
                        {run.view ? (
                          expandedRunId === run.id ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={run.status} />
                      </TableCell>
                    <TableCell>
                      <div className="font-medium">{run.repoFullName}#{run.issueNumber}</div>
                      <div className="text-xs text-muted-foreground line-clamp-1">
                        {run.issue?.title}
                      </div>
                      {run.errorMessage && (
                        <div className="text-xs text-destructive line-clamp-1">
                          {run.errorMessage}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{run.dryRun ? "dry-run" : "write"}</Badge>
                    </TableCell>
                    <TableCell>
                      <VerdictCell validatedOutput={run.validatedOutput} />
                    </TableCell>
                    <TableCell>
                      <EvidenceCell view={run.view} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {run.laneBefore || "-"} &rarr; {run.laneAfter || "-"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {run.labelsBefore.length} &rarr; {run.labelsAfter.length}
                    </TableCell>
                    <TableCell className="text-xs">{run.model || "-"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(run.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="flex gap-2">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/api/groomer/runs/${run.id}`}>JSON</Link>
                      </Button>
                      <a
                        href={run.issueUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </TableCell>
                  </TableRow>
                  {expandedRunId === run.id && run.view && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={11}>
                        <RunEvidencePanel run={run} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
