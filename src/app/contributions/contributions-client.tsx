"use client";

import { useCallback, useEffect, useState } from "react";
import { authedFetch } from "@/lib/client-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { hasControlChars, isValidRepoName } from "@/lib/config-parsers";
import type { CourierSurfaceView } from "@/lib/external-contribution-view";
import { ExternalLink, RefreshCw } from "lucide-react";

/**
 * Operator contribution interface (#1539, parent #1349).
 *
 * The browser surface over the #1537/#1538 APIs. Every rule the API state
 * machines own stays owned by them: this page re-submits nothing on refresh,
 * shows a PR only when Courier's own projection recorded one, and treats a
 * missing lifecycle observation as unknown — never completion. Credentials
 * never reach here; the config panel renders presence booleans and the named
 * capability gaps produced server-side by `projectCourierSurface`.
 */

/** Client mirror of the shared projection (`external-contribution-view.ts`). */
interface ContributionRow {
  id: string;
  idempotencyKey: string;
  status: string;
  run: string | null;
  namespace: string;
  workItemId: string | null;
  resumed: boolean | null;
  baseRepo: string;
  baseRef: string;
  workRepo: string;
  lane: string;
  goal: string;
  upstreamIssue: string | null;
  attempts: number;
  lastError: string | null;
  tracking: {
    state: string | null;
    stale: boolean;
    phase: string | null;
    ciParked: boolean | null;
    cause: { category: string | null; outcome: string | null } | null;
    publication: { pr: string | null; branch: string | null; headRepo: string | null; headSha: string | null } | null;
    observedAt: string | null;
    phaseEnteredAt: string | null;
    finishedAt: string | null;
    checkedAt: string | null;
    lastError: string | null;
  };
  createdAt: string;
  updatedAt: string | null;
}

interface Notice {
  tone: "success" | "warning" | "error" | "info";
  text: string;
}

const NOTICE_TONES: Record<Notice["tone"], string> = {
  success: "border-green-300 text-green-800 dark:text-green-300",
  warning: "border-amber-300 text-amber-800 dark:text-amber-300",
  error: "border-destructive text-destructive",
  info: "border-sky-300 text-sky-800 dark:text-sky-300",
};

function noticeClass(tone: Notice["tone"]): string {
  return `rounded-md border px-3 py-2 text-sm ${NOTICE_TONES[tone]}`;
}

/**
 * One request identity per opened form (#1537 exactly-once): the key is
 * generated once and survives uncertain-delivery retries, so a retry replays
 * the SAME identity. It is rotated only when the identity is settled against
 * (rejection, payload conflict, exhausted budget) and an edit must become a
 * new request. `crypto.randomUUID` needs a secure context; a plain-HTTP
 * self-hosted Dispatch falls back to `getRandomValues`, then to Math.random.
 */
function newClientKey(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoObj?.randomUUID === "function") return cryptoObj.randomUUID();
  if (typeof cryptoObj?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `fallback-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 18)}`;
}

function formatTimestamp(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "unknown";
}

const DELIVERY_TONES: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  in_flight: "bg-blue-100 text-blue-700",
  accepted: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-700",
  uncertain: "bg-amber-100 text-amber-800",
};

function DeliveryBadge({ status }: { status: string }) {
  return (
    <Badge className={DELIVERY_TONES[status] ?? "bg-gray-100 text-gray-600"}>{status}</Badge>
  );
}

const TRACKING_TONES: Record<string, string> = {
  admitted: "bg-sky-100 text-sky-800",
  executing: "bg-blue-100 text-blue-700",
  published: "bg-green-100 text-green-800",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-700",
  unavailable: "bg-gray-100 text-gray-600",
  expired: "bg-amber-100 text-amber-800",
};

/**
 * Absence of a lifecycle observation is UNKNOWN, never completion: an
 * accepted request nobody has polled yet renders as "unobserved", not as any
 * success-flavoured state.
 */
function TrackingBadge({ state, stale }: { state: string | null; stale: boolean }) {
  if (!state) {
    return (
      <span className="inline-flex items-center gap-1">
        <Badge variant="outline" className="text-muted-foreground">
          unobserved
        </Badge>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Badge className={TRACKING_TONES[state] ?? "bg-gray-100 text-gray-600"}>{state}</Badge>
      {stale ? (
        <Badge variant="outline" className="border-amber-400 text-amber-700" title="No observation inside the freshness window — refresh for current evidence">
          stale
        </Badge>
      ) : null}
    </span>
  );
}

function PrLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm underline underline-offset-2"
      aria-label="Open the published pull request"
    >
      <ExternalLink className="h-3 w-3" />
      Pull request
    </a>
  );
}

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return <div className={noticeClass(notice.tone)} role="status">{notice.text}</div>;
}

/**
 * Mirror of the API-side shape bounds (`parseContributionInput`) so the
 * operator sees them before a 400. Lane stays bounded free text on purpose:
 * Courier owns lane semantics and the wire relays it verbatim, so this form
 * constrains its SHAPE with the same shared rules the server enforces —
 * never its VALUE. The privileged choice (namespace) is select-only.
 */
function validateForm(form: FormState, namespaces: string[]): string[] {
  const problems: string[] = [];
  if (!namespaces.includes(form.namespace.trim())) {
    problems.push("Choose one of the operator-approved namespaces.");
  }
  const lane = form.lane.trim();
  if (!lane) problems.push("lane is required.");
  else if (lane.length > 64) problems.push("lane is too long (max 64 characters).");
  else if (hasControlChars(lane)) problems.push("lane must not contain control characters.");
  if (!isValidRepoName(form.baseRepo.trim())) problems.push("baseRepo must be owner/repo.");
  if (!isValidRepoName(form.workRepo.trim())) problems.push("workRepo must be owner/repo.");
  const baseRef = form.baseRef.trim();
  if (!baseRef) problems.push("baseRef is required.");
  else if (baseRef.length > 256) problems.push("baseRef is too long (max 256 characters).");
  else if (hasControlChars(baseRef)) problems.push("baseRef must not contain control characters.");
  if (!form.goal.trim()) problems.push("goal is required.");
  else if (form.goal.length > 10_000) problems.push("goal is too long (max 10000 characters).");
  const upstream = form.upstreamIssue.trim();
  if (upstream.length > 512) problems.push("upstreamIssue is too long (max 512 characters).");
  else if (hasControlChars(upstream))
    problems.push("upstreamIssue must not contain control characters.");
  return problems;
}

interface FormState {
  namespace: string;
  lane: string;
  baseRepo: string;
  baseRef: string;
  workRepo: string;
  goal: string;
  upstreamIssue: string;
}

function emptyForm(namespace: string): FormState {
  return {
    namespace,
    lane: "contribution",
    baseRepo: "",
    baseRef: "main",
    workRepo: "",
    goal: "",
    upstreamIssue: "",
  };
}

function ConfigPanel({ config }: { config: CourierSurfaceView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Courier surface</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          What is configured, without exposing any credential. Values here are
          read server-side; the tokens themselves never reach the browser.
        </p>
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Admission endpoint</dt>
            <dd className="min-w-0 break-all font-medium">
              {config.endpoint ?? <span className="text-muted-foreground">not configured</span>}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Admission credential</dt>
            <dd className="font-medium">{config.admissionTokenConfigured ? "configured" : "not configured"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Approved namespaces</dt>
            <dd className="font-medium">
              {config.namespaces.length > 0 ? config.namespaces.join(", ") : "none (submission disabled)"}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Read-only tracking credential</dt>
            <dd className="font-medium">{config.readTokenConfigured ? "configured" : "not configured"}</dd>
          </div>
        </dl>
        {config.admissionReason ? <p className={noticeClass("warning")}>{config.admissionReason}</p> : null}
        {config.trackingReason ? <p className={noticeClass("info")}>{config.trackingReason}</p> : null}
      </CardContent>
    </Card>
  );
}

function DetailBlock({ row }: { row: ContributionRow }) {
  const t = row.tracking;
  return (
    <div className="space-y-4 text-sm">
      <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
        <p><span className="text-muted-foreground">Request id:</span> <span className="font-mono text-xs">{row.id}</span></p>
        <p><span className="text-muted-foreground">Idempotency key:</span> <span className="font-mono text-xs">{row.idempotencyKey}</span></p>
        <p><span className="text-muted-foreground">Courier run:</span> {row.run ?? <span className="text-muted-foreground">none yet — identity exists only after admission</span>}</p>
        <p><span className="text-muted-foreground">Courier namespace:</span> {row.namespace}</p>
        <p><span className="text-muted-foreground">Work item id:</span> {row.workItemId ?? "unknown"}</p>
        <p><span className="text-muted-foreground">Resumed by Courier:</span> {row.resumed === null ? "unknown" : row.resumed ? "yes" : "no"}</p>
        <p><span className="text-muted-foreground">Admission attempts:</span> {row.attempts} of 5</p>
        <p><span className="text-muted-foreground">Created:</span> {formatTimestamp(row.createdAt)}</p>
        <p><span className="text-muted-foreground">Base:</span> {row.baseRepo}@{row.baseRef}</p>
        <p><span className="text-muted-foreground">Work repo:</span> {row.workRepo}</p>
      </div>
      {row.goal ? (
        <div>
          <p className="font-medium">Goal</p>
          <p className="whitespace-pre-wrap text-muted-foreground">{row.goal}</p>
        </div>
      ) : null}
      {row.upstreamIssue ? (
        <p>
          <span className="text-muted-foreground">Upstream issue:</span>{" "}
          {/^https?:\/\//.test(row.upstreamIssue) ? (
            <a href={row.upstreamIssue} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {row.upstreamIssue}
            </a>
          ) : (
            <span>{row.upstreamIssue}</span>
          )}
        </p>
      ) : null}
      {row.lastError ? (
        <p className={noticeClass("warning")}>Last delivery diagnostic: {row.lastError}</p>
      ) : null}
      <div>
        <p className="mb-1 font-medium">Lifecycle evidence (last trustworthy observation)</p>
        {!t.state ? (
          <p className="text-muted-foreground">
            No lifecycle observation yet. Admission proves nothing about
            execution or publication — refresh to ask Courier.
          </p>
        ) : (
          <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
            <p><span className="text-muted-foreground">State:</span> <TrackingBadge state={t.state} stale={t.stale} /></p>
            <p><span className="text-muted-foreground">Courier phase (verbatim):</span> {t.phase ?? "unknown"}</p>
            <p><span className="text-muted-foreground">CI parked:</span> {t.ciParked === null ? "unknown" : t.ciParked ? "yes" : "no"}</p>
            <p>
              <span className="text-muted-foreground">Cause:</span>{" "}
              {t.cause ? `${t.cause.category ?? "?"} / ${t.cause.outcome ?? "?"}` : "none recorded"}
            </p>
            <p><span className="text-muted-foreground">Observed at:</span> {formatTimestamp(t.observedAt)}</p>
            <p><span className="text-muted-foreground">Phase entered:</span> {formatTimestamp(t.phaseEnteredAt)}</p>
            <p><span className="text-muted-foreground">Finished:</span> {formatTimestamp(t.finishedAt)}</p>
            <p><span className="text-muted-foreground">Last checked:</span> {formatTimestamp(t.checkedAt)}</p>
          </dl>
        )}
        {/* Publication renders only when Courier's own projection recorded a
            PR — an absent PR is never shown as a broken link. */}
        {t.publication?.pr ? <div className="mt-2"><PrLink url={t.publication.pr} /></div> : null}
        {t.publication ? (
          <p className="mt-1 text-xs text-muted-foreground">
            branch {t.publication.branch ?? "unknown"} · head repo {t.publication.headRepo ?? "unknown"} · sha{" "}
            {t.publication.headSha ? <span className="font-mono">{t.publication.headSha}</span> : "unknown"}
          </p>
        ) : null}
        {t.lastError ? <p className={noticeClass("warning")}>Tracking diagnostic: {t.lastError}</p> : null}
      </div>
    </div>
  );
}

export function ContributionsClient({ config }: { config: CourierSurfaceView }) {
  const [requests, setRequests] = useState<ContributionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ status: "loading" | "ready" | "error"; row?: ContributionRow; error?: string } | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<Notice | null>(null);

  const [form, setForm] = useState<FormState>(() => emptyForm(config.namespaces[0] ?? ""));
  const [idempotencyKey, setIdempotencyKey] = useState<string>(newClientKey);
  const [problems, setProblems] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitNotice, setSubmitNotice] = useState<Notice | null>(null);

  const submissionEnabled = config.admissionReason === null && config.namespaces.length > 0;

  const upsertRow = useCallback((row: ContributionRow) => {
    setRequests((prev) => {
      const index = prev.findIndex((r) => r.id === row.id);
      if (index === -1) return [row, ...prev];
      const next = [...prev];
      next[index] = row;
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch("/api/external-contributions");
      if (!res.ok) throw new Error(`contribution listing failed: HTTP ${res.status}`);
      const body = (await res.json()) as { requests?: ContributionRow[] };
      setRequests(body.requests ?? []);
      setListError("");
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load contribution requests");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = useCallback(
    async (id: string) => {
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
        return;
      }
      setExpandedId(id);
      setDetail({ status: "loading" });
      setRefreshNotice(null);
      try {
        const res = await authedFetch(`/api/external-contributions/${id}`);
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || typeof (body as ContributionRow).id !== "string") {
          const msg =
            body && typeof (body as { error?: unknown }).error === "string"
              ? (body as { error: string }).error
              : `Failed to load request (HTTP ${res.status})`;
          setDetail({ status: "error", error: msg });
          return;
        }
        const row = body as ContributionRow;
        setDetail({ status: "ready", row });
        upsertRow(row);
      } catch (err) {
        setDetail({ status: "error", error: err instanceof Error ? err.message : "Failed to load request" });
      }
    },
    [expandedId, upsertRow],
  );

  const refreshTracking = useCallback(
    async (id: string) => {
      setRefreshingId(id);
      setRefreshNotice(null);
      try {
        const res = await authedFetch(`/api/external-contributions/${id}/refresh`, { method: "POST" });
        const body = (await res.json().catch(() => null)) as
          | (ContributionRow & { refreshed?: boolean; cooldownRemainingMs?: number; superseded?: boolean; error?: string })
          | null;
        if (body && typeof body.id === "string") {
          upsertRow(body);
          setDetail((prev) => (prev?.status === "ready" && prev.row?.id === id ? { status: "ready", row: body } : prev));
        }
        if (res.status === 200 && body?.refreshed) {
          setRefreshNotice({ tone: "success", text: "Lifecycle evidence refreshed from Courier." });
        } else if (res.status === 200 && body?.cooldownRemainingMs !== undefined) {
          setRefreshNotice({
            tone: "info",
            text: `Courier was asked again less than ${Math.ceil(body.cooldownRemainingMs / 1000)}s ago — showing stored evidence (a refresh is bounded and can never re-submit the contribution).`,
          });
        } else if (res.status === 200 && body?.superseded) {
          setRefreshNotice({ tone: "info", text: "A newer refresh already updated this request; its evidence is shown." });
        } else if (res.status === 409) {
          setRefreshNotice({ tone: "info", text: body?.error ?? "This request has no Courier run identity to track yet — it was never accepted." });
        } else if (!res.ok) {
          setRefreshNotice({ tone: "error", text: body?.error ?? `Refresh failed (HTTP ${res.status}). Stored evidence is unchanged.` });
        } else {
          setRefreshNotice({ tone: "info", text: "Showing stored evidence." });
        }
      } catch (err) {
        setRefreshNotice({ tone: "error", text: err instanceof Error ? err.message : "Refresh failed; stored evidence is unchanged." });
      } finally {
        setRefreshingId(null);
      }
    },
    [upsertRow],
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setSubmitNotice(null);
      const fieldProblems = validateForm(form, config.namespaces);
      setProblems(fieldProblems);
      if (fieldProblems.length > 0) return;

      setSubmitting(true);
      try {
        const res = await authedFetch("/api/external-contributions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            namespace: form.namespace.trim(),
            lane: form.lane.trim(),
            baseRepo: form.baseRepo.trim(),
            baseRef: form.baseRef.trim(),
            workRepo: form.workRepo.trim(),
            goal: form.goal.trim(),
            ...(form.upstreamIssue.trim() ? { upstreamIssue: form.upstreamIssue.trim() } : {}),
            idempotencyKey,
          }),
        });
        const body = (await res.json().catch(() => null)) as
          | (Partial<ContributionRow> & { error?: string })
          | null;
        const projected = body && typeof body.id === "string" ? (body as ContributionRow) : null;
        if (projected) upsertRow(projected);

        if (res.ok) {
          if (projected?.status === "in_flight") {
            setSubmitNotice({
              tone: "info",
              text: "A Courier delivery attempt for this request is already in flight. This form keeps its request identity; submitting again replays the same identity and never creates a second contribution.",
            });
          } else {
            setSubmitNotice({
              tone: "success",
              text: `Contribution ${projected?.resumed ? "resumed" : "submitted"}${projected?.run ? ` — courier run ${projected.run}` : ""}. Identity is admission proof only, not execution or publication.`,
            });
            setForm(emptyForm(config.namespaces[0] ?? ""));
            setIdempotencyKey(newClientKey());
          }
        } else {
          const message = body?.error ?? `Submission failed (HTTP ${res.status}).`;
          if (res.status === 502 || res.status === 504) {
            // Uncertain delivery: the identity is NOT settled. Retrying the
            // SAME key is the contract; rotating here would fork the
            // contribution into two identities.
            setSubmitNotice({
              tone: "warning",
              text: `${message} The delivery outcome is unknown — submitting this form again retries the SAME request identity. Do not open a second request for it.`,
            });
          } else {
            setSubmitNotice({ tone: "error", text: message });
            // A settled identity (Courier rejection, payload conflict,
            // exhausted budget — each answered WITH the projection) can never
            // advance again; the next edit must carry a fresh identity.
            if (projected) {
              setIdempotencyKey(newClientKey());
              setSubmitNotice({
                tone: "error",
                text: `${message} The form now carries a fresh request identity, so the next submission is a new contribution.`,
              });
            }
          }
        }
      } catch (err) {
        setSubmitNotice({
          tone: "error",
          text: err instanceof Error ? err.message : "Submission failed; the request may not have reached Dispatch.",
        });
      } finally {
        setSubmitting(false);
      }
    },
    [config.namespaces, form, idempotencyKey, upsertRow],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Contributions</h1>
          <p className="text-muted-foreground">
            Dispatch-owned external contribution requests for Courier. Courier owns fork approval, publication
            authority, and PR creation — Dispatch relays the request and records what Courier answered.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh list
        </Button>
      </div>

      <ConfigPanel config={config} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Submit a contribution request</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!submissionEnabled ? (
            <p className={noticeClass("warning")}>
              {config.admissionReason ??
                "Submission is disabled — no operator-approved namespace is configured."}
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Namespace (approved list only)</span>
                  <select
                    aria-label="Namespace"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={form.namespace}
                    onChange={(e) => setForm((f) => ({ ...f, namespace: e.target.value }))}
                  >
                    <option value="" disabled>
                      Select a namespace
                    </option>
                    {config.namespaces.map((ns) => (
                      <option key={ns} value={ns}>
                        {ns}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Lane (bounded free text, relayed verbatim)</span>
                  <Input
                    aria-label="Lane"
                    value={form.lane}
                    maxLength={64}
                    onChange={(e) => setForm((f) => ({ ...f, lane: e.target.value }))}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Base repo (owner/repo)</span>
                  <Input
                    aria-label="Base repo"
                    placeholder="acme/widgets"
                    value={form.baseRepo}
                    onChange={(e) => setForm((f) => ({ ...f, baseRepo: e.target.value }))}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Base ref</span>
                  <Input
                    aria-label="Base ref"
                    placeholder="main"
                    value={form.baseRef}
                    onChange={(e) => setForm((f) => ({ ...f, baseRef: e.target.value }))}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Work repo (owner/repo)</span>
                  <Input
                    aria-label="Work repo"
                    placeholder="acme/widgets-fork"
                    value={form.workRepo}
                    onChange={(e) => setForm((f) => ({ ...f, workRepo: e.target.value }))}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Upstream issue (optional, relayed verbatim)</span>
                  <Input
                    aria-label="Upstream issue"
                    placeholder="https://github.com/acme/widgets/issues/12"
                    value={form.upstreamIssue}
                    onChange={(e) => setForm((f) => ({ ...f, upstreamIssue: e.target.value }))}
                  />
                </label>
              </div>
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">Goal</span>
                <textarea
                  aria-label="Goal"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  rows={4}
                  placeholder="What should the contribution achieve?"
                  value={form.goal}
                  onChange={(e) => setForm((f) => ({ ...f, goal: e.target.value }))}
                />
              </label>
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Submitting…" : "Submit contribution"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  One request identity per form session: an uncertain delivery retries the SAME request; a
                  deliberate new contribution is a fresh submission after the last one settles.
                </span>
              </div>
              {problems.length > 0 ? (
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-destructive">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
              <NoticeLine notice={submitNotice} />
            </form>
          )}
        </CardContent>
      </Card>

      {listError ? <p className={noticeClass("error")}>{listError}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stored requests</CardTitle>
        </CardHeader>
        <CardContent>
          {refreshNotice ? (
            <div className="mb-3">
              <NoticeLine notice={refreshNotice} />
            </div>
          ) : null}
          {requests.length === 0 && !loading ? (
            <p className="py-6 text-center text-muted-foreground">
              No contribution requests recorded yet.
            </p>
          ) : (
            <div className="space-y-2">
              {requests.map((row) => {
                const expanded = expandedId === row.id;
                const trackable = row.status === "accepted" && row.run !== null;
                return (
                  <div key={row.id} className="rounded-md border">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                      <span className="text-muted-foreground">{formatTimestamp(row.createdAt)}</span>
                      <span className="font-medium">
                        {row.baseRepo} ← {row.workRepo}
                      </span>
                      <span className="text-muted-foreground">
                        {row.namespace} · {row.lane}
                      </span>
                      <DeliveryBadge status={row.status} />
                      <TrackingBadge state={row.tracking.state} stale={row.tracking.stale} />
                      {/* Only a PR Courier itself recorded is rendered — never
                          a placeholder for one that does not exist. */}
                      {row.tracking.publication?.pr ? <PrLink url={row.tracking.publication.pr} /> : null}
                      <span className="ml-auto flex items-center gap-2">
                        {trackable ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={refreshingId === row.id}
                            onClick={() => refreshTracking(row.id)}
                          >
                            <RefreshCw className={`mr-1 h-3 w-3 ${refreshingId === row.id ? "animate-spin" : ""}`} />
                            Refresh tracking
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={expanded}
                          onClick={() => openDetail(row.id)}
                        >
                          {expanded ? "Hide details" : "Details"}
                        </Button>
                      </span>
                    </div>
                    {expanded ? (
                      <div className="border-t px-3 py-3">
                        {detail?.status === "loading" ? (
                          <p className="text-sm text-muted-foreground">Loading…</p>
                        ) : detail?.status === "error" ? (
                          <p className="text-sm text-destructive">{detail.error}</p>
                        ) : detail?.status === "ready" && detail.row?.id === row.id ? (
                          <DetailBlock row={detail.row} />
                        ) : (
                          <DetailBlock row={row} />
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
