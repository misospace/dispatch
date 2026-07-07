import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, Clock } from "lucide-react";

/**
 * Shared status badge for automation views (repos, workflows, runs, sync runs).
 * Handles the union of statuses previously rendered by per-page copies.
 */
export function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge variant="secondary">unknown</Badge>;
  switch (status) {
    case "success":
      return <Badge className="bg-green-100 text-green-700"><CheckCircle className="h-3 w-3 mr-1" /> success</Badge>;
    case "failure":
      return <Badge className="bg-red-100 text-red-700"><XCircle className="h-3 w-3 mr-1" /> failed</Badge>;
    case "in_progress":
      return <Badge className="bg-blue-100 text-blue-700"><Clock className="h-3 w-3 mr-1" /> running</Badge>;
    case "queued":
      return <Badge className="bg-yellow-100 text-yellow-700"><Clock className="h-3 w-3 mr-1" /> queued</Badge>;
    case "cancelled":
      return <Badge variant="secondary"><XCircle className="h-3 w-3 mr-1" /> cancelled</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

/** Human-readable duration for workflow run lengths. */
export function Duration({ seconds }: { seconds: number | null }) {
  if (!seconds) return <span className="text-muted-foreground">-</span>;
  if (seconds < 60) return <span>{seconds}s</span>;
  if (seconds < 3600) return <span>{Math.floor(seconds / 60)}m {seconds % 60}s</span>;
  return <span>{Math.floor(seconds / 3600)}h {Math.floor((seconds % 3600) / 60)}m</span>;
}
