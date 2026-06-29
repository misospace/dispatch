"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { authedFetch } from "@/lib/client-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExternalLink, Play, RefreshCw, Loader2, AlertCircle, CheckCircle2, Hash, GitBranch } from "lucide-react";

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
  issue?: { title: string; state: string };
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

interface GroomCandidateTask {
  type: string;
  shouldRun: boolean;
  issue?: {
    repoFullName: string;
    number: number;
    title: string;
    url: string;
  };
  reason?: string;
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

  useEffect(() => {
    void loadRuns();
  }, []);

  async function handleGroomNext() {
    setGrooming(true);
    setGroomResult(null);
    setGroomError(null);
    try {
      // Step 1: Get the next grooming candidate
      const taskRes = await authedFetch("/api/agents/saffron/next-task?mode=groom");
      const taskData: GroomCandidateTask = await taskRes.json();
      if (!taskRes.ok) {
        throw new Error(taskData?.reason || "Failed to get next grooming candidate");
      }

      // If idle (no candidate), report that
      if (!taskData.shouldRun || !taskData.issue) {
        setGroomResult({ candidateNumber: null });
        return;
      }

      // Step 2: Run the groomer on the selected issue
      const runRes = await authedFetch("/api/groomer/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueNumber: taskData.issue.number,
          repoFullName: taskData.issue.repoFullName,
          dryRun: false,
        }),
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
      setTimeout(() => void loadRuns(), 500);
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
      setTimeout(() => void loadRuns(), 500);
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
        <Button variant="outline" onClick={loadRuns} disabled={grooming}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
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
                  <TableHead>Status</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Lane</TableHead>
                  <TableHead>Labels</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
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
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
