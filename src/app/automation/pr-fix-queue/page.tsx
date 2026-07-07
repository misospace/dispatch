"use client";

import { useEffect, useState, useCallback } from "react";
import { authedFetch } from "@/lib/client-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";

interface PrFixItem {
  id: string;
  repo: string;
  pr: number;
  status: string;
  lane: string;
  reason: string;
  title: string | null;
  url: string | null;
  queuedAt: string;
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleString();
}

function prLink(item: PrFixItem): string {
  return item.url ?? `https://github.com/${item.repo}/pull/${item.pr}`;
}

function prTitle(item: PrFixItem): string {
  return item.title ?? `${item.repo}#${item.pr}`;
}

export default function PrFixQueuePage() {
  const [items, setItems] = useState<PrFixItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const res = await authedFetch("/api/pr-fix-queue/queued?include_blocked=true&prioritize_by_type=false");
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || "Failed to load PR fix queue");
      }
      setItems(Array.isArray(data) ? data : []);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load PR fix queue");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const blocked = items.filter((i) => i.status === "BLOCKED");
  const queued = items.filter((i) => i.status === "QUEUED");

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">PR Fix Queue</h1>
          <p className="text-muted-foreground">BLOCKED items need human attention; QUEUED items are waiting on automation.</p>
        </div>
        <Button variant="outline" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <Card className={blocked.length > 0 ? "border-destructive" : ""}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Blocked — needs human
            {blocked.length > 0 && (
              <Badge variant="destructive" className="ml-2">{blocked.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {blocked.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">No blocked items.</p>
              <p className="text-sm text-muted-foreground mt-1">
                BLOCKED items appear here when a PR fix requires human intervention.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repo / PR</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Lane</TableHead>
                  <TableHead>Queued At</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {blocked.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="font-medium text-sm">{prTitle(item)}</div>
                      <div className="text-xs text-muted-foreground">{item.repo}</div>
                    </TableCell>
                    <TableCell className="text-sm text-destructive max-w-xs truncate">{item.reason}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={item.lane === "NEEDS_HUMAN" ? "bg-red-100 text-red-700" : ""}>
                        {item.lane}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatTime(item.queuedAt)}</TableCell>
                    <TableCell>
                      <a
                        href={prLink(item)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-primary"
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Queued
            {queued.length > 0 && (
              <Badge className="bg-yellow-100 text-yellow-700">{queued.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {queued.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">No queued items.</p>
              <p className="text-sm text-muted-foreground mt-1">
                QUEUED items are waiting for automation to process.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repo / PR</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Lane</TableHead>
                  <TableHead>Queued At</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queued.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="font-medium text-sm">{prTitle(item)}</div>
                      <div className="text-xs text-muted-foreground">{item.repo}</div>
                    </TableCell>
                    <TableCell className="text-sm max-w-xs truncate">{item.reason}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{item.lane}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatTime(item.queuedAt)}</TableCell>
                    <TableCell>
                      <a
                        href={prLink(item)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-primary"
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
