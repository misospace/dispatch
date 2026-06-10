"use client";

import { authedFetch } from "@/lib/client-auth";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExternalLink, RefreshCw, GitBranch } from "lucide-react";

interface Event {
  id: string;
  eventType: string;
  title: string;
  description: string | null;
  actor: string | null;
  url: string | null;
  sha: string | null;
  branch: string | null;
  status: string | null;
  createdAt: string;
  repo: { fullName: string; name: string };
}

function EventTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    workflow_run: "bg-blue-100 text-blue-700",
    workflow_run_started: "bg-blue-100 text-blue-700",
    workflow_run_completed: "bg-green-100 text-green-700",
    workflow_run_failed: "bg-red-100 text-red-700",
    release: "bg-purple-100 text-purple-700",
    release_published: "bg-purple-100 text-purple-700",
    pr: "bg-yellow-100 text-yellow-700",
    pr_opened: "bg-yellow-100 text-yellow-700",
    pr_merged: "bg-green-100 text-green-700",
    sync_completed: "bg-gray-100 text-gray-700",
    security_scan: "bg-red-100 text-red-700",
  };

  return (
    <Badge className={colors[type] || "bg-gray-100 text-gray-700"}>
      {type.replace(/_/g, " ")}
    </Badge>
  );
}

export default function ActivityFeedPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authedFetch("/api/automation/events?limit=100")
      .then((res) => res.json())
      .then((data) => setEvents(data))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Activity Feed</h1>
          <p className="text-muted-foreground">Unified automation events across all repos</p>
        </div>
        <Badge variant="secondary">{events.length} events</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Events</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">No events recorded yet.</p>
              <p className="text-sm text-muted-foreground mt-1">
                Events are recorded when syncing repositories and performing control actions.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Branch/SHA</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell><EventTypeBadge type={event.eventType} /></TableCell>
                    <TableCell>
                      <div className="font-medium text-sm">{event.title}</div>
                      {event.description && (
                        <div className="text-xs text-muted-foreground">{event.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{event.repo.fullName}</TableCell>
                    <TableCell className="text-sm">{event.actor || "-"}</TableCell>
                    <TableCell>
                      {event.branch && (
                        <div className="flex items-center gap-1 text-xs font-mono">
                          <GitBranch className="h-3 w-3" />
                          {event.branch}
                        </div>
                      )}
                      {event.sha && (
                        <div className="font-mono text-xs text-muted-foreground">
                          {event.sha.slice(0, 7)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(event.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {event.url && (
                        <a
                          href={event.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-primary"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
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