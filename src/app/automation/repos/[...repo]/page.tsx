"use client";

import { useEffect, useState, use } from "react";
import { authedFetch } from "@/lib/client-auth";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge, Duration } from "@/components/automation/status-badge";
import { ArrowLeft, RefreshCw, ExternalLink, CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react";

interface RepoDetail {
  id: string;
  fullName: string;
  name: string;
  owner: string;
  defaultBranch: string;
  latestCommitSha: string | null;
  openPRCount: number;
  lastSyncedAt: string | null;
  syncError: string | null;
  failingRuns: number;
  runningRuns: number;
  workflows: {
    id: string;
    name: string;
    path: string;
    state: string;
    lastRunAt: string | null;
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
      durationSecs: number | null;
    }[];
  }[];
  releases: {
    id: string;
    tagName: string;
    name: string | null;
    draft: boolean;
    prerelease: boolean;
    url: string;
    publishedAt: string;
  }[];
  packages: {
    id: string;
    packageType: string;
    name: string;
    visibility: string;
    latestTag: string | null;
    url: string;
  }[];
  lastSyncRun: {
    status: string;
    reposFetched: number;
    workflowsFetched: number;
    runsFetched: number;
    errorMessage: string | null;
    startedAt: string;
    completedAt: string | null;
  } | null;
  recentEvents: {
    id: string;
    eventType: string;
    title: string;
    description: string | null;
    actor: string | null;
    createdAt: string;
  }[];
}

