"use client";
import { useCallback, useEffect, useState } from "react";
import { authedFetch } from "@/lib/client-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExternalLink, RefreshCw } from "lucide-react";
import {
  NEEDS_ATTENTION_CATEGORIES,
  type NeedsAttentionItem,
  type NeedsAttentionSnapshot,
} from "@/lib/needs-attention";

const CATEGORY_META = new Map(NEEDS_ATTENTION_CATEGORIES.map((c) => [c.category, c]));

function formatAge(iso: string, now: string): string {
  const ms = Math.max(0, new Date(now).getTime() - new Date(iso).getTime());
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function identity(item: NeedsAttentionItem): string {
  if (item.repo && item.prNumber) return `${item.repo}#${item.prNumber}`;
  if (item.repo && item.issueNumber) return `${item.repo}#${item.issueNumber}`;
  return item.title;
}

function ItemRow({ item, now }: { item: NeedsAttentionItem; now: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{item.title}</span>
          <span className="text-muted-foreground text-sm">{identity(item)}</span>
        </div>
        <div className="text-sm text-muted-foreground">{item.reason}</div>
        {item.decision?.question ? (
          <div className="mt-1 text-sm">
            <span className="font-medium">Decision needed:</span> {item.decision.question}
          </div>
        ) : null}
        {item.decision && item.decision.options.length > 0 ? (
          <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
            {item.decision.options.map((option, i) => (
              <li key={i}>{option}</li>
            ))}
          </ul>
        ) : null}
        {item.decision?.evidence ? (
          <div className="mt-1 text-sm text-muted-foreground">Evidence: {item.decision.evidence}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="outline">{formatAge(item.ageStartedAt, now)}</Badge>
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer" aria-label={`Open ${identity(item)}`}>
            <Button variant="outline" size="sm">
              <ExternalLink className="mr-1 h-3 w-3" />
              Open
            </Button>
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function NeedsAttentionClient() {
  const [data, setData] = useState<NeedsAttentionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await authedFetch("/api/needs-attention");
      if (!res.ok) throw new Error(`needs-attention fetch failed: ${res.status}`);
      const snapshot = (await res.json()) as NeedsAttentionSnapshot;
      setData(snapshot);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load needs-attention snapshot");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  const groups = NEEDS_ATTENTION_CATEGORIES.map((meta) => ({
    ...meta,
    items: (data?.items ?? []).filter((item) => item.category === meta.category),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Needs Attention</h1>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
      {error ? <div className="text-sm text-red-500">{error}</div> : null}
      {groups.length === 0 && !loading && !error ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="font-medium">Nothing needs attention.</p>
            <p className="text-sm text-muted-foreground">
              Healthy, queued, and transient retry work is intentionally not listed here.
            </p>
          </CardContent>
        </Card>
      ) : null}
      {groups.map((group) => (
        <Card key={group.category}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {group.label}
              <Badge variant="secondary">{group.items.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {group.items.map((item) => (
              <ItemRow key={item.id} item={item} now={data?.now ?? new Date().toISOString()} />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}