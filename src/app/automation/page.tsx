"use client";

import { useEffect, useState } from "react";
import { authedFetch } from "@/lib/client-auth";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/automation/status-badge";
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
  source: "env" | "user";
  workflows: { id: string; name: string; state: string }[];
  releases: { id: string; tagName: string; publishedAt: string }[];
  _count: { workflows: number; releases: number };
  failingRuns: number;
  runningRuns: number;
  enabled: boolean;
}

function RepoCard({ repo, onDelete }: { repo: RepoOverview; onDelete?: () => void }) {
  const latestWorkflow = repo.workflows[0];
  const latestRelease = repo.releases[0];
  const isStale = repo.lastSyncedAt && new Date(repo.lastSyncedAt) < new Date(Date.now() - 60 * 60 * 1000);

  return (
    <Card className={`${repo.syncError ? "border-destructive" : ""} min-w-0 overflow-hidden`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <Link href={`/automation/repos/${repo.fullName}`} className="hover:underline min-w-0">
            <CardTitle className="text-lg truncate">{repo.fullName}</CardTitle>
          </Link>
          <div className="flex items-center gap-2 shrink-0">
            {repo.source === "env" && (
              <Badge variant="secondary" title="Seeded from GITHUB_REPOSITORIES env var">seed</Badge>
            )}
            {repo.syncError && <AlertTriangle className="h-5 w-5 text-destructive" />}
          </div>
        </div>
        <div className="flex gap-2 text-sm text-muted-foreground min-w-0">
          <span className="flex items-center gap-1 shrink-0">
            <GitBranch className="h-3 w-3" />
            {repo.defaultBranch}
          </span>
          {repo.latestCommitSha && (
            <span className="font-mono text-xs truncate">{repo.latestCommitSha.slice(0, 7)}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {repo.syncError ? (
          <div className="text-sm text-destructive break-words">{repo.syncError}</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="min-w-0">
                <span className="text-muted-foreground">Workflows:</span> {repo._count.workflows}
              </div>
              <div className="min-w-0">
                <span className="text-muted-foreground">Releases:</span> {repo._count.releases}
              </div>
              <div className="min-w-0">
                <span className="text-muted-foreground">Open PRs:</span> {repo.openPRCount}
              </div>
              <div className="flex items-center gap-1 flex-wrap">
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
              <div className="text-sm min-w-0 flex items-center gap-1 flex-wrap">
                <span className="text-muted-foreground shrink-0">Latest:</span>
                <StatusBadge status={latestWorkflow.state} />
                <span className="truncate">{latestWorkflow.name}</span>
              </div>
            )}

            {latestRelease && (
              <div className="text-sm min-w-0 flex items-center gap-1 flex-wrap">
                <span className="text-muted-foreground shrink-0">Release:</span>
                <a
                  href={`https://github.com/${repo.fullName}/releases/tag/${latestRelease.tagName}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline truncate"
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

        <div className="flex gap-2 pt-2 flex-wrap">
          <Button variant="outline" size="sm" asChild className="text-xs">
            <Link href={`/automation/repos/${repo.fullName}`}>Details</Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              authedFetch(`/api/automation/sync`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repo: repo.fullName }),
              }).then(() => window.location.reload());
            }}
            className="text-xs"
          >
            <RefreshCw className="h-3 w-3 mr-1" /> Sync
          </Button>
          <Button variant="ghost" size="sm" asChild className="text-xs">
            <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3 mr-1" /> GitHub
            </a>
          </Button>
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              className="text-destructive hover:text-destructive text-xs"
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
  const [loadError, setLoadError] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [blockedCount, setBlockedCount] = useState<number | null>(null);

  useEffect(() => {
    authedFetch("/api/automation/repos")
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.error || "Failed to load repositories");
        }
        if (!Array.isArray(data)) {
          throw new Error("Repository API returned an unexpected response");
        }
        setRepos(data);
        setLoadError("");
      })
      .catch((error) => {
        setRepos([]);
        setLoadError(error instanceof Error ? error.message : "Failed to load repositories");
      })
      .finally(() => setLoading(false));

    authedFetch("/api/pr-fix-queue/queued?include_blocked=true&prioritize_by_type=false")
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (res.ok && Array.isArray(data)) {
          setBlockedCount(data.filter((i: any) => i.status === "BLOCKED").length);
        }
      })
      .catch((error) => {
        console.error("Failed to load PR fix queue:", error);
      });
  }, []);

  async function syncAll() {
    setSyncing(true);
    try {
      await authedFetch("/api/automation/sync", { method: "POST" });
      const res = await authedFetch("/api/automation/repos");
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Failed to load repositories");
      }
      if (!Array.isArray(data)) {
        throw new Error("Repository API returned an unexpected response");
      }
      setRepos(data);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to sync repositories");
    } finally {
      setSyncing(false);
    }
  }

  async function addRepo() {
    if (!newRepo.trim()) return;
    setAddLoading(true);
    setAddError("");
    try {
      const res = await authedFetch("/api/automation/repos", {
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
      const res2 = await authedFetch("/api/automation/repos");
      const data2 = await res2.json();
      if (res2.ok && Array.isArray(data2)) {
        setRepos(data2);
        setLoadError("");
      }
    } catch {
      setAddError("Failed to add repo");
    } finally {
      setAddLoading(false);
    }
  }

  async function deleteRepo(fullName: string) {
    if (!confirm(`Stop tracking ${fullName}? Cached issues will be hidden from the board but kept for history.`)) {
      return;
    }
    try {
      const res = await authedFetch(`/api/automation/repos/${encodeURIComponent(fullName)}`, {
        method: "DELETE",
      });
      if (!res.ok) return;
      setRepos(repos.filter((r) => r.fullName !== fullName));
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
          <Button variant="outline" asChild>
            <Link href="/groomer">Hosted Groomer</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/automation/pr-fix-queue">
              PR Fix Queue
              {blockedCount !== null && blockedCount > 0 && (
                <Badge variant="destructive" className="ml-1">{blockedCount}</Badge>
              )}
            </Link>
          </Button>
          <Button variant="outline" onClick={() => setShowAddForm(!showAddForm)}>
            {showAddForm ? "Cancel" : "Add Repo"}
          </Button>
          <Button onClick={syncAll} disabled={syncing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing..." : "Sync All"}
          </Button>
        </div>
      </div>

      {loadError && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-sm text-destructive">{loadError}</CardContent>
        </Card>
      )}

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
            <RepoCard key={repo.id} repo={repo} onDelete={() => deleteRepo(repo.fullName)} />
          ))}
        </div>
      )}
    </div>
  );
}
