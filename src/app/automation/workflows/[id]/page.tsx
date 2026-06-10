"use client";

import { authedFetch } from "@/lib/client-auth";
import { useEffect, useState, use } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, ExternalLink, CheckCircle, XCircle, Clock, Play } from "lucide-react";

interface WorkflowDetail {
  id: string;
  name: string;
  path: string;
  state: string;
  workflowId: string;
  lastRunAt: string | null;
  repo: { fullName: string; name: string };
  runs: {
    id: string;
    runId: number;
    name: string;
    status: string;
    conclusion: string | null;
    branch: string;
    headSha: string;
    actor: string;
    runStartedAt: string;
    updatedAt: string;
    durationSecs: number | null;
    jobs: {
      id: string;
      name: string;
      status: string;
      conclusion: string | null;
      startedAt: string | null;
      completedAt: string | null;
    }[];
  }[];
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge variant="secondary">unknown</Badge>;
  switch (status) {
    case "success":
      return <Badge className="bg-green-100 text-green-700"><CheckCircle className="h-3 w-3 mr-1" /> success</Badge>;
    case "failure":
      return <Badge className="bg-red-100 text-red-700"><XCircle className="h-3 w-3 mr-1" /> failed</Badge>;
    case "in_progress":
      return <Badge className="bg-blue-100 text-blue-700"><Clock className="h-3 w-3 mr-1" /> running</Badge>;
    case "cancelled":
      return <Badge variant="secondary"><XCircle className="h-3 w-3 mr-1" /> cancelled</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function Duration({ seconds }: { seconds: number | null }) {
  if (!seconds) return <span className="text-muted-foreground">-</span>;
  if (seconds < 60) return <span>{seconds}s</span>;
  if (seconds < 3600) return <span>{Math.floor(seconds / 60)}m {seconds % 60}s</span>;
  return <span>{Math.floor(seconds / 3600)}h {Math.floor((seconds % 3600) / 60)}m</span>;
}

function calculateSuccessRate(runs: { conclusion: string | null }[]) {
  if (runs.length === 0) return 0;
  const completed = runs.filter((r) => r.conclusion !== null);
  if (completed.length === 0) return 0;
  const successes = completed.filter((r) => r.conclusion === "success");
  return Math.round((successes.length / completed.length) * 100);
}

function averageDuration(runs: { durationSecs: number | null }[]) {
  const withDuration = runs.filter((r) => r.durationSecs !== null);
  if (withDuration.length === 0) return null;
  return Math.round(withDuration.reduce((sum, r) => sum + (r.durationSecs || 0), 0) / withDuration.length);
}

export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: workflowId } = use(params);
  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workflowId) return;
    authedFetch(`/api/automation/workflows/${workflowId}`)
      .then((res) => {
        if (!res.ok) throw new Error("Workflow not found");
        return res.json();
      })
      .then((data) => setWorkflow(data))
      .catch(() => setWorkflow(null))
      .finally(() => setLoading(false));
  }, [workflowId]);

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  if (!workflow) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/automation"><ArrowLeft className="h-4 w-4 mr-2" /> Back</Link>
        </Button>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-destructive">Workflow not found</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const successRate = calculateSuccessRate(workflow.runs);
  const avgDuration = averageDuration(workflow.runs);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" asChild>
            <Link href={`/automation/repos/${workflow.repo.fullName}`}><ArrowLeft className="h-4 w-4 mr-2" /> Back</Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold">{workflow.name}</h1>
            <div className="flex gap-2 text-sm text-muted-foreground">
              <span>{workflow.repo.fullName}</span>
              <span className="font-mono">{workflow.path}</span>
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            if (workflow.runs[0]) {
              authedFetch(`/api/automation/runs/${workflow.runs[0].runId}?repo=${workflow.repo.fullName}&action=dispatch`, { method: "POST" })
                .then(() => window.location.reload());
            }
          }}
          disabled={!workflow.runs[0]}
        >
          <Play className="h-4 w-4 mr-2" /> Trigger
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Status</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBadge status={workflow.state} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recent Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{workflow.runs.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Success Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${successRate >= 80 ? "text-green-600" : successRate >= 50 ? "text-yellow-600" : "text-red-600"}`}>
              {successRate}%
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Avg Duration</CardTitle>
          </CardHeader>
          <CardContent>
            <Duration seconds={avgDuration} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {workflow.runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No runs found</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>SHA</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Jobs</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflow.runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell><StatusBadge status={run.conclusion || run.status} /></TableCell>
                    <TableCell className="font-mono text-xs">{run.branch}</TableCell>
                    <TableCell className="font-mono text-xs">{run.headSha.slice(0, 7)}</TableCell>
                    <TableCell>{run.actor}</TableCell>
                    <TableCell><Duration seconds={run.durationSecs} /></TableCell>
                    <TableCell className="text-muted-foreground">{new Date(run.runStartedAt).toLocaleString()}</TableCell>
                    <TableCell>
                      {run.jobs.length > 0 && (
                        <div className="text-xs">
                          {run.jobs.filter((j) => j.conclusion === "success").length}/{run.jobs.length} passed
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" asChild>
                          <a href={`https://github.com/${workflow.repo.fullName}/actions/runs/${run.runId}`} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </Button>
                        {run.status === "completed" && run.conclusion === "failure" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              authedFetch(`/api/automation/runs/${run.runId}?repo=${workflow.repo.fullName}&action=rerun`, { method: "POST" })
                                .then(() => window.location.reload());
                            }}
                          >
                            <Play className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {workflow.runs[0]?.jobs && workflow.runs[0].jobs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Latest Run Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflow.runs[0].jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>{job.name}</TableCell>
                    <TableCell><StatusBadge status={job.conclusion || job.status} /></TableCell>
                    <TableCell>
                      {job.startedAt && job.completedAt ? (
                        <Duration seconds={Math.round((new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)} />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}