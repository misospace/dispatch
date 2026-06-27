"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { authedFetch } from "@/lib/client-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExternalLink, RefreshCw } from "lucide-react";

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

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "completed" || status === "dry_run_completed"
      ? "bg-green-100 text-green-700"
      : status === "failed"
        ? "bg-red-100 text-red-700"
        : "bg-blue-100 text-blue-700";
  return <Badge className={cls}>{status.replace(/_/g, " ")}</Badge>;
}

export default function GroomerHistoryPage() {
  const [runs, setRuns] = useState<GroomingRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Hosted Groomer</h1>
          <p className="text-muted-foreground">
            Visible history for Dispatch-hosted issue grooming runs.
          </p>
        </div>
        <Button variant="outline" onClick={loadRuns}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

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
