"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { authedFetch } from "@/lib/client-auth";

interface SyncResult {
  repo: string;
  synced: number;
  error: string | null;
}

interface SyncResponse {
  success?: boolean;
  repos?: number;
  syncedCount?: number;
  results?: SyncResult[];
  error?: string;
}

export function SyncIssuesButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function syncIssues() {
    setIsSyncing(true);
    setMessage(null);
    setError(null);

    try {
      const response = await authedFetch("/api/sync", { method: "POST" });
      const data = (await response.json()) as SyncResponse;

      if (!response.ok) {
        throw new Error(data.error || "Issue sync failed");
      }

      const failedRepos = data.results?.filter((result) => result.error) ?? [];
      const syncedCount = data.syncedCount ?? 0;
      const repoCount = data.repos ?? 0;

      if (failedRepos.length > 0) {
        setError(
          `Synced ${syncedCount} issues from ${repoCount - failedRepos.length}/${repoCount} repos. ${failedRepos.length} repos failed.`
        );
      } else {
        setMessage(`Synced ${syncedCount} issues from ${repoCount} repos.`);
      }

      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Issue sync failed");
    } finally {
      setIsSyncing(false);
    }
  }

  const busy = isSyncing || isPending;

  return (
    <div className="space-y-2">
      <Button onClick={syncIssues} disabled={busy}>
        {busy ? "Syncing..." : "Sync Issues"}
      </Button>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