export default function RepoDetailPage({ params }: { params: Promise<{ repo: string[] }> }) {
  const { repo: repoSegments } = use(params);
  const repoFullName = repoSegments.join("/");
  const [repo, setRepo] = useState<RepoDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repoFullName) return;
    const decoded = decodeURIComponent(repoFullName);
    authedFetch(`/api/automation/repos/${decoded}`)
      .then((res) => {
        if (!res.ok) throw new Error("Repo not found");
        return res.json();
      })
      .then((data) => setRepo(data))
      .catch(() => setRepo(null))
      .finally(() => setLoading(false));
  }, [repoFullName]);

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  if (!repo) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/automation"><ArrowLeft className="h-4 w-4 mr-2" /> Back</Link>
        </Button>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-destructive">Repository not found</p>
            <p className="text-sm text-muted-foreground mt-1">
              {repoFullName} may not be synced yet. Go to Automation overview and click Sync.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" asChild>
            <Link href="/automation"><ArrowLeft className="h-4 w-4 mr-2" /> Back</Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold">{repo.fullName}</h1>
            <div className="flex gap-2 text-sm text-muted-foreground">
              <span>Default: {repo.defaultBranch}</span>
              {repo.latestCommitSha && (
                <span className="font-mono">{repo.latestCommitSha.slice(0, 7)}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              authedFetch(`/api/automation/sync`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repo: repo.fullName }),
              }).then(() => window.location.reload());
            }}
          >
            <RefreshCw className="h-4 w-4 mr-2" /> Sync
          </Button>
          <Button variant="outline" asChild>
            <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4 mr-2" /> GitHub
            </a>
          </Button>
        </div>
      </div>

      {repo.syncError && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <span>Sync error: {repo.syncError}</span>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Workflows</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{repo.workflows.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Releases</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{repo.releases.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Open PRs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{repo.openPRCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Status</CardTitle>
          </CardHeader>
          <CardContent>
            {repo.failingRuns > 0 && (
              <div className="text-2xl font-bold text-destructive flex items-center gap-1">
                <XCircle className="h-5 w-5" /> {repo.failingRuns} failing
              </div>
            )}
            {repo.runningRuns > 0 && (
              <div className="text-2xl font-bold text-blue-600 flex items-center gap-1">
                <Clock className="h-5 w-5" /> {repo.runningRuns} running
              </div>
            )}
            {repo.failingRuns === 0 && repo.runningRuns === 0 && (
              <div className="text-2xl font-bold text-green-600 flex items-center gap-1">
                <CheckCircle className="h-5 w-5" /> all clear
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Workflows</CardTitle>
        </CardHeader>
        <CardContent>
          {repo.workflows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No workflows found</p>
          ) : (
            <div className="space-y-4">
              {repo.workflows.map((wf) => (
                <div key={wf.id} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Link href={`/automation/workflows/${wf.id}`} className="font-medium hover:underline">
                        {wf.name}
                      </Link>
                      <StatusBadge status={wf.state} />
                      <span className="text-xs text-muted-foreground">{wf.path}</span>
                    </div>
                    {wf.runs[0] && (
                      <span className="text-sm text-muted-foreground">
                        Last run: {new Date(wf.runs[0].runStartedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {wf.runs.length > 0 && (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Status</TableHead>
                          <TableHead>Branch</TableHead>
                          <TableHead>Actor</TableHead>
                          <TableHead>Duration</TableHead>
                          <TableHead>Started</TableHead>
                          <TableHead></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {wf.runs.slice(0, 5).map((run) => (
                          <TableRow key={run.id}>
                            <TableCell><StatusBadge status={run.conclusion || run.status} /></TableCell>
                            <TableCell className="font-mono text-xs">{run.branch}</TableCell>
                            <TableCell>{run.actor}</TableCell>
                            <TableCell><Duration seconds={run.durationSecs} /></TableCell>
                            <TableCell className="text-muted-foreground">{new Date(run.runStartedAt).toLocaleString()}</TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                <Button variant="ghost" size="sm" asChild>
                                  <a href={`https://github.com/${repo.fullName}/actions/runs/${run.runId}`} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                </Button>
                                {run.status === "completed" && run.conclusion === "failure" && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      authedFetch(`/api/automation/runs/${run.runId}?repo=${repo.fullName}&action=rerun`, { method: "POST" })
                                        .then(() => window.location.reload());
                                    }}
                                  >
                                    <RefreshCw className="h-3 w-3" />
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Releases</CardTitle>
        </CardHeader>
        <CardContent>
          {repo.releases.length === 0 ? (
            <p className="text-muted-foreground text-sm">No releases found</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tag</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Published</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repo.releases.map((rel) => (
                  <TableRow key={rel.id}>
                    <TableCell>
                      <a href={rel.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-mono text-sm">
                        {rel.tagName}
                      </a>
                    </TableCell>
                    <TableCell>{rel.name || "-"}</TableCell>
                    <TableCell>
                      {rel.draft && <Badge variant="secondary">draft</Badge>}
                      {rel.prerelease && <Badge variant="secondary">pre-release</Badge>}
                      {!rel.draft && !rel.prerelease && <Badge className="bg-green-100 text-green-700">stable</Badge>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{new Date(rel.publishedAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {repo.packages.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Packages / Images</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Latest Tag</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repo.packages.map((pkg) => (
                  <TableRow key={pkg.id}>
                    <TableCell>
                      <a href={pkg.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        {pkg.name}
                      </a>
                    </TableCell>
                    <TableCell><Badge variant="secondary">{pkg.packageType}</Badge></TableCell>
                    <TableCell><Badge variant="outline">{pkg.visibility}</Badge></TableCell>
                    <TableCell className="font-mono text-sm">{pkg.latestTag || "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {repo.recentEvents.length === 0 ? (
            <p className="text-muted-foreground text-sm">No recent activity</p>
          ) : (
            <div className="space-y-2">
              {repo.recentEvents.map((event) => (
                <div key={event.id} className="flex items-start gap-3 text-sm">
                  <div className="flex-1">
                    <span className="font-medium">{event.title}</span>
                    {event.description && (
                      <p className="text-muted-foreground text-xs">{event.description}</p>
                    )}
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {repo.lastSyncRun && (
        <Card>
          <CardHeader>
            <CardTitle>Last Sync</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status:</span>
                <StatusBadge status={repo.lastSyncRun.status} />
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Workflows:</span>
                <span>{repo.lastSyncRun.workflowsFetched}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Runs:</span>
                <span>{repo.lastSyncRun.runsFetched}</span>
              </div>
              {repo.lastSyncRun.errorMessage && (
                <div className="text-destructive text-xs mt-2">{repo.lastSyncRun.errorMessage}</div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}