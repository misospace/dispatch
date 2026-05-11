"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, ExternalLink, AlertTriangle, CheckCircle, XCircle, Clock, GitBranch, Trash2 } from "lucide-react";

interface RepoOverview {
  id: string;
  fullName: string;
  name: string;
  owner: string;
  defaultBranch: string;
  latestCommitSha: string | null;
  openPRCount: number;
  lastSyncedAt: string | null;
  syncError: string | null;
  workflows: { id: string; name: string; state: string }[];
  releases: { id: string; tagName: string; publishedAt: string }[];
  _count: { workflows: number; releases: number };
  failingRuns: number;
  runningRuns: number;
  enabled: boolean;
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
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function RepoCard({ repo, onDelete }: { repo: RepoOverview; onDelete?: () => void }) {
  const latestWorkflow = repo.workflows[0];
  const latestRelease = repo.releases[0];
  const isStale = repo.lastSyncedAt && new Date(repo.lastSyncedAt) < new Date(Date.now() - 60 * 60 * 1000);

  return (
    <Card className={repo.syncError ? "border-destructive" : ""}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <Link href={`/automation/repos/${repo.fullName}`} className="hover:underline">
            <CardTitle className="text-lg">{repo.fullName}</CardTitle>
          </Link>
          {repo.syncError && <AlertTriangle className="h-5 w-5 text-destructive" />}
        </div>
        <div className="flex gap-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            {repo.defaultBranch}
          </span>
          {repo.latestCommitSha && (
            <span className="font-mono text-xs">{repo.latestCommitSha.slice(0, 7)}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {repo.syncError ? (
          <div className="text-sm text-destructive">{repo.syncError}</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-muted-foreground">Workflows:</span> {repo._count.workflows}
              </div>
              <div>
                <span className="text-muted-foreground">Releases:</span> {repo._count.releases}
              </div>
              <div>
                <span className="text-muted-foreground">Open PRs:</span> {repo.openPRCount}
              </div>
              <div className="flex items-center gap-1">
                {repo.failingRuns > 0 && (
                  <span className="text-destructive flex items-center gap-1">
                    <XCircle className="h-3 w-3" /> {repo.failingRuns} failing
                  </span>
                )}
                {repo.runningRuns > 0 && (
                  <span className="text-blue-600 flex items-center gap-1">
                    <Clock className="h-3 w-3" /> {repo.runningRuns} running
                  </span>
                )}
                {repo.failingRuns === 0 && repo.runningRuns === 0 && (
                  <span className="text-green-600 flex items-center gap-1">
                    <CheckCircle className="h-3 w-3" /> all clear
                  </span>
                )}
              </div>
            </div>

            {latestWorkflow && (
              <div className="text-sm">
                <span className="text-muted-foreground">Latest: </span>
                <StatusBadge status={latestWorkflow.state} />
                <span className="ml-1">{latestWorkflow.name}</span>
              </div>
            )}

            {latestRelease && (
              <div className="text-sm">
                <span className="text-muted-foreground">Latest release: </span>
                <a
                  href={`https://github.com/${repo.fullName}/releases/tag/${latestRelease.tagName}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {latestRelease.tagName}
                </a>
              </div>
            )}

            {isStale && (
              <div className="text-xs text-muted-foreground">
                Last synced: {new Date(repo.lastSyncedAt!).toLocaleString()}
              </div>
            )}
          </>
        )}

        <div className="flex gap-2 pt-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/automation/repos/${repo.fullName}`}>Details</Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              fetch(`/api/automation/sync`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repo: repo.fullName }),
              }).then(() => window.location.reload());
            }}
          >
            <RefreshCw className="h-3 w-3 mr-1" /> Sync
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3 mr-1" /> GitHub
            </a>
          </Button>
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3 w-3 mr-1" /> Remove
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AutomationOverview() {
  const [repos, setRepos] = useState<RepoOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newRepo, setNewRepo] = useState("");
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  useEffect(() => {
    fetch("/api/automation/sync")
      .then((res) => res.json())
      .catch(() => ({}));
    fetch("/api/automation/repos")
      .then((res) => res.json())
      .then((data) => setRepos(data))
      .catch(() => setRepos([]))
      .finally(() => setLoading(false));
  }, []);

  async function syncAll() {
    setSyncing(true);
    try {
      await fetch("/api/automation/sync", { method: "POST" });
      const res = await fetch("/api/automation/repos");
      const data = await res.json();
      setRepos(data);
    } finally {
      setSyncing(false);
    }
  }

  async function addRepo() {
    if (!newRepo.trim()) return;
    setAddLoading(true);
    setAddError("");
    try {
      const res = await fetch("/api/automation/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: newRepo.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.error || "Failed to add repo");
        return;
      }
      setNewRepo("");
      setShowAddForm(false);
      const res2 = await fetch("/api/automation/repos");
      const data2 = await res2.json();
      setRepos(data2);
    } catch {
      setAddError("Failed to add repo");
    } finally {
      setAddLoading(false);
    }
  }

  async function deleteRepo(id: string) {
    try {
      await fetch(`/api/automation/repositories/${id}`, { method: "DELETE" });
      setRepos(repos.filter((r) => r.id !== id));
    } catch {
      // ignore
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Automation</h1>
          <p className="text-muted-foreground">CI/CD, builds, releases, and workflow status</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowAddForm(!showAddForm)}>
            {showAddForm ? "Cancel" : "Add Repo"}
          </Button>
          <Button onClick={syncAll} disabled={syncing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing..." : "Sync All"}
          </Button>
        </div>
      </div>

      {showAddForm && (
        <Card>
          <CardContent className="pt-4">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="owner/repo (e.g. myorg/myrepo)"
                value={newRepo}
                onChange={(e) => setNewRepo(e.target.value)}
                className="flex-1 h-9 px-3 rounded-md border border-input bg-background text-sm"
                onKeyDown={(e) => e.key === "Enter" && addRepo()}
              />
              <Button onClick={addRepo} disabled={addLoading || !newRepo.trim()}>
                {addLoading ? "Adding..." : "Add"}
              </Button>
            </div>
            {addError && <p className="text-sm text-destructive mt-2">{addError}</p>}
          </CardContent>
        </Card>
      )}

      {repos.length === 0 && !showAddForm ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">No repositories configured.</p>
            <p className="text-sm text-muted-foreground mt-1">
              Click &quot;Add Repo&quot; to track your first repository, or set GITHUB_REPOSITORIES environment variable.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {repos.map((repo) => (
            <RepoCard key={repo.id} repo={repo} onDelete={() => deleteRepo(repo.id)} />
          ))}
        </div>
      )}
    </div>
  );
}