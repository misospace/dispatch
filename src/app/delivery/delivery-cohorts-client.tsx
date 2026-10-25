"use client";

import { useCallback, useEffect, useState } from "react";
import { authedFetch } from "@/lib/client-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, RefreshCw } from "lucide-react";

const GROUP_BY_OPTIONS = [
  { value: "cohort", label: "Cohort" },
  { value: "model", label: "Model" },
  { value: "worker", label: "Worker" },
  { value: "runtimeRevision", label: "Runtime revision" },
  { value: "reasoningEffort", label: "Reasoning effort" },
  { value: "repository", label: "Repository" },
  { value: "taskType", label: "Task type" },
] as const;

type GroupBy = (typeof GROUP_BY_OPTIONS)[number]["value"];

type Provenance = "observed" | "backfilled" | "unknown";

type Delivery = "merged" | "closed-unmerged" | "open" | "unknown";

type MissingField = "claim" | "done" | "merge" | "attempts" | "metadata";

interface DurationStats {
  samples: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
}

interface CohortStats {
  key: string;
  sampleCount: number;
  delivery: Record<Delivery, number>;
  completionRate: number | null;
  claimToDone: DurationStats | null;
  claimToMerge: DurationStats | null;
  workerTimeMs: number | null;
  firstPass: { true: number; false: number; null: number };
  mergedThroughputPerDay: number;
  openAges: { count: number; medianOpenMs: number | null; oldestOpenMs: number | null };
  fixRounds: { total: number; itemsWithFixes: number };
  waiting: { activeExecutionMs: number; unclassifiedMs: number };
  confounders: {
    mixedSettings: number;
    missingMetadata: number;
    distinctRuntimeRevisions: string[];
    distinctModels: string[];
    distinctWorkers: string[];
  };
}

interface DeliverySample {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  delivery: Delivery;
  firstClaimAt: string | null;
  firstMergedAt: string | null;
  doneAt: string | null;
  doneAtProvenance: Provenance | null;
  claimToDoneMs: number | null;
  claimToMergeMs: number | null;
  workerTimeMs: number | null;
  unclassifiedMs: number | null;
  firstPass: boolean | null;
  executionAttempts: number;
  fixRounds: number;
  failedAttempts: number;
  cohortKeys: {
    cohort: string;
    model: string;
    worker: string;
    runtimeRevision: string;
    reasoningEffort: string;
    repository: string;
    taskType: string;
  };
  mixedSettings: boolean;
  settings: {
    worker: string | null;
    model: string | null;
    reasoningEffort: string | null;
    runtimeRevision: string | null;
  };
  missing: MissingField[];
  excludedFromDurations: boolean;
  ageMs: number | null;
  taskType: string;
}

interface DeliveryCohortsResponse {
  schema: string;
  definitions: Record<string, string>;
  window: { since: string; until: string };
  groupBy: string;
  repo: string | null;
  totals: CohortStats;
  cohorts: CohortStats[];
  samples?: DeliverySample[];
  sampleCount: number;
  truncated: boolean;
  notes: string[];
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "unknown";
  const sign = ms < 0 ? "-" : "";
  const t = Math.abs(Math.round(ms));
  const d = Math.floor(t / 86_400_000);
  const h = Math.floor((t % 86_400_000) / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  if (d > 0) return `${sign}${d}d ${h}h`;
  if (h > 0) return `${sign}${h}h ${m}m`;
  return `${sign}${m}m`;
}

function formatTimestamp(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "unknown";
}

function rateText(rate: number | null | undefined): string {
  return rate == null ? "unknown" : `${(rate * 100).toFixed(1)}%`;
}

function msTitle(parts: (string | number | null | undefined)[]): string {
  return parts
    .map((p) => (p == null ? "unknown" : String(p)))
    .join(" · ");
}

function DurationCell({ d, unknown }: { d: DurationStats | null; unknown: number }) {
  if (!d) {
    return <span className="text-muted-foreground">unknown</span>;
  }
  return (
    <span
      title={msTitle([
        `min ${d.min} ms`,
        `max ${d.max} ms`,
        `mean ${Math.round(d.mean)} ms`,
        `p50 ${d.p50} ms`,
        `p90 ${d.p90} ms`,
        `n=${d.samples}`,
      ])}
    >
      {formatMs(d.p50)} (n={d.samples})
      <span className="block text-xs text-muted-foreground">p90 {formatMs(d.p90)}</span>
      {unknown > 0 && (
        <span className="block text-xs text-muted-foreground">{unknown} unknown</span>
      )}
    </span>
  );
}

function ConfoundersCell({ c }: { c: CohortStats["confounders"] }) {
  const badges: { label: string; amber: boolean }[] = [];
  if (c.mixedSettings > 0) badges.push({ label: `mixed settings: ${c.mixedSettings}`, amber: true });
  if (c.missingMetadata > 0) badges.push({ label: `missing metadata: ${c.missingMetadata}`, amber: true });
  if (c.distinctModels.length > 1) badges.push({ label: `${c.distinctModels.length} models`, amber: false });
  if (c.distinctRuntimeRevisions.length > 1)
    badges.push({ label: `${c.distinctRuntimeRevisions.length} revisions`, amber: false });
  if (c.distinctWorkers.length > 1) badges.push({ label: `${c.distinctWorkers.length} workers`, amber: false });
  if (badges.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <Badge key={b.label} className={b.amber ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-700"}>
          {b.label}
        </Badge>
      ))}
    </span>
  );
}

function DeliveryBadge({ d }: { d: Delivery }) {
  const tone =
    d === "merged"
      ? "bg-green-100 text-green-800"
      : d === "closed-unmerged"
        ? "bg-red-100 text-red-700"
        : d === "open"
          ? "bg-blue-100 text-blue-700"
          : "bg-gray-100 text-gray-600";
  return <Badge className={tone}>{d}</Badge>;
}

function ProvenanceBadge({ p }: { p: Provenance | null | undefined }) {
  if (p !== "backfilled") return null;
  return <Badge variant="outline" className="ml-1 px-1.5 py-0">backfilled</Badge>;
}

function FirstPassCell({ v }: { v: boolean | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground">unknown</span>;
  return v ? "yes" : "no";
}

function exclusionNote(s: DeliverySample): string | null {
  if (!s.excludedFromDurations) return null;
  return s.ageMs != null
    ? `open ${formatMs(s.ageMs)} · excluded from duration stats`
    : "excluded from duration stats";
}

function Select({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly { value: string; label: string }[];
  ariaLabel: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function CohortRow({ c, keyLabel }: { c: CohortStats; keyLabel: string }) {
  const totals = c.key === "all";
  const completed = c.delivery.merged + c.delivery["closed-unmerged"];
  const doneUnknown = Math.max(0, completed - (c.claimToDone?.samples ?? 0));
  const mergeUnknown = Math.max(0, c.delivery.merged - (c.claimToMerge?.samples ?? 0));
  const fpKnown = c.firstPass.true + c.firstPass.false;
  const fpRate = fpKnown > 0 ? c.firstPass.true / fpKnown : null;
  return (
    <TableRow className={totals ? "bg-muted/40 font-semibold" : ""}>
      <TableCell className="max-w-48">
        <div className="truncate" title={c.key}>
          {c.key}
        </div>
        <div className="text-xs font-normal text-muted-foreground">{keyLabel}</div>
      </TableCell>
      <TableCell>
        {c.sampleCount}
        <div className="text-xs font-normal text-muted-foreground">
          {c.delivery.merged} merged · {c.delivery["closed-unmerged"]} closed-unmerged
        </div>
      </TableCell>
      <TableCell>
        {rateText(c.completionRate)}
        <div className="text-xs font-normal text-muted-foreground">
          open {c.delivery.open} · unknown {c.delivery.unknown}
        </div>
        {c.openAges.count > 0 && (
          <div className="text-xs font-normal text-muted-foreground">
            median open: {formatMs(c.openAges.medianOpenMs)} · oldest open: {formatMs(c.openAges.oldestOpenMs)}
          </div>
        )}
      </TableCell>
      <TableCell>
        <DurationCell d={c.claimToDone} unknown={doneUnknown} />
      </TableCell>
      <TableCell>
        <DurationCell d={c.claimToMerge} unknown={mergeUnknown} />
      </TableCell>
      <TableCell>
        <span title={msTitle([`throughput ${c.mergedThroughputPerDay} merged/day`])}>
          {c.mergedThroughputPerDay.toFixed(2)}
        </span>
      </TableCell>
      <TableCell>
        {rateText(fpRate)}
        <div className="text-xs font-normal text-muted-foreground">
          n={fpKnown} · passed {c.firstPass.true}
          {c.firstPass.null > 0 && ` · ${c.firstPass.null} unknown`}
        </div>
      </TableCell>
      <TableCell>
        {c.fixRounds.total}
        <div className="text-xs font-normal text-muted-foreground">
          {c.fixRounds.itemsWithFixes} with fixes
        </div>
      </TableCell>
      <TableCell>
        <span title={msTitle([`total ${c.workerTimeMs} ms`])}>
          {c.workerTimeMs == null ? (
            <span className="text-muted-foreground">unknown</span>
          ) : (
            formatMs(c.workerTimeMs)
          )}
          <span className="block text-xs font-normal text-muted-foreground">
            executing {formatMs(c.waiting.activeExecutionMs)} · unclassified {formatMs(c.waiting.unclassifiedMs)}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <ConfoundersCell c={c.confounders} />
      </TableCell>
    </TableRow>
  );
}

export function DeliveryCohortsClient() {
  const [days, setDays] = useState(30);
  const [groupBy, setGroupBy] = useState<GroupBy>("cohort");
  const [repoInput, setRepoInput] = useState("");
  const [repo, setRepo] = useState("");
  const [includeSamples, setIncludeSamples] = useState(true);
  const [data, setData] = useState<DeliveryCohortsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setRepo(repoInput.trim()), 500);
    return () => clearTimeout(t);
  }, [repoInput]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        days: String(days),
        groupBy,
        includeSamples: includeSamples ? "1" : "0",
        limit: "200",
      });
      if (repo) params.set("repo", repo);
      const res = await authedFetch(`/api/delivery-cohorts?${params.toString()}`);
      const raw: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          raw !== null && typeof raw === "object" && "error" in raw && typeof (raw as { error?: unknown }).error === "string"
            ? (raw as { error: string }).error
            : `Failed to load delivery cohorts (HTTP ${res.status})`;
        throw new Error(msg);
      }
      if (raw === null || typeof raw !== "object") throw new Error("Failed to load delivery cohorts");
      setData(raw as DeliveryCohortsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load delivery cohorts");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days, groupBy, repo, includeSamples]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading && !data) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  const groupByLabel =
    GROUP_BY_OPTIONS.find((o) => o.value === (data?.groupBy ?? groupBy))?.label ?? groupBy;
  const definitions = data ? Object.entries(data.definitions ?? {}) : [];
  const samples = data?.samples ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Delivery Cohorts</h1>
          <p className="text-muted-foreground">
            Full claim-to-merge cycles, compared across cohorts, models, workers,
            runtime revisions, reasoning efforts, repositories and task types.
            {data && (
              <span className="block text-sm mt-1">
                Window: {formatTimestamp(data.window.since)} → {formatTimestamp(data.window.until)}
                {data.repo ? ` · ${data.repo}` : ""}
              </span>
            )}
          </p>
        </div>
        <Button variant="outline" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 py-4">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Days</span>
            <Select
              ariaLabel="Window in days"
              value={String(days)}
              onChange={(v) => setDays(Number(v))}
              options={[
                { value: "7", label: "7" },
                { value: "30", label: "30" },
                { value: "90", label: "90" },
                { value: "365", label: "365" },
              ]}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Group by</span>
            <Select
              ariaLabel="Group by"
              value={groupBy}
              onChange={(v) => setGroupBy(v as GroupBy)}
              options={GROUP_BY_OPTIONS}
            />
          </label>
          <label className="flex items-center gap-2 text-sm flex-1 min-w-52">
            <span className="text-muted-foreground">Repo</span>
            <Input
              aria-label="Repository filter"
              placeholder="owner/repo (optional)"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={includeSamples}
              onChange={(e) => setIncludeSamples(e.target.checked)}
            />
            Show samples
          </label>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-sm text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </CardContent>
        </Card>
      )}

      <Card className={data?.truncated ? "border-amber-400" : "border-yellow-300"}>
        <CardContent className="py-4 text-sm text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">
            {data?.truncated ? "Truncated — caveats (read before comparing)" : "Honest-stats rules"}
          </p>
          <p>
            Duration percentiles (p50/p90, nearest-rank) cover completed items only —
            delivery merged or closed-unmerged. Open and unknown-delivery items are excluded
            from those percentiles, never treated as zero, but stay in sample counts,
            completion-rate denominators and open ages.
          </p>
          <p>
            Missing evidence is reported as “unknown”, never zeroed, and a lifecycle spanning
            settings is mixed — never attributed to the setting active at merge.
          </p>
          {data && data.notes.length > 0 && (
            <ul className="list-disc pl-5 space-y-1 pt-1">
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {definitions.length > 0 && (
        <Card>
          <CardContent className="py-4">
            <details>
              <summary className="cursor-pointer text-sm font-medium">Definitions</summary>
              <dl className="mt-2 space-y-2 text-sm">
                {definitions.map(([k, v]) => (
                  <div key={k}>
                    <dt className="font-medium">{k}</dt>
                    <dd className="text-muted-foreground">{v}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </CardContent>
        </Card>
      )}

      {data && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Comparison by {groupByLabel}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.cohorts.length === 0 && data.totals.sampleCount === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">No delivery data in the selected window.</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Try a wider window, a different group-by, or clear the repo filter.
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{groupByLabel}</TableHead>
                    <TableHead>Samples</TableHead>
                    <TableHead>Completion</TableHead>
                    <TableHead>Claim → Done</TableHead>
                    <TableHead>Claim → Merge</TableHead>
                    <TableHead>Merged/day</TableHead>
                    <TableHead>First pass</TableHead>
                    <TableHead>Fix rounds</TableHead>
                    <TableHead>Worker time</TableHead>
                    <TableHead>Confounders</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <CohortRow c={data.totals} keyLabel="totals" />
                  {data.cohorts.map((c) => (
                    <CohortRow key={c.key} c={c} keyLabel={groupByLabel.toLowerCase()} />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {includeSamples && data && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              Samples
              <Badge className="ml-2">
                {samples.length} of {data.sampleCount}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {samples.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">No samples in the selected window.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Issue</TableHead>
                    <TableHead>Delivery</TableHead>
                    <TableHead>Claimed / Done / Merged</TableHead>
                    <TableHead>Claim → Done</TableHead>
                    <TableHead>Claim → Merge</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Fix rounds</TableHead>
                    <TableHead>First pass</TableHead>
                    <TableHead>Worker time</TableHead>
                    <TableHead>Missing</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {samples.map((s) => {
                    const excluded = exclusionNote(s);
                    return (
                      <TableRow key={s.issueId}>
                        <TableCell>
                          <div className="font-medium text-sm">{s.issueId}</div>
                          <div className="text-xs text-muted-foreground">{s.taskType}</div>
                          {s.mixedSettings && (
                            <Badge className="mt-1 bg-amber-100 text-amber-800">mixed</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <DeliveryBadge d={s.delivery} />
                        </TableCell>
                        <TableCell className="text-sm">
                          <div>{formatTimestamp(s.firstClaimAt)}</div>
                          <div>
                            {formatTimestamp(s.doneAt)}
                            <ProvenanceBadge p={s.doneAtProvenance} />
                          </div>
                          <div>{formatTimestamp(s.firstMergedAt)}</div>
                          {excluded && (
                            <div className="text-xs text-muted-foreground">{excluded}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <span title={s.claimToDoneMs != null ? `${s.claimToDoneMs} ms` : undefined}>
                            {formatMs(s.claimToDoneMs)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span title={s.claimToMergeMs != null ? `${s.claimToMergeMs} ms` : undefined}>
                            {formatMs(s.claimToMergeMs)}
                          </span>
                        </TableCell>
                        <TableCell>
                          {s.executionAttempts} exec, {s.failedAttempts} failed
                        </TableCell>
                        <TableCell>{s.fixRounds}</TableCell>
                        <TableCell>
                          <FirstPassCell v={s.firstPass} />
                        </TableCell>
                        <TableCell>
                          <span title={s.workerTimeMs != null ? `${s.workerTimeMs} ms` : undefined}>
                            {formatMs(s.workerTimeMs)}
                          </span>
                          {s.unclassifiedMs != null && s.unclassifiedMs > 0 && (
                            <span className="block text-xs text-muted-foreground">
                              unclassified {formatMs(s.unclassifiedMs)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="flex flex-wrap gap-1">
                            {s.missing.length === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              s.missing.map((f) => (
                                <Badge key={f} variant="outline" className="px-1.5 py-0">
                                  {f}
                                </Badge>
                              ))
                            )}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
