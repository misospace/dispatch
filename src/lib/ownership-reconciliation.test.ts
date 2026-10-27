import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github", () => ({
  removeIssueLabel: (...args: unknown[]) => forgeShared.removeIssueLabel(...(args as [string, number, string])),
  addIssueLabel: (...args: unknown[]) => forgeShared.addIssueLabel(...(args as [string, number, string])),
}));
vi.mock("@/lib/claim-gate", () => ({
  getLiveIssueLabels: (...args: unknown[]) =>
    forgeShared.getLiveIssueLabels(...(args as [string, number])),
}));
vi.mock("@/lib/github-prs", () => ({
  fetchPullRequestState: vi.fn(async () => ({ state: null })),
}));
// The engine always receives its fakes through `deps`; the real client is
// never touched, but the module import must resolve.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

// ─── Forge fake (shared with the @/lib/github mock) ─────────────────────────

const forgeShared = {
  labels: new Map<string, string[]>(), // `${repo}#${number}` → labels
  removeCalls: [] as Array<{ repo: string; number: number; label: string }>,
  liveReads: 0,
  failRemove: null as ((call: { repo: string; number: number; label: string }) => never) | null,
  onLiveRead: null as (() => void) | null,
  reset() {
    this.labels.clear();
    this.removeCalls = [];
    this.liveReads = 0;
    this.failRemove = null;
    this.onLiveRead = null;
  },
  setLabels(repo: string, number: number, labels: string[]) {
    this.labels.set(`${repo}#${number}`, labels);
  },
  async getLiveIssueLabels(repo: string, number: number): Promise<string[]> {
    this.liveReads++;
    this.onLiveRead?.();
    const labels = this.labels.get(`${repo}#${number}`);
    if (!labels) throw new Error(`Could not read labels for ${repo}#${number}`);
    return [...labels];
  },
  async removeIssueLabel(repo: string, number: number, label: string): Promise<void> {
    const call = { repo, number, label };
    this.removeCalls.push(call);
    if (this.failRemove) return this.failRemove(call);
    // Mirrors the real forge adapter, which swallows 404s: a missing label or
    // issue is an idempotent no-op, never an error.
    const labels = this.labels.get(`${repo}#${number}`);
    if (labels) {
      const next = labels.filter((l) => l !== label);
      this.labels.set(`${repo}#${number}`, next);
    }
  },
  async addIssueLabel(repo: string, number: number, label: string): Promise<void> {
    const key = `${repo}#${number}`;
    const labels = this.labels.get(key);
    if (!labels) throw new Error(`404 Not Found: ${key}`);
    if (!labels.includes(label)) labels.push(label);
  },
};

// ─── In-memory Prisma fake with snapshot-swap transactions ───────────────────

type Row = Record<string, any>;
const CLONE = (value: unknown) =>
  value === undefined ? undefined : (structuredClone(value) as any);

function matchesScalar(value: any, cond: any): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
    // Operator object (Prisma filter). Date operands compare by epoch.
    for (const [op, operand] of Object.entries(cond) as Array<[string, any]>) {
      const t = value instanceof Date ? value.getTime() : value;
      const o = operand instanceof Date ? operand.getTime() : operand;
      switch (op) {
        case "in": if (!(operand as any[]).some((x) => scalarEq(value, x))) return false; break;
        case "not": if (!matchesScalar(value, operand)) return false; break;
        case "lte": if (!(t <= o)) return false; break;
        case "gte": if (!(t >= o)) return false; break;
        case "lt": if (!(t < o)) return false; break;
        case "gt": if (!(t > o)) return false; break;
        case "ne": if (scalarEq(value, operand)) return false; break;
        default: throw new Error(`fake does not implement operator "${op}"`);
      }
    }
    return true;
  }
  return scalarEq(value, cond);
}

function scalarEq(a: any, b: any): boolean {
  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date) || !(b instanceof Date)) return false;
    return a.getTime() === b.getTime();
  }
  return a === b;
}

function matchesWhere(row: Row, where: any): boolean {
  if (where == null) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as any[]).some((sub) => matchesWhere(row, sub))) return false;
    } else if (key === "AND") {
      if (!(cond as any[]).every((sub) => matchesWhere(row, sub))) return false;
    } else if (key === "NOT") {
      if (matchesWhere(row, cond)) return false;
    } else if (key.includes("_")) {
      // Compound unique selector, e.g. agentName_issueId: { agentName, issueId }
      const [field] = key.split("_");
      if (!matchesWhere(row, { [field]: cond })) return false;
    } else if (!(key in row)) {
      // A field absent from a fake-created row reads as SQL NULL.
      if (cond === null) continue;
      throw new Error(`fake row lacks field "${key}" — clause not understood`);
    } else if (!matchesScalar(row[key], cond)) {
      return false;
    }
  }
  return true;
}

function applyData(row: Row, data: any): Row {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      if ("increment" in value) { row[key] = (row[key] ?? 0) + value.increment; continue; }
      if ("set" in value) { row[key] = value.set; continue; }
      throw new Error(`fake does not implement data operator: ${JSON.stringify(value)}`);
    }
    row[key] = value;
  }
  return row;
}

/**
 * Honors `select` like the real client: a row projection only carries the
 * selected fields, so code that reads a field its select dropped fails loudly
 * here instead of silently passing against real Prisma rows (#1254 review:
 * the reclaimCount bug was invisible because the fake ignored `select`).
 */
function projectRow(row: Row, select: any): Row {
  if (!select) return row;
  const out: Row = {};
  for (const [key, keep] of Object.entries(select)) if (keep) out[key] = row[key];
  return out;
}

function orderRows(rows: Row[], orderBy: any): Row[] {
  const list = [...rows];
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, string>>;
  list.sort((a, b) => {
    for (const entry of keys) {
      const [field, dir] = Object.entries(entry)[0];
      const av = a[field], bv = b[field];
      const an = av === null || av === undefined, bn = bv === null || bv === undefined;
      let cmp = 0;
      if (an && bn) cmp = 0;
      else if (an) cmp = dir === "desc" ? -1 : 1; // nulls last on desc, first on asc (unused here)
      else if (bn) cmp = dir === "desc" ? 1 : -1;
      else if (av instanceof Date || bv instanceof Date) cmp = (av as Date).getTime() - (bv as Date).getTime();
      else if (typeof av === "string" || typeof bv === "string") cmp = String(av).localeCompare(String(bv));
      else cmp = av - bv;
      if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return list;
}

function makeFakePrisma() {
  let seq = 0;
  const nextId = () => `row-${++seq}`;
  // Prisma's @default(now()) on createdAt, on a controllable clock so tests
  // can age rows deterministically against a synthetic pass clock (#1363).
  const clock = { now: new Date() };
  const tables: Record<string, Row[]> = {
    issue: [],
    lease: [],
    agentWork: [],
    agentWorkHistory: [],
    ownershipReleaseIntent: [],
    ownershipReconcileCandidate: [],
    auditLog: [],
    issueLifecycleEvent: [],
    prFixQueueItem: [],
  };
  const faults = { failIntentDelete: false };

  /**
   * Model methods parameterized over a row source, so the transaction client
   * (operating on a snapshot copy) and the top-level client share ONE
   * implementation — the fake cannot diverge between the two views.
   */
  function makeModel(name: string, source: () => Row[]) {
    const rows = source;
    const findUniqueRow = (args: any): Row | undefined => {
      const where = args?.where ?? {};
      if (where.id !== undefined) return rows().find((r) => r.id === where.id);
      const key = Object.keys(where)[0];
      if (!key) throw new Error(`fake ${name}.findUnique: unsupported selector`);
      const cond = where[key];
      if (cond !== null && typeof cond === "object") {
        // Compound unique selector, e.g. agentName_issueId: { agentName, issueId }
        return rows().find((r) => matchesWhere(r, cond));
      }
      // Scalar unique field, e.g. { issueId } on ownershipReconcileCandidate.
      return rows().find((r) => matchesScalar(r[key], cond));
    };
    return {
      findMany: async (args: any = {}) => {
        let found = rows().filter((r) => matchesWhere(r, args.where ?? {}));
        if (args.orderBy) found = orderRows(found, args.orderBy);
        // Cursor-free paging needs a stable order; orderRows tiebreaks by id,
        // mirroring the production scan's explicit `id` tiebreak (#1417).
        if (args.skip) found = found.slice(args.skip);
        if (args.take !== undefined) found = found.slice(0, args.take);
        return CLONE(found.map((r) => projectRow(r, args.select)));
      },
      findFirst: async (args: any = {}) => {
        let found = rows().filter((r) => matchesWhere(r, args.where ?? {}));
        if (args.orderBy) found = orderRows(found, args.orderBy);
        return found.length ? CLONE(projectRow(found[0], args.select)) : null;
      },
      findUnique: async (args: any = {}) => {
        const row = findUniqueRow(args);
        return row ? CLONE(projectRow(row, args.select)) : null;
      },
      create: async (args: any) => {
        const row = { id: nextId(), ...CLONE(args.data) };
        if (row.createdAt === undefined) row.createdAt = new Date(clock.now);
        rows().push(row);
        return CLONE(row);
      },
      update: async (args: any) => {
        const row = rows().find((r) => matchesWhere(r, args.where ?? {}));
        if (!row) throw new Error(`${name}.update: no row matches ${JSON.stringify(args.where)}`);
        applyData(row, CLONE(args.data));
        return CLONE(row);
      },
      updateMany: async (args: any) => {
        const matched = rows().filter((r) => matchesWhere(r, args.where ?? {}));
        for (const row of matched) applyData(row, CLONE(args.data));
        return { count: matched.length };
      },
      deleteMany: async (args: any = {}) => {
        if (faults.failIntentDelete && name === "ownershipReleaseIntent") {
          faults.failIntentDelete = false;
          throw new Error("simulated settlement failure");
        }
        const kept = rows().filter((r) => !matchesWhere(r, args.where ?? {}));
        const removed = rows().length - kept.length;
        const target = rows();
        target.length = 0;
        target.push(...kept);
        return { count: removed };
      },
      delete: async (args: any) => {
        const idx = rows().findIndex((r) => matchesWhere(r, args.where ?? {}));
        if (idx < 0) throw new Error(`${name}.delete: no row matches`);
        const [row] = rows().splice(idx, 1);
        return CLONE(row);
      },
      upsert: async (args: any) => {
        const where = args.where ?? {};
        const existing = rows().find((r) => matchesWhere(r, where));
        if (existing) {
          applyData(existing, CLONE(args.update ?? {}));
          return CLONE(existing);
        }
        const row = { id: nextId(), ...CLONE(args.create) };
        if (row.createdAt === undefined) row.createdAt = new Date(clock.now);
        rows().push(row);
        return CLONE(row);
      },
    };
  }

  const models = Object.fromEntries(
    Object.keys(tables).map((name) => [name, makeModel(name, () => tables[name])]),
  );

  const client: any = {
    ...models,
    $transaction: async (fn: any) => {
      // Snapshot-swap: mutations inside the callback apply to a deep copy of
      // every table and are only swapped in when the callback resolves, so a
      // throw inside a transaction leaves the store untouched — the atomicity
      // the engine Phase C settle relies on.
      const txTables: Record<string, Row[]> = Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [name, CLONE(rows)]),
      );
      const tx: any = Object.fromEntries(
        Object.keys(txTables).map((name) => [name, makeModel(name, () => txTables[name])]),
      );
      const result = await fn(tx);
      for (const name of Object.keys(txTables)) tables[name] = txTables[name];
      return result;
    },
  };
  return { client, tables, faults, clock };
}

// ─── Mutual-exclusion guard fake (stale-work.test.ts pattern) ────────────────

function makeFakeGuard() {
  const held = new Map<string, { operation: string; agentName?: string }>();
  const attempts: Array<{ issueId: string; operation: string; agentName?: string; status: string }> = [];
  const fake: any = async (request: any, callback: any) => {
    const current = held.get(request.issueId);
    if (current) {
      attempts.push({ ...request, status: "busy" });
      return { status: "busy", ownerToken: "other", operation: current.operation };
    }
    held.set(request.issueId, { operation: request.operation, agentName: request.agentName });
    attempts.push({ ...request, status: "acquired" });
    try {
      const result = await callback(undefined, {
        resuming: false,
        stillHoldsGuard: async () => true,
        // #1254: the fenced remote write is ATOMIC with the guard check — the
        // guard is held here, so the forge write runs.
        runFencedRemoteWrite: async (fn: any) => ({ status: "written", value: await fn(undefined) }),
      });
      return result;
    } finally {
      held.delete(request.issueId);
    }
  };
  return { fake, held, attempts, reset: () => { held.clear(); attempts.length = 0; } };
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const REPO = "octocat/hello-world";
const ISSUE_ID = "issue-1";
const MIN = 60_000;

function minutesAgo(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * MIN);
}

function buildFixture(now: Date) {
  const { client, tables, faults, clock } = makeFakePrisma();
  const guard = makeFakeGuard();

  tables.issue.push({
    id: ISSUE_ID,
    number: 42,
    state: "open",
    labels: ["status/in-progress", "agent/alpha"],
    blockedReason: null,
    linkedPrNumber: null,
    linkedPrMergeState: null,
    repository: { fullName: REPO },
  });
  tables.lease.push({
    id: "lease-1",
    agentName: "alpha",
    issueId: ISSUE_ID,
    claimToken: "tok-g",
    expiredAt: minutesAgo(now, 20),
    renewedAt: minutesAgo(now, 60),
    registeredAt: minutesAgo(now, 60),
    registrationOccurredAt: minutesAgo(now, 60),
    renewCount: 1,
    lastRenewalObservedAt: minutesAgo(now, 60),
    lastRenewalOccurredAt: minutesAgo(now, 60),
    retryAfter: null,
    waitReason: null,
    disposition: null,
  });
  tables.agentWork.push({
    id: "work-1",
    agentName: "alpha",
    issueId: ISSUE_ID,
    state: "IN_PROGRESS",
    lastHeartbeatAt: minutesAgo(now, 60),
  });

  forgeShared.setLabels(REPO, 42, ["status/in-progress", "agent/alpha"]);
  return { client, tables, faults, clock, guard };
}

async function runReconcile(fixture: ReturnType<typeof buildFixture>, now: Date, mode = "enforce") {
  vi.stubEnv("DISPATCH_OWNERSHIP_RECONCILE_MODE", mode);
  const { reconcileOwnership } = await import("@/lib/ownership-reconciliation");
  return reconcileOwnership(
    { prisma: fixture.client, forge: forgeShared, guard: fixture.guard.fake },
    now,
  );
}

function stubDefaults() {
  vi.stubEnv("DISPATCH_OWNERSHIP_ACTIVE_WINDOW_MS", String(15 * MIN));
  vi.stubEnv("DISPATCH_OWNERSHIP_LONG_RUN_GRACE_MS", String(45 * MIN));
  vi.stubEnv("DISPATCH_RECONCILE_RECHECK_INTERVAL_MS", String(5 * MIN));
  vi.stubEnv("DISPATCH_RECONCILE_RECLAIM_COOLDOWN_MS", "");
  vi.stubEnv("DISPATCH_RECONCILE_MAX_RECLAIMS", "");
  vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "");
  vi.stubEnv("DISPATCH_RECONCILE_MAX_FORGE_RETRIES", "");
  vi.stubEnv("DISPATCH_RECONCILE_ANNOTATION_REEMIT_MS", "");
}

beforeEach(() => {
  forgeShared.reset();
  stubDefaults();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function agentRemoveCalls(): string[] {
  return forgeShared.removeCalls.filter((c) => c.repo === REPO && c.number === 42 && c.label.startsWith("agent/")).map((c) => c.label);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ownership reconciliation (#1254)", () => {
  describe("mode gating", () => {
    it("mode=off returns a zero report with no DB or forge activity", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      const report = await runReconcile(fixture, now, "off");
      expect(report).toMatchObject({ mode: "off", examined: 0, released: 0 });
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(forgeShared.liveReads).toBe(0);
      expect(fixture.tables.auditLog).toHaveLength(0);
    });

    it("mode=audit never releases: no forge write, no intent, no lease delete", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      // Pre-seed a mature observation so the ladder would release in enforce.
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      const report = await runReconcile(fixture, now, "audit");
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      expect(fixture.tables.lease).toHaveLength(1);
      expect(fixture.tables.lease[0].claimToken).toBe("tok-g");
      expect(fixture.tables.issue[0].labels).toContain("agent/alpha");
      expect(report.retained).toBeGreaterThanOrEqual(1);
      const actions = fixture.tables.auditLog.map((r) => r.action);
      expect(actions).toContain("ownership_reconcile_release_withheld");
    });
  });

  describe("audit mode is read-only for candidate state", () => {
    // The fake is table-based; "not called" is asserted through call-counting
    // wrappers around the candidate model's write methods.
    function spyCandidateWrites(client: any) {
      const model = client.ownershipReconcileCandidate;
      const writes = {
        deleteMany: vi.fn((args: any) => model.deleteMany(args)),
        update: vi.fn((args: any) => model.update(args)),
        upsert: vi.fn((args: any) => model.upsert(args)),
      };
      model.deleteMany = writes.deleteMany;
      model.update = writes.update;
      model.upsert = writes.upsert;
      return writes;
    }

    function preseededMatureCandidate(now: Date) {
      return {
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      };
    }

    it("a renewal mid-ladder: no candidate deleteMany/update/upsert, annotation still emitted", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      const writes = spyCandidateWrites(fixture.client);
      const preseeded = preseededMatureCandidate(now);
      fixture.tables.ownershipReconcileCandidate.push(preseeded);
      // The worker renews between observations: fresh evidence → non-abandoned state.
      fixture.tables.lease[0].renewedAt = now;
      fixture.tables.lease[0].lastRenewalObservedAt = now;
      fixture.tables.lease[0].expiredAt = new Date(now.getTime() + 40 * MIN);
      fixture.tables.agentWork[0].lastHeartbeatAt = now;

      const report = await runReconcile(fixture, now, "audit");
      expect(report.examined).toBe(1);
      expect(report.retained).toBe(1);
      expect(report.released).toBe(0);
      expect(writes.deleteMany).not.toHaveBeenCalled();
      expect(writes.update).not.toHaveBeenCalled();
      expect(writes.upsert).not.toHaveBeenCalled();
      // The stored row survives untouched.
      expect(fixture.tables.ownershipReconcileCandidate).toHaveLength(1);
      expect(fixture.tables.ownershipReconcileCandidate[0]).toBe(preseeded);
      const actions = fixture.tables.auditLog.map((r) => r.action);
      expect(actions).toContain("ownership_reconcile_candidate");
    });

    it("the selection scan's dead-ladder cleanup does not delete in audit mode", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      const writes = spyCandidateWrites(fixture.client);
      // A candidate row for an issue Dispatch no longer sees as claimed (the
      // issue row is gone from the fixture's open-issue scan): enforce would
      // housekeeping-delete it, audit must leave it untouched.
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-dead",
        issueId: "issue-gone",
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });

      const report = await runReconcile(fixture, now, "audit");

      expect(report.released).toBe(0);
      expect(writes.deleteMany).not.toHaveBeenCalled();
      expect(fixture.tables.ownershipReconcileCandidate.some((r: any) => r.id === "cand-dead")).toBe(true);
    });

    it("no stored row: the ladder is simulated in memory only (first observation)", async () => {

      const now = new Date();
      const fixture = buildFixture(now);
      const writes = spyCandidateWrites(fixture.client);
      const report = await runReconcile(fixture, now, "audit");
      expect(report.examined).toBe(1);
      expect(report.retained).toBe(1);
      expect(report.released).toBe(0);
      expect(writes.deleteMany).not.toHaveBeenCalled();
      expect(writes.update).not.toHaveBeenCalled();
      expect(writes.upsert).not.toHaveBeenCalled();
      expect(fixture.tables.ownershipReconcileCandidate).toHaveLength(0);
      // First (simulated) observation only: no "would release" annotation.
      const actions = fixture.tables.auditLog.map((r) => r.action);
      expect(actions).not.toContain("ownership_reconcile_release_withheld");
      // The abandoned candidate is still surfaced: audit mode annotates every
      // abandoned candidate once per pass, ladder state or not.
      const annotations = fixture.tables.auditLog.filter((r: any) => r.action === "ownership_reconcile_candidate");
      expect(annotations).toHaveLength(1);
      expect(annotations[0].notes).toContain("state=ABANDONED_CANDIDATE");
      expect(annotations[0].notes).toContain("wouldRelease=no (confirmation pending)");
      expect(forgeShared.removeCalls).toHaveLength(0);
    });

    it("an abandoned candidate with no stored row: one annotation, zero writes anywhere else", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      const writes = spyCandidateWrites(fixture.client);
      const leaseBefore = { ...fixture.tables.lease[0] };
      const workBefore = { ...fixture.tables.agentWork[0] };

      const report = await runReconcile(fixture, now, "audit");

      // No candidate writes at all.
      expect(writes.deleteMany).not.toHaveBeenCalled();
      expect(writes.update).not.toHaveBeenCalled();
      expect(writes.upsert).not.toHaveBeenCalled();
      expect(fixture.tables.ownershipReconcileCandidate).toHaveLength(0);
      // No forge write, no lease/agentWork mutation.
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.lease[0]).toEqual(leaseBefore);
      expect(fixture.tables.agentWork[0]).toEqual(workBefore);
      // Exactly one candidate annotation for the abandoned candidate.
      const annotations = fixture.tables.auditLog.filter((r: any) => r.action === "ownership_reconcile_candidate");
      expect(annotations).toHaveLength(1);
      expect(annotations[0].notes).toContain("state=ABANDONED_CANDIDATE");
      expect(annotations[0].notes).toContain("ladder=1/2");
      expect(annotations[0].notes).toContain("wouldRelease=no (confirmation pending)");
      expect(report.retained).toBe(1);
      expect(report.released).toBe(0);
    });

    it("a candidate inside the reclaim cooldown is still annotated (never silently dropped)", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      const writes = spyCandidateWrites(fixture.client);
      // Reclaimed recently: the cooldown holds the candidate back before the
      // ladder runs. In audit mode the candidate must still be surfaced.
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 1,
        lastReclaimAt: minutesAgo(now, 1),
      });

      const report = await runReconcile(fixture, now, "audit");

      expect(report.retained).toBe(1);
      expect(report.released).toBe(0);
      expect(writes.deleteMany).not.toHaveBeenCalled();
      expect(writes.update).not.toHaveBeenCalled();
      expect(writes.upsert).not.toHaveBeenCalled();
      const annotations = fixture.tables.auditLog.filter((r: any) => r.action === "ownership_reconcile_candidate");
      expect(annotations).toHaveLength(1);
      expect(annotations[0].notes).toContain("wouldRelease=no (reclaim cooldown)");
      expect(forgeShared.removeCalls).toHaveLength(0);
    });

    it("a mature stored row past the re-check interval: 'would release' annotation, zero candidate writes", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      const writes = spyCandidateWrites(fixture.client);
      const preseeded = preseededMatureCandidate(now);
      fixture.tables.ownershipReconcileCandidate.push(preseeded);

      const report = await runReconcile(fixture, now, "audit");
      expect(report.examined).toBe(1);
      expect(report.retained).toBe(1);
      expect(report.released).toBe(0);
      expect(writes.deleteMany).not.toHaveBeenCalled();
      expect(writes.update).not.toHaveBeenCalled();
      expect(writes.upsert).not.toHaveBeenCalled();
      // The stored row never advances: each audit pass re-derives from it.
      expect(fixture.tables.ownershipReconcileCandidate[0]).toBe(preseeded);
      expect(fixture.tables.ownershipReconcileCandidate[0].staleCount).toBe(1);
      expect(fixture.tables.ownershipReconcileCandidate[0].lastObservedAt.getTime()).toBe(minutesAgo(now, 10).getTime());
      const actions = fixture.tables.auditLog.map((r) => r.action);
      expect(actions).toContain("ownership_reconcile_release_withheld");
      // The abandoned candidate is annotated too, and the ladder HAS matured.
      const annotations = fixture.tables.auditLog.filter((r: any) => r.action === "ownership_reconcile_candidate");
      expect(annotations).toHaveLength(1);
      expect(annotations[0].notes).toContain("state=ABANDONED_CANDIDATE");
      expect(annotations[0].notes).toContain("ladder=2/2");
      expect(annotations[0].notes).toContain("wouldRelease=yes");
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
    });
  });

  // ─── #1363: per-pass annotation growth is bounded ──────────────────────────

  describe("per-pass annotation dedupe (#1363)", () => {
    function candidateAnnotations(fixture: ReturnType<typeof buildFixture>) {
      return fixture.tables.auditLog.filter((r: any) => r.action === "ownership_reconcile_candidate");
    }
    function parkedAnnotations(fixture: ReturnType<typeof buildFixture>) {
      return fixture.tables.auditLog.filter((r: any) => r.action === "ownership_reconcile_parked");
    }

    it("an unchanged abandoned candidate annotates once, not once per pass", async () => {
      const now = new Date();
      const fixture = buildFixture(now);

      await runReconcile(fixture, now, "audit");
      // Past the re-check interval, so the pass re-derives the identical
      // simulated ladder state — the exact shape that used to write one
      // identical row per pass (hundreds per candidate per day).
      const second = await runReconcile(fixture, new Date(now.getTime() + 6 * MIN), "audit");

      expect(second.examined).toBe(1);
      expect(second.retained).toBe(1);
      expect(candidateAnnotations(fixture)).toHaveLength(1);
      expect(candidateAnnotations(fixture)[0].notes).toContain("ladder=1/2");
      expect(candidateAnnotations(fixture)[0].notes).toContain("wouldRelease=no (confirmation pending)");
    });

    it("after the re-emit window the unchanged candidate is re-annotated once", async () => {
      vi.stubEnv("DISPATCH_RECONCILE_ANNOTATION_REEMIT_MS", String(10 * MIN));
      const now = new Date();
      const fixture = buildFixture(now);

      await runReconcile(fixture, now, "audit");
      await runReconcile(fixture, new Date(now.getTime() + 6 * MIN), "audit"); // identical → suppressed
      await runReconcile(fixture, new Date(now.getTime() + 11 * MIN), "audit"); // window elapsed → fresh confirmation

      // Bounded: one row per state change plus one per re-emit window,
      // never one per pass.
      expect(candidateAnnotations(fixture)).toHaveLength(2);
    });

    it("a state change re-annotates immediately (renewal observed)", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      // A stored ladder row keeps the issue in the candidate scan even after
      // the renewal makes the heartbeat fresh again.
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 0,
        firstStaleAt: null,
        lastObservedAt: null,
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      await runReconcile(fixture, now, "audit");

      // The worker renews between passes: fresh evidence → non-abandoned,
      // a different annotation content that must NOT be suppressed.
      const second = new Date(now.getTime() + 6 * MIN);
      fixture.tables.lease[0].renewedAt = second;
      fixture.tables.lease[0].lastRenewalObservedAt = second;
      fixture.tables.lease[0].expiredAt = new Date(second.getTime() + 40 * MIN);
      fixture.tables.agentWork[0].lastHeartbeatAt = second;
      await runReconcile(fixture, second, "audit");

      const annotations = candidateAnnotations(fixture);
      expect(annotations).toHaveLength(2);
      expect(annotations[0].notes).toContain("state=ABANDONED_CANDIDATE");
      expect(annotations[1].notes).toContain("state=CLAIMED_ACTIVE");
    });

    it("a parked claim's needs-human annotation is written once, not once per pass (enforce)", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 0,
        firstStaleAt: null,
        lastObservedAt: null,
        reclaimCount: 3,
        lastReclaimAt: minutesAgo(now, 180),
      });

      await runReconcile(fixture, now, "enforce");
      const second = await runReconcile(fixture, new Date(now.getTime() + 6 * MIN), "enforce");

      expect(second.held).toBe(1);
      expect(second.released).toBe(0);
      expect(parkedAnnotations(fixture)).toHaveLength(1);
      expect(parkedAnnotations(fixture)[0].notes).toContain("needs-human");
    });

    it("event-shaped actions stay exempt: a second release intent for the same issue is annotated again", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      const intentAnnotations = (f: ReturnType<typeof buildFixture>) =>
        f.tables.auditLog.filter((r: any) => r.action === "ownership_release_intent");

      // Cycle 1: the ladder matures across two passes, then releases.
      await runReconcile(fixture, now, "enforce");
      await runReconcile(fixture, new Date(now.getTime() + 10 * MIN), "enforce");
      expect(intentAnnotations(fixture)).toHaveLength(1);

      // The owner re-claims under a fresh token and abandons again. The
      // second commit's annotation content is byte-identical to the first
      // (same agent, token pinned) — only the exemption lets it through.
      const reclaimAt = new Date(now.getTime() + 60 * MIN);
      fixture.tables.lease.push({
        id: "lease-2",
        agentName: "alpha",
        issueId: ISSUE_ID,
        claimToken: "tok-h",
        expiredAt: minutesAgo(reclaimAt, 20),
        renewedAt: minutesAgo(reclaimAt, 60),
        registeredAt: minutesAgo(reclaimAt, 60),
        registrationOccurredAt: minutesAgo(reclaimAt, 60),
        renewCount: 1,
        lastRenewalObservedAt: minutesAgo(reclaimAt, 60),
        lastRenewalOccurredAt: minutesAgo(reclaimAt, 60),
        retryAfter: null,
        waitReason: null,
        disposition: null,
      });
      fixture.tables.agentWork.push({
        id: "work-2",
        agentName: "alpha",
        issueId: ISSUE_ID,
        state: "IN_PROGRESS",
        lastHeartbeatAt: minutesAgo(new Date(now.getTime() + 60 * MIN), 60),
      });
      fixture.tables.issue[0].labels = ["status/ready", "agent/alpha"];
      forgeShared.setLabels(REPO, 42, ["status/ready", "agent/alpha"]);
      const cycleNow = new Date(now.getTime() + 70 * MIN);
      await runReconcile(fixture, cycleNow, "enforce");
      await runReconcile(fixture, new Date(cycleNow.getTime() + 10 * MIN), "enforce");

      const intents = intentAnnotations(fixture);
      expect(intents).toHaveLength(2);
      expect(intents[0].notes).toBe(intents[1].notes);
    });
  });

  describe("candidate selection", () => {
    it("label-only legacy claims (no Dispatch evidence) are never candidates", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.lease.length = 0;
      fixture.tables.agentWork.length = 0;
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(0);
      expect(forgeShared.liveReads).toBe(0);
    });

    it("a forge read failure fails closed: no observation, no mutation", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      forgeShared.labels.clear(); // getLiveIssueLabels now throws
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.skipped).toBeGreaterThanOrEqual(1);
      expect(fixture.tables.ownershipReconcileCandidate).toHaveLength(0);
      expect(fixture.tables.lease[0].claimToken).toBe("tok-g");
      expect(forgeShared.removeCalls).toHaveLength(0);
      const actions = fixture.tables.auditLog.map((r) => r.action);
      expect(actions).toContain("ownership_reconcile_unverifiable");
    });
  });

  describe("confirmation ladder (§8.2)", () => {
    it("first stale observation records and retains; second inside the re-check interval retains", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      const first = await runReconcile(fixture, now, "enforce");
      expect(first.retained).toBe(1);
      expect(first.retained).toBe(1);
      expect(first.released).toBe(0);
      const row = fixture.tables.ownershipReconcileCandidate[0];
      expect(row.staleCount).toBe(1);
      expect(row.lastObservedAt).not.toBeNull();

      // Second pass within the re-check interval: still retained.
      const second = await runReconcile(fixture, new Date(now.getTime() + MIN), "enforce");
      expect(second.retained).toBe(1);
      expect(fixture.tables.ownershipReconcileCandidate[0].staleCount).toBe(1);
      expect(forgeShared.removeCalls).toHaveLength(0);
    });

    it("second observation after the re-check interval releases in enforce mode", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      await runReconcile(fixture, now, "enforce");
      const later = new Date(now.getTime() + 10 * MIN);
      const report = await runReconcile(fixture, later, "enforce");
      expect(report.released).toBe(1);
      expect(agentRemoveCalls()).toEqual(["agent/alpha"]);
      expect(fixture.tables.issue[0].labels).not.toContain("agent/alpha");
      expect(fixture.tables.lease).toHaveLength(0);
      expect(fixture.tables.agentWork[0].state).toBe("RELEASED");
      // §8.5: unexplained in-progress falls back to ready.
      const statusCalls = fixture.tables.issue[0].labels;
      expect(statusCalls).toContain("status/ready");
      // One lifecycle release event, one intent row cleared.
      const releases = fixture.tables.issueLifecycleEvent.filter((e: any) => e.kind === "claim_released");
      expect(releases).toHaveLength(1);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
    });

    it("a renewal observed mid-ladder aborts candidacy and deletes the observation", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      await runReconcile(fixture, now, "enforce");
      // The worker renews between observations: fresh evidence → CLAIMED_ACTIVE.
      fixture.tables.lease[0].renewedAt = new Date(now.getTime() + 10 * MIN);
      fixture.tables.lease[0].lastRenewalObservedAt = new Date(now.getTime() + 10 * MIN);
      fixture.tables.lease[0].expiredAt = new Date(now.getTime() + 40 * MIN);
      fixture.tables.agentWork[0].lastHeartbeatAt = new Date(now.getTime() + 10 * MIN);
      const report = await runReconcile(fixture, new Date(now.getTime() + 10 * MIN), "enforce");
      expect(report.retained).toBe(1);
      expect(report.released).toBe(0);
      expect(fixture.tables.ownershipReconcileCandidate).toHaveLength(0);
      expect(fixture.tables.issue[0].labels).toContain("agent/alpha");
    });

    it("reclaim limit parks the claim as needs-human without releasing", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 2,
        firstStaleAt: minutesAgo(now, 60),
        lastObservedAt: minutesAgo(now, 30),
        reclaimCount: 3,
        lastReclaimAt: minutesAgo(now, 60),
      });
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.held).toBe(1);
      expect(report.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
      const actions = fixture.tables.auditLog.map((r) => r.action);
      expect(actions).toContain("ownership_reconcile_parked");
    });

    it("reclaim cooldown blocks an immediate second release attempt", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 2,
        firstStaleAt: minutesAgo(now, 60),
        lastObservedAt: minutesAgo(now, 30),
        reclaimCount: 1,
        lastReclaimAt: minutesAgo(now, 1),
      });
      const report = await runReconcile(fixture, now, "enforce");
      expect(report, JSON.stringify(report) + "AUDIT " + JSON.stringify(fixture.tables.auditLog.map(r=>[r.action,r.notes,r.errorMessage]))).toMatchObject({ retained: 1 });
      expect(report.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
    });
  });

  describe("expired-lease tombstone recovery (#1417)", () => {
    // The F1 evidence shape: a canonical worker claimed (lease + `agent/*`
    // label) but crashed before agent-work/start, so NO AgentWork row exists.
    // Lease cleanup tombstoned the expired lease (#1417) instead of deleting
    // it — the surviving row is the only Dispatch-side evidence, and it is
    // exactly what the candidate scan + evidence ladder consume here.
    function buildTombstoneFixture(now: Date) {
      const fixture = buildFixture(now);
      fixture.tables.agentWork.length = 0;
      Object.assign(fixture.tables.lease[0], {
        expiredAt: minutesAgo(now, 50),
        disposition: "expired",
        dispositionNote: "lease TTL elapsed with no renewal; expired claim evidence retained for ownership reconciliation (#1417)",
        dispositionObservedAt: minutesAgo(now, 50),
        renewedAt: minutesAgo(now, 75),
        registeredAt: null,
        registrationOccurredAt: null,
        renewCount: 0,
        lastRenewalObservedAt: null,
        lastRenewalOccurredAt: null,
      });
      return fixture;
    }

    it("audit mode surfaces the tombstoned claim as an ABANDONED_CANDIDATE annotation with zero mutations", async () => {
      const now = new Date();
      const fixture = buildTombstoneFixture(now);
      const report = await runReconcile(fixture, now, "audit");

      expect(report.examined).toBe(1);
      expect(report.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      // The tombstone row survives audit untouched (read-only mode).
      expect(fixture.tables.lease[0].disposition).toBe("expired");
      expect(fixture.tables.lease[0].claimToken).toBe("tok-g");
      const candidateNotes = fixture.tables.auditLog
        .filter((r) => r.action === "ownership_reconcile_candidate")
        .map((r) => r.notes);
      expect(candidateNotes.some((n: string) => n.includes("state=ABANDONED_CANDIDATE"))).toBe(true);
      expect(candidateNotes.some((n: string) => n.includes("disposition_expired"))).toBe(true);
      expect(candidateNotes.some((n: string) => n.includes("evidence_stale"))).toBe(true);
    });

    it("enforce mode ladders the tombstoned claim and releases it through the §8.7 protocol", async () => {
      const now = new Date();
      const fixture = buildTombstoneFixture(now);

      // First observation: retained, ladder at 1.
      const first = await runReconcile(fixture, now, "enforce");
      expect(first.retained).toBe(1);
      expect(first.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReconcileCandidate[0].staleCount).toBe(1);

      // Second observation after the re-check interval: the epoch CAS pins
      // the tombstone (claimToken/expiredAt/disposition all still as
      // observed), Phase B deletes exactly the claim label, Phase C settles.
      const report = await runReconcile(fixture, new Date(now.getTime() + 10 * MIN), "enforce");
      expect(report.released).toBe(1);
      expect(agentRemoveCalls()).toEqual(["agent/alpha"]);
      expect(fixture.tables.issue[0].labels).not.toContain("agent/alpha");
      // §8.5: unexplained in-progress falls back to ready.
      expect(fixture.tables.issue[0].labels).toContain("status/ready");
      // The tombstone row is consumed by the settle — the claim is gone.
      expect(fixture.tables.lease).toHaveLength(0);
      const releases = fixture.tables.issueLifecycleEvent.filter((e: any) => e.kind === "claim_released");
      expect(releases).toHaveLength(1);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      // The churn bound survives the release (§8.2 item 4).
      expect(fixture.tables.ownershipReconcileCandidate[0].reclaimCount).toBe(1);
    });

    it("a live renewal on the pair aborts candidacy — a tombstone never preempts a live owner", async () => {
      const now = new Date();
      const fixture = buildTombstoneFixture(now);
      await runReconcile(fixture, now, "enforce");
      // The same agent re-claims between observations: upsertLease's
      // disposed-row reactivation clears the tombstone, rotates the token
      // (#1256) and pushes the expiry forward — a live attempt again.
      Object.assign(fixture.tables.lease[0], {
        disposition: null,
        dispositionNote: null,
        dispositionObservedAt: null,
        claimToken: "tok-fresh",
        renewedAt: new Date(now.getTime() + 10 * MIN),
        lastRenewalObservedAt: new Date(now.getTime() + 10 * MIN),
        expiredAt: new Date(now.getTime() + 40 * MIN),
      });
      const report = await runReconcile(fixture, new Date(now.getTime() + 10 * MIN), "enforce");
      expect(report.retained).toBe(1);
      expect(report.released).toBe(0);
      expect(fixture.tables.ownershipReconcileCandidate).toHaveLength(0);
      expect(fixture.tables.issue[0].labels).toContain("agent/alpha");
    });

    it("a pre-#1256 tombstone with a NULL claimToken still settles — the pending intent must not wedge the claim barrier", async () => {
      // The blocker this pins: a legacy lease row created before claimToken
      // existed carries claimToken NULL. Tombstoned, it takes the epoch path
      // (a row exists) but the intent carries attemptToken null, so Phase C
      // hits the intent-only re-check. A surviving row there used to read as
      // "a fresh claim — never destroy" and the settle never happened: the
      // pending intent held the claim route's 409 barrier forever. A
      // tombstone is dead-claim evidence, so the settle consumes it.
      const now = new Date();
      const fixture = buildTombstoneFixture(now);
      fixture.tables.lease[0].claimToken = null;

      await runReconcile(fixture, now, "enforce");
      const report = await runReconcile(fixture, new Date(now.getTime() + 10 * MIN), "enforce");

      expect(report.released).toBe(1);
      expect(agentRemoveCalls()).toEqual(["agent/alpha"]);
      expect(fixture.tables.lease).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      const releases = fixture.tables.issueLifecycleEvent.filter((e: any) => e.kind === "claim_released");
      expect(releases).toHaveLength(1);
    });

    it("a NON-tombstoned lease behind a null-token intent still blocks the settle (fail-closed preserved)", async () => {
      // The protection the #1417 exemption must not weaken: at Phase C, a
      // lease row with any disposition other than "expired" behind a
      // null-token intent is a claim the decision never saw — the replay
      // refuses to settle and the intent stays pending (fail-closed). (The
      // reconciler itself cannot commit an intent over a running park — the
      // Phase A commit-time re-check withholds — so this shape is reached
      // only via replay of an already-pending intent, which is exactly the
      // surface this pin covers.)
      const now = new Date();
      const fixture = buildTombstoneFixture(now);
      fixture.tables.lease[0].claimToken = null;
      fixture.tables.lease[0].disposition = "blocked";
      fixture.tables.lease[0].retryAfter = new Date(now.getTime() + 60 * MIN);
      fixture.tables.ownershipReleaseIntent.push({
        id: "intent-null-token",
        issueId: ISSUE_ID,
        agentName: "alpha",
        agentLabel: "agent/alpha",
        attemptToken: null,
        phase: "pending",
        attempts: 0,
        parkedAt: null,
      });

      const { replayPendingOwnershipReleases } = await import("@/lib/ownership-reconciliation");
      const replay = await replayPendingOwnershipReleases(
        { prisma: fixture.client, forge: forgeShared, guard: fixture.guard.fake },
        now,
      );

      expect(replay.released).toBe(0);
      expect(replay.skipped).toBe(1);
      expect(fixture.tables.lease).toHaveLength(1);
      expect(fixture.tables.lease[0].disposition).toBe("blocked");
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(1);
    });
  });

  describe("commit-time re-check (#1254 acceptance)", () => {
    // The ladder decision is made on one live read; Phase A must re-derive
    // the CAS-unpinnable facts (maintainer hold, review ownership, external
    // wait) at commit time. These tests land the facts between the ladder
    // read and the Phase A transaction — instrumented on guard acquisition,
    // the same seam control 1a uses for renewals (the guard window opens
    // after the ladder read and before the transaction snapshot).
    async function runWithMutateOnAcquire(fixture: ReturnType<typeof buildFixture>, now: Date, mutate: () => void) {
      const baseGuard = fixture.guard.fake;
      const mutateOnAcquire = async (request: any, callback: any) => {
        if (request.operation === "reconcile-release") mutate();
        return baseGuard(request, callback);
      };
      vi.stubEnv("DISPATCH_OWNERSHIP_RECONCILE_MODE", "enforce");
      const { reconcileOwnership } = await import("@/lib/ownership-reconciliation");
      return reconcileOwnership(
        { prisma: fixture.client, forge: forgeShared, guard: mutateOnAcquire },
        now,
      );
    }

    function matureCandidate(now: Date) {
      return {
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      };
    }

    it("a maintainer hold that lands before Phase A withholds the release", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReconcileCandidate.push(matureCandidate(now));
      const report = await runWithMutateOnAcquire(fixture, now, () => {
        forgeShared.setLabels(REPO, 42, ["status/blocked", "agent/alpha"]);
        fixture.tables.issue[0].blockedReason = "human hold, do not touch";
      });
      expect(report.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      // Fail closed: the retired-token CAS must not have run either.
      expect(fixture.tables.lease[0].claimToken).toBe("tok-g");
      expect(report.errors.join("|")).toContain("maintainer hold");
    });

    it("review ownership (open linked PR) that lands before Phase A withholds the release", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReconcileCandidate.push(matureCandidate(now));
      const report = await runWithMutateOnAcquire(fixture, now, () => {
        forgeShared.setLabels(REPO, 42, ["status/in-review", "agent/alpha"]);
        fixture.tables.issue[0].linkedPrNumber = 77;
        fixture.tables.issue[0].linkedPrMergeState = "open";
      });
      expect(report.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      expect(report.errors.join("|")).toContain("review ownership");
    });

    it("an open PR-fix queue row that lands before Phase A withholds even under uppercase repo casing (#1370)", async () => {
      // The queue folds repo to lowercase on every write (#1145), while the
      // issue cache can carry GitHub's canonical casing ("Octocat/..."). A
      // commit-time re-check that queries with the raw casing matches no row
      // and releases a review-owned claim — the exact bug #1357 fixed in the
      // inspect read.
      const now = new Date();
      const fixture = buildFixture(now);
      const MIXED = "Octocat/Hello-World";
      fixture.tables.issue[0].repository.fullName = MIXED;
      forgeShared.labels.clear();
      forgeShared.setLabels(MIXED, 42, ["status/in-progress", "agent/alpha"]);
      fixture.tables.ownershipReconcileCandidate.push(matureCandidate(now));
      const report = await runWithMutateOnAcquire(fixture, now, () => {
        fixture.tables.prFixQueueItem.push({
          id: "qfix-1",
          repo: REPO, // canonical folded identity
          status: "QUEUED",
          issue: 42,
          pr: 77,
        });
      });
      expect(report.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      expect(report.errors.join("|")).toContain("review ownership (open PR-fix queue row)");
    });

    it("an external wait (retryAfter) committed before Phase A withholds the release", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReconcileCandidate.push(matureCandidate(now));
      // The retryAfter write lands between the ladder decision and the
      // Phase A transaction snapshot.
      const report = await runWithMutateOnAcquire(fixture, now, () => {
        fixture.tables.lease[0].retryAfter = new Date(now.getTime() + 30 * MIN);
      });
      expect(report.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      expect(fixture.tables.lease[0].claimToken).toBe("tok-g");
      expect(report.errors.join("|")).toContain("external wait");
    });

    it("a forge read failure before Phase B withholds without consuming the retry budget", async () => {
      // Withholds are not forge failures: attempts must not bump, or a long
      // outage/hold would park the pending intent and wedge the barrier.
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReleaseIntent.push({
        id: "intent-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        agentLabel: "agent/alpha",
        attemptToken: "tok-g",
        phase: "pending",
        attempts: 0,
        parkedAt: null,
      });
      forgeShared.labels.clear(); // getLiveIssueLabels now throws
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
      const intent = fixture.tables.ownershipReleaseIntent[0];
      expect(intent.phase).toBe("pending");
      expect(intent.parkedAt ?? null).toBeNull();
      expect(intent.attempts).toBe(0);
      expect(report.errors.join("|")).toContain("forge read failed before Phase B");
    });

    it("a hold landing after the intent committed withholds the replayed Phase B", async () => {
      // The pre-B re-check runs inside driveReleaseIntent, so the pending
      // intent stays pending (barrier holds, operator sees the error).
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReleaseIntent.push({
        id: "intent-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        agentLabel: "agent/alpha",
        attemptToken: "tok-g",
        phase: "pending",
        attempts: 0,
        parkedAt: null,
      });
      // Maintainer blocked the issue after Phase A committed.
      forgeShared.setLabels(REPO, 42, ["status/blocked", "agent/alpha"]);
      fixture.tables.issue[0].blockedReason = "human hold";
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(1);
      expect(report.errors.join("|")).toContain("maintainer hold");
    });

    it("dead ladder rows with reclaim history survive cleanup (loaded reclaimCount)", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      // Released issue (no agent label) whose ladder row carries churn
      // history: cleanup must KEEP it, so the churn bound survives
      // release/reclaim cycles. This requires `selectCandidates` to load
      // `reclaimCount` — the fake now honors `select` and would expose a
      // projection that drops it.
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 2,
        lastReclaimAt: minutesAgo(now, 60),
      });
      fixture.tables.issue[0].labels = ["status/ready"];
      fixture.tables.lease.length = 0;
      fixture.tables.agentWork.length = 0;
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(0);
      expect(fixture.tables.ownershipReconcileCandidate).toHaveLength(1);
    });

    it("dead ladder rows without reclaim history are cleaned up", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      fixture.tables.issue[0].labels = ["status/ready"];
      fixture.tables.lease.length = 0;
      fixture.tables.agentWork.length = 0;
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(0);
      expect(fixture.tables.ownershipReconcileCandidate).toHaveLength(0);
    });
  });

  describe("dead-tombstone housekeeping (#1417)", () => {
    // Full-shape lease so evidence assembly never trips on a missing field.
    function tombstoneLease(now: Date, opts: {
      id: string;
      issueId: string;
      expiredMinutesAgo: number;
      disposition?: string;
      retryAfter?: Date | null;
    }) {
      return {
        id: opts.id,
        agentName: "alpha",
        issueId: opts.issueId,
        claimToken: null,
        expiredAt: minutesAgo(now, opts.expiredMinutesAgo),
        renewedAt: minutesAgo(now, opts.expiredMinutesAgo + 40),
        registeredAt: null,
        registrationOccurredAt: null,
        renewCount: 0,
        lastRenewalObservedAt: null,
        lastRenewalOccurredAt: null,
        retryAfter: opts.retryAfter ?? null,
        waitReason: null,
        disposition: opts.disposition ?? "expired",
      };
    }
    function closedIssueRow(id: string, number: number) {
      return {
        id,
        number,
        state: "closed",
        labels: ["status/done", "agent/alpha"],
        blockedReason: null,
        linkedPrNumber: null,
        linkedPrMergeState: null,
        repository: { fullName: REPO },
      };
    }

    it("a closed-issue tombstone is pruned so the live candidate is examined (batch 1)", async () => {
      // With a batch of one, a pre-filter batch scan would put only the dead
      // tombstone in the window: the live candidate waits a pass and, without
      // any pruning, forever. The paging scan classifies the whole tombstone
      // prefix in one read, so `enforce` prunes the dead row AND examines the
      // live candidate in the SAME pass.
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.issue.push(closedIssueRow("issue-closed", 90));
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-dead", issueId: "issue-closed", expiredMinutesAgo: 120 }),
        tombstoneLease(now, { id: "tomb-live", issueId: ISSUE_ID, expiredMinutesAgo: 50 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");

      const first = await runReconcile(fixture, now, "enforce");
      expect(first.examined).toBe(1);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-live"]);

      // Pass 2: the window is unblocked; the live tombstone stays a candidate.
      const second = await runReconcile(fixture, now, "enforce");
      expect(second.examined).toBe(1);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-live"]);
    });

    it("audit mode pages past more than batchSize dead tombstones to reach a valid candidate", async () => {
      // #1417 round 3 hard-blocker: audit skips the prune (read-only contract),
      // so a pre-filter batch let >batchSize retained tombstones permanently
      // hide the one dead claim with real stale-owner evidence — the audit
      // acceptance criterion died in exactly the mode meant to surface it.
      // Paging must surface the candidate with ZERO mutations.
      const now = new Date();
      const fixture = buildFixture(now);
      for (let i = 0; i < 4; i++) {
        fixture.tables.issue.push(closedIssueRow(`issue-closed-${i}`, 90 + i));
      }
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-dead-0", issueId: "issue-closed-0", expiredMinutesAgo: 400 }),
        tombstoneLease(now, { id: "tomb-dead-1", issueId: "issue-closed-1", expiredMinutesAgo: 300 }),
        tombstoneLease(now, { id: "tomb-dead-2", issueId: "issue-closed-2", expiredMinutesAgo: 200 }),
        tombstoneLease(now, { id: "tomb-dead-3", issueId: "issue-closed-3", expiredMinutesAgo: 100 }),
        // The valid dead-claim candidate sits behind ALL of them, oldest-last.
        tombstoneLease(now, { id: "tomb-live", issueId: ISSUE_ID, expiredMinutesAgo: 50 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");

      const report = await runReconcile(fixture, now, "audit");
      expect(report.examined).toBe(1);
      // Read-only contract intact: nothing pruned.
      expect(fixture.tables.lease.map((r) => r.id).sort()).toEqual(
        ["tomb-dead-0", "tomb-dead-1", "tomb-dead-2", "tomb-dead-3", "tomb-live"].sort(),
      );
      const annotations = fixture.tables.auditLog.filter((r: any) => r.action === "ownership_reconcile_candidate");
      expect(annotations.length).toBeGreaterThanOrEqual(1);
    });

    it("enforce prunes more than batchSize dead tombstones and examines the candidate in one pass", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      for (let i = 0; i < 3; i++) {
        fixture.tables.issue.push(closedIssueRow(`issue-closed-${i}`, 90 + i));
      }
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-dead-0", issueId: "issue-closed-0", expiredMinutesAgo: 300 }),
        tombstoneLease(now, { id: "tomb-dead-1", issueId: "issue-closed-1", expiredMinutesAgo: 200 }),
        tombstoneLease(now, { id: "tomb-dead-2", issueId: "issue-closed-2", expiredMinutesAgo: 100 }),
        tombstoneLease(now, { id: "tomb-live", issueId: ISSUE_ID, expiredMinutesAgo: 50 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");

      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(1);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-live"]);
    });

    it("enforce prunes a window of ONLY dead tombstones (GC runs before the empty-candidate return)", async () => {
      // The housekeeping delete must run even when nothing survives the scan:
      // a pure-dead window that returns early without pruning never shrinks.
      const now = new Date();
      const fixture = buildFixture(now);
      for (let i = 0; i < 3; i++) {
        fixture.tables.issue.push(closedIssueRow(`issue-closed-${i}`, 90 + i));
      }
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-dead-0", issueId: "issue-closed-0", expiredMinutesAgo: 300 }),
        tombstoneLease(now, { id: "tomb-dead-1", issueId: "issue-closed-1", expiredMinutesAgo: 200 }),
        tombstoneLease(now, { id: "tomb-dead-2", issueId: "issue-closed-2", expiredMinutesAgo: 100 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");

      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(0);
      expect(fixture.tables.lease).toHaveLength(0);
    });

    it("audit pages ACROSS 50-row pages to reach a valid candidate", async () => {
      // >50 dead tombstones force skip-based multi-page reads: page 1 is pure
      // dead rows, the candidate sits on page 2. Audit must still examine it
      // with zero mutations.
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.lease.length = 0;
      for (let i = 0; i < 60; i++) {
        fixture.tables.issue.push(closedIssueRow(`issue-closed-${i}`, 100 + i));
        fixture.tables.lease.push(
          tombstoneLease(now, { id: `tomb-dead-${i}`, issueId: `issue-closed-${i}`, expiredMinutesAgo: 660 - i }),
        );
      }
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-live", issueId: ISSUE_ID, expiredMinutesAgo: 50 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");

      const report = await runReconcile(fixture, now, "audit");
      expect(report.examined).toBe(1);
      expect(fixture.tables.lease).toHaveLength(61);
    });

    it("the id tiebreak pages tombstones sharing one expiredAt deterministically", async () => {
      // 55 dead tombstones with an IDENTICAL expiredAt straddle the page
      // boundary: without the `id` tiebreak the skip-offset order is unstable
      // and rows can be double-read or skipped forever. Enforce must examine
      // the candidate and prune every dead row in one pass.
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.lease.length = 0;
      for (let i = 0; i < 55; i++) {
        fixture.tables.issue.push(closedIssueRow(`issue-closed-${i}`, 100 + i));
        fixture.tables.lease.push(
          tombstoneLease(now, { id: `tomb-dead-${String(i).padStart(2, "0")}`, issueId: `issue-closed-${i}`, expiredMinutesAgo: 200 }),
        );
      }
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-live", issueId: ISSUE_ID, expiredMinutesAgo: 50 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");

      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(1);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-live"]);
    });

    it("protected non-candidate rows (intent/receipt/park) do not consume the window", async () => {
      // The reviewer's re-starvation shape: parked-intent, receipt and park
      // rows can never be candidates but are never prunable — they must be
      // paged past, not counted, or a cluster of them re-blocks the window.
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.issue.push(
        closedIssueRow("issue-held", 90),
        closedIssueRow("issue-receipt", 91),
        {
          id: "issue-parked",
          number: 92,
          state: "closed",
          labels: ["status/done"],
          blockedReason: null,
          linkedPrNumber: null,
          linkedPrMergeState: null,
          repository: { fullName: REPO },
        },
      );
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-held", issueId: "issue-held", expiredMinutesAgo: 300 }),
        tombstoneLease(now, {
          id: "tomb-receipt",
          issueId: "issue-receipt",
          expiredMinutesAgo: -20, // still-live receipt
          disposition: "released",
        }),
        tombstoneLease(now, {
          id: "tomb-park",
          issueId: "issue-parked",
          expiredMinutesAgo: 200,
          retryAfter: new Date(now.getTime() + 30 * MIN),
        }),
        tombstoneLease(now, { id: "tomb-live", issueId: ISSUE_ID, expiredMinutesAgo: 50 }),
      );
      fixture.tables.ownershipReleaseIntent.push({
        id: "intent-1",
        issueId: "issue-held",
        agentName: "alpha",
        agentLabel: "agent/alpha",
        attemptToken: "tok-held",
        phase: "pending",
        attempts: 1,
        parkedAt: minutesAgo(now, 5),
      });
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");

      // Replay is skipped for parked intents, so the candidate scan sees the
      // protected cluster ahead of the live candidate.
      const report = await runReconcile(fixture, now, "audit");
      expect(report.examined).toBe(1);
      // Nothing mutated in audit: protected rows AND the dead-free table intact.
      expect(fixture.tables.lease.map((r) => r.id).sort()).toEqual(
        ["tomb-held", "tomb-live", "tomb-park", "tomb-receipt"].sort(),
      );
    });

    it("audit mode prunes nothing (read-only contract)", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.issue.push(closedIssueRow("issue-closed", 90));
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-dead", issueId: "issue-closed", expiredMinutesAgo: 120 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");
      const report = await runReconcile(fixture, now, "audit");
      expect(report.examined).toBe(0);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-dead"]);
    });

    it("enforce preserves a tombstone whose cached labels lost the agent label while the forge still carries it (#1417 review round 4)", async () => {
      // The claim route writes GitHub BEFORE the local mirror transaction; a
      // failed mirror leaves the live `agent/alpha` label invisible to the
      // cached labels. Deleting the tombstone on that stale cache would
      // destroy the only Dispatch-side evidence and strand the live claim —
      // the #1417 failure mode again. The delete requires a LIVE forge read.
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.issue[0].labels = ["status/in-progress"]; // cache: pre-claim
      forgeShared.setLabels(REPO, 42, ["status/in-progress", "agent/alpha"]); // forge: claimed
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-cache-stale", issueId: ISSUE_ID, expiredMinutesAgo: 120 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");

      const report = await runReconcile(fixture, now, "enforce");
      // The live read ran, saw the claim, and the evidence survived.
      expect(forgeShared.liveReads).toBeGreaterThanOrEqual(1);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-cache-stale"]);
      // The stale cache is not a candidate source: nothing examined.
      expect(report.examined).toBe(0);

      // Recoverable: once sync reflects the live label, the SAME tombstone
      // becomes candidate evidence and is examined — never destroyed.
      fixture.tables.issue[0].labels = ["status/in-progress", "agent/alpha"];
      const second = await runReconcile(fixture, now, "enforce");
      expect(second.examined).toBe(1);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-cache-stale"]);
    });

    it("enforce deletes an open-issue tombstone once the live forge read confirms the claim is gone", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.issue[0].labels = ["status/in-progress"]; // cache: no claim
      forgeShared.setLabels(REPO, 42, ["status/in-progress"]); // forge: no claim either
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-genuinely-dead", issueId: ISSUE_ID, expiredMinutesAgo: 120 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");

      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(0);
      expect(fixture.tables.lease).toHaveLength(0);
    });

    it("a failed live forge read fails closed: the open-issue tombstone survives for a later pass", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.issue[0].labels = ["status/in-progress"];
      forgeShared.labels.delete(`${REPO}#42`); // getLiveIssueLabels throws
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-unverifiable", issueId: ISSUE_ID, expiredMinutesAgo: 120 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");

      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(0);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-unverifiable"]);
    });

    it("a tombstone on an issue holding a parked intent survives cleanup", async () => {
      // Phase C's settle re-check reads exactly this lease row; deleting it
      // would wedge the settlement. Parked intents stay out of the replay
      // window, so this pass sees only the candidate scan.
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.issue.push(closedIssueRow("issue-closed", 90));
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-held", issueId: "issue-closed", expiredMinutesAgo: 120 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      fixture.tables.ownershipReleaseIntent.push({
        id: "intent-1",
        issueId: "issue-closed",
        agentName: "alpha",
        agentLabel: "agent/alpha",
        attemptToken: "tok-dead",
        phase: "pending",
        attempts: 1,
        parkedAt: minutesAgo(now, 5),
      });
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(0);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-held"]);
    });

    it("a terminal disposition on a still-live lease is kept as the worker's receipt", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.issue.push(closedIssueRow("issue-closed", 90));
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, {
          id: "lease-live",
          issueId: "issue-closed",
          expiredMinutesAgo: -20, // expiresAt in the future
          disposition: "released",
        }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(0);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["lease-live"]);
    });

    it("a still-running park (future retryAfter) is left to the stale-work sweep", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.issue.push({
        id: "issue-wait",
        number: 91,
        state: "open",
        labels: ["status/blocked"], // no agent/* label: not a candidate
        blockedReason: null,
        linkedPrNumber: null,
        linkedPrMergeState: null,
        repository: { fullName: REPO },
      });
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, {
          id: "tomb-parked",
          issueId: "issue-wait",
          expiredMinutesAgo: 120,
          retryAfter: new Date(now.getTime() + 30 * MIN),
        }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(0);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-parked"]);
    });

    it("an open issue whose agent label moved on (park spent) is pruned too", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.issue.push(
        closedIssueRow("issue-closed", 90),
        {
          id: "issue-reassigned",
          number: 92,
          state: "open",
          labels: ["status/ready"], // the claim moved on: no agent/* label left
          blockedReason: null,
          linkedPrNumber: null,
          linkedPrMergeState: null,
          repository: { fullName: REPO },
        },
      );
      // Round 4: the open-issue prune requires LIVE proof the claim is gone,
      // so the forge must agree with the cache here.
      forgeShared.setLabels(REPO, 92, ["status/ready"]);
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-dead", issueId: "issue-closed", expiredMinutesAgo: 120 }),
        tombstoneLease(now, { id: "tomb-moved", issueId: "issue-reassigned", expiredMinutesAgo: 110 }),
        tombstoneLease(now, { id: "tomb-live", issueId: ISSUE_ID, expiredMinutesAgo: 50 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "3");
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(1);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-live"]);
    });

    it("a reactivation committed between the scan and the delete survives the fence", async () => {
      // The guards are evaluated on the scan read; the DELETE must be
      // CAS-fenced so a claim that reactivates the row in place (disposed-row
      // path: disposition cleared, token rotated, expiredAt pushed forward)
      // between the two is never destroyed.
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.issue.push(closedIssueRow("issue-closed", 90));
      fixture.tables.lease.length = 0;
      fixture.tables.lease.push(
        tombstoneLease(now, { id: "tomb-dead", issueId: "issue-closed", expiredMinutesAgo: 120 }),
      );
      fixture.tables.agentWork.length = 0;
      fixture.tables.ownershipReconcileCandidate.length = 0;
      vi.stubEnv("DISPATCH_RECONCILE_BATCH_SIZE", "1");
      const baseDeleteMany = fixture.client.lease.deleteMany;
      let reactivated = false;
      fixture.client.lease.deleteMany = async (args: any) => {
        if (!reactivated && args?.where?.id) {
          reactivated = true;
          const row = fixture.tables.lease.find((r) => r.id === "tomb-dead");
          if (row) {
            row.disposition = null;
            row.claimToken = "tok-rotated";
            row.expiredAt = new Date(now.getTime() + 30 * MIN);
          }
        }
        return baseDeleteMany(args);
      };
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.examined).toBe(0);
      expect(reactivated).toBe(true);
      expect(fixture.tables.lease.map((r) => r.id)).toEqual(["tomb-dead"]);
      expect(fixture.tables.lease[0].claimToken).toBe("tok-rotated");
    });
  });

  describe("§8.7 pinned negative controls", () => {
    it("control 1a: a renewed same-agent claim defeats the stale releaser (zero forge calls)", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      // Mature candidate so the first pass goes straight to release.
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      // Concurrent renewal: the worker renews AFTER the reconciler's decision
      // snapshot but BEFORE its Phase A CAS — instrumented on the guard
      // acquisition, which is exactly the window the CAS fences.
      const baseGuard = fixture.guard.fake;
      const renewedOnAcquire = async (request: any, callback: any) => {
        if (request.operation === "reconcile-release") {
          const lease = fixture.tables.lease[0];
          lease.renewedAt = now;
          lease.lastRenewalObservedAt = now;
          lease.expiredAt = new Date(now.getTime() + 30 * MIN);
          fixture.tables.agentWork[0].lastHeartbeatAt = now;
        }
        return baseGuard(request, callback);
      };
      vi.stubEnv("DISPATCH_OWNERSHIP_RECONCILE_MODE", "enforce");
      const { reconcileOwnership } = await import("@/lib/ownership-reconciliation");
      const report = await reconcileOwnership(
        { prisma: fixture.client, forge: forgeShared, guard: renewedOnAcquire },
        now,
      );
      // Phase A CAS matched nothing: zero forge calls, claim intact.
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.lease[0].claimToken).toBe("tok-g");
      expect(fixture.tables.issue[0].labels).toContain("agent/alpha");
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      expect(report.skipped).toBeGreaterThanOrEqual(1);
    });

    it("control 1b: after settle, a same-agent re-claim re-adds the label under a fresh token", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      await runReconcile(fixture, now, "enforce");
      expect(fixture.tables.issue[0].labels).not.toContain("agent/alpha");

      // The agent re-claims: new lease row, new attempt token, label re-added.
      const later = new Date(now.getTime() + 20 * MIN);
      forgeShared.setLabels(REPO, 42, ["status/ready", "agent/alpha"]);
      fixture.tables.issue[0].labels = ["status/ready", "agent/alpha"];
      fixture.tables.lease.push({
        id: "lease-2",
        agentName: "alpha",
        issueId: ISSUE_ID,
        claimToken: "tok-g1",
        expiredAt: new Date(later.getTime() + 30 * MIN),
        renewedAt: later,
        registeredAt: later,
        registrationOccurredAt: later,
        renewCount: 0,
        lastRenewalObservedAt: null,
        lastRenewalOccurredAt: null,
        retryAfter: null,
        waitReason: null,
        disposition: null,
      });
      fixture.tables.agentWork.push({
        id: "work-2",
        agentName: "alpha",
        issueId: ISSUE_ID,
        state: "IN_PROGRESS",
        lastHeartbeatAt: later,
      });

      const report = await runReconcile(fixture, later, "enforce");
      // Fresh evidence: nothing released, exactly one agent label.
      expect(report.released).toBe(0);
      const agentLabels = fixture.tables.issue[0].labels.filter((l: string) => l.startsWith("agent/"));
      expect(agentLabels).toEqual(["agent/alpha"]);
      expect(agentRemoveCalls(), JSON.stringify(forgeShared.removeCalls)).toEqual(["agent/alpha"]); // only the original release
      expect(fixture.tables.lease).toHaveLength(1);
      expect(fixture.tables.lease[0].claimToken).toBe("tok-g1");
    });

    it("control 2: a changed-owner reassign means the old intent deletes nothing", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      // A pending release intent for agent/alpha...
      fixture.tables.ownershipReleaseIntent.push({
        id: "intent-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        agentLabel: "agent/alpha",
        attemptToken: "tok-g",
        phase: "pending",
        attempts: 1,
        parkedAt: null,
      });
      // ...and the operator reassigns the issue to bravo (supersede + label swap).
      const { supersedeOwnershipReleaseIntent } = await import("@/lib/ownership-reconciliation");
      const superseded = await supersedeOwnershipReleaseIntent({
        issueId: ISSUE_ID,
        actor: "operator",
        reason: "reassign to bravo",
        prisma: fixture.client,
      });
      expect(superseded).toBe(true);
      fixture.tables.issue[0].labels = ["status/in-progress", "agent/bravo"];
      forgeShared.setLabels(REPO, 42, ["status/in-progress", "agent/bravo"]);

      const report = await runReconcile(fixture, now, "enforce");
      expect(report.superseded).toBe(1);
      // Zero forge calls: the bravo label is never a delete target.
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.issue[0].labels).toContain("agent/bravo");
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
    });

    it("control 3: GitHub delete succeeds, DB settlement fails — replay settles exactly once", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      // First pass: Phase B's remote delete succeeds, the settle transaction
      // throws (fault on the intent delete inside the transaction).
      fixture.faults.failIntentDelete = true;
      const first = await runReconcile(fixture, now, "enforce");
      expect(first.released).toBe(0);
      expect(first.errors.length).toBeGreaterThan(0);
      expect(forgeShared.removeCalls).toHaveLength(1);
      // The intent is still pending and the local state is untouched.
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(1);
      expect(fixture.tables.lease[0].claimToken).toBe(null); // retired at Phase A
      expect(fixture.tables.issue[0].labels).toContain("agent/alpha"); // cache mirrored only at settle
      expect(fixture.tables.issueLifecycleEvent.filter((e: any) => e.kind === "claim_released")).toHaveLength(0);

      // Replay pass: idempotent delete (the label is already gone → 404
      // accepted), then settle exactly once.
      const second = await runReconcile(fixture, new Date(now.getTime() + MIN), "enforce");
      expect(second.released).toBe(1);
      expect(agentRemoveCalls(), JSON.stringify(forgeShared.removeCalls)).toEqual(["agent/alpha", "agent/alpha"]); // retry of the same intent
      const releases = fixture.tables.issueLifecycleEvent.filter((e: any) => e.kind === "claim_released");
      expect(releases).toHaveLength(1);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      expect(fixture.tables.lease).toHaveLength(0);
      expect(fixture.tables.agentWork[0].state).toBe("RELEASED");

      // A third pass (stale retry after settle) issues ZERO forge calls.
      forgeShared.removeCalls.length = 0;
      const third = await runReconcile(fixture, new Date(now.getTime() + 2 * MIN), "enforce");
      expect(third.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
    });

    it("control 4: a stale retry after a fresh live claim never deletes the new label", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      // Settled release already happened; a fresh claim now holds the label.
      fixture.tables.issue[0].labels = ["status/ready", "agent/alpha"];
      forgeShared.setLabels(REPO, 42, ["status/ready", "agent/alpha"]);
      fixture.tables.lease.length = 0;
      fixture.tables.agentWork.length = 0;
      fixture.tables.lease.push({
        id: "lease-2",
        agentName: "alpha",
        issueId: ISSUE_ID,
        claimToken: "tok-g1",
        expiredAt: new Date(now.getTime() + 30 * MIN),
        renewedAt: now,
        registeredAt: now,
        registrationOccurredAt: now,
        renewCount: 0,
        lastRenewalObservedAt: null,
        lastRenewalOccurredAt: null,
        retryAfter: null,
        waitReason: null,
        disposition: null,
      });
      // NO matching intent exists (it was cleared at settle). The stale retry
      // is whatever the operator re-runs: the replay pass finds nothing.
      const report = await runReconcile(fixture, now, "enforce");
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.issue[0].labels).toContain("agent/alpha");
      expect(report.released).toBe(0);
    });

    it("control 5: claim vs Phase A commit in BOTH lock orders — no label is stolen", async () => {
      // (i) claim-first: the claim holds the anchor, Phase A is busy, zero
      // forge calls, the fresh claim's label survives.
      {
        const now = new Date();
        const fixture = buildFixture(now);
        fixture.tables.ownershipReconcileCandidate.push({
          id: "cand-1",
          issueId: ISSUE_ID,
          agentName: "alpha",
          staleCount: 1,
          firstStaleAt: minutesAgo(now, 30),
          lastObservedAt: minutesAgo(now, 10),
          reclaimCount: 0,
          lastReclaimAt: null,
        });
        fixture.guard.held.set(ISSUE_ID, { operation: "claim", agentName: "alpha" });
        const report = await runReconcile(fixture, now, "enforce");
        expect(report.skipped).toBeGreaterThanOrEqual(1);
        expect(forgeShared.removeCalls).toHaveLength(0);
        expect(fixture.tables.issue[0].labels).toContain("agent/alpha");
        expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      }
      // (ii) release-first: Phase A holds the anchor; a concurrent claim's
      // guard attempt is held (the route 409s it) and issues no remote add
      // until settle. After settle, the claim proceeds against the settled
      // state.
      {
        const now = new Date();
        const fixture = buildFixture(now);
        fixture.tables.ownershipReconcileCandidate.push({
          id: "cand-1",
          issueId: ISSUE_ID,
          agentName: "alpha",
          staleCount: 1,
          firstStaleAt: minutesAgo(now, 30),
          lastObservedAt: minutesAgo(now, 10),
          reclaimCount: 0,
          lastReclaimAt: null,
        });
        // Instrument the guard: the probe runs INSIDE the reconciler's guard
        // callback, i.e. while the release holds the anchor — a concurrent
        // claim attempt must observe busy there.
        const baseGuard = fixture.guard.fake;
        const claimAttempts: string[] = [];
        let probed = false;
        const instrumented = async (request: any, callback: any) => {
          if (request.operation === "reconcile-release" && !probed) {
            probed = true;
            const wrapped = async (...cbArgs: any[]) => {
              const probe = { issueId: request.issueId, operation: "claim", agentName: "bravo" };
              const result = await baseGuard(probe, async () => ({ complete: true, value: null }));
              claimAttempts.push(result.status);
              return callback(...cbArgs);
            };
            return baseGuard(request, wrapped);
          }
          return baseGuard(request, callback);
        };
        vi.stubEnv("DISPATCH_OWNERSHIP_RECONCILE_MODE", "enforce");
        const { reconcileOwnership } = await import("@/lib/ownership-reconciliation");
        await reconcileOwnership(
          { prisma: fixture.client, forge: forgeShared, guard: instrumented },
          now,
        );
        expect(claimAttempts).toEqual(["busy"]);
        // The release still completed; the claim is 409-held and its add was
        // never issued while the intent was pending.
        expect(agentRemoveCalls()).toEqual(["agent/alpha"]);
        expect(fixture.tables.issue[0].labels).not.toContain("agent/alpha");
        expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      }
    });
  });

  describe("the §8.7 protocol internals", () => {
    it("intent-only Phase A: a claim with stale AgentWork but no lease row releases with a null-token intent", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      // A worker that started work before claiming (design §3.5): an active
      // AgentWork row exists but its Lease row is gone, so the decision epoch
      // is null and Phase A runs the intent-only branch under the lock.
      fixture.tables.lease.length = 0;
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.released).toBe(1);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0); // settled
      expect(agentRemoveCalls()).toEqual(["agent/alpha"]);
      expect(fixture.tables.issue[0].labels).not.toContain("agent/alpha");
      expect(fixture.tables.agentWork[0].state).toBe("RELEASED");
    });

    it("intent-only Phase A aborts when the live label set no longer names the agent", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.lease.length = 0;
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      // By Phase A the label has moved to a different owner (identity change):
      // the intent must NOT be committed (§12 — no stealing).
      forgeShared.onLiveRead = () => {
        forgeShared.setLabels(REPO, 42, ["status/in-progress", "agent/bravo"]);
        fixture.tables.issue[0].labels = ["status/in-progress", "agent/bravo"];
      };
      const report = await runReconcile(fixture, now, "enforce");
      // The stale AgentWork (alpha) versus the live label (bravo) is a
      // ownership conflict: surfaced, never resolved — no release (§4).
      expect(report.released).toBe(0);
      expect(report.retained).toBeGreaterThanOrEqual(1);
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      expect(fixture.tables.issue[0].labels).toContain("agent/bravo");
    });

    it("Phase-B forge outage leaves the intent pending and parks after bounded retries", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      forgeShared.failRemove = () => {
        throw new Error("503 forge unavailable");
      };

      // First release attempt: Phase A commits, Phase B fails, intent pending.
      const first = await runReconcile(fixture, now, "enforce");
      expect(first.released).toBe(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(1);
      expect(fixture.tables.issue[0].labels).toContain("agent/alpha");

      // Replay until the retry budget is exhausted: each pass bumps attempts
      // and fails; on the attempt that reaches the cap the intent is parked.
      let report = first;
      let parkedSeen = 0;
      for (let i = 0; i < 6; i++) {
        report = await runReconcile(fixture, new Date(now.getTime() + (i + 1) * MIN), "enforce");
        parkedSeen += report.parked;
      }
      expect(parkedSeen).toBe(1);
      const intent = fixture.tables.ownershipReleaseIntent[0];
      expect(intent.phase).toBe("pending");
      expect(intent.parkedAt).not.toBeNull();
      // Parked: no further forge calls on later passes.
      const callsAfterPark = forgeShared.removeCalls.length;
      await runReconcile(fixture, new Date(now.getTime() + 10 * MIN), "enforce");
      expect(forgeShared.removeCalls).toHaveLength(callsAfterPark);
    });
  });

  describe("§8.5 status selection", () => {
    it.each([
      [["status/in-progress"], null, "status/ready"],
      [["status/blocked"], "deliberate hold", null],
      [["status/blocked"], null, "status/ready"],
      [["status/in-review"], null, null],
      [["status/ready"], null, null],
      [[], null, null],
    ])("selectNextStatusAfterRelease(%j, %j) → %j", async (labels, blockedReason, expected) => {
      const { selectNextStatusAfterRelease } = await import("@/lib/ownership-reconciliation");
      expect(selectNextStatusAfterRelease(labels as string[], blockedReason as string | null)).toBe(expected);
    });
  });

  describe("supersede helper", () => {
    it("returns false when nothing is pending and true (with an audit row) when it superseded", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      const { supersedeOwnershipReleaseIntent } = await import("@/lib/ownership-reconciliation");
      expect(
        await supersedeOwnershipReleaseIntent({ issueId: ISSUE_ID, actor: "op", reason: "x", prisma: fixture.client }),
      ).toBe(false);
      fixture.tables.ownershipReleaseIntent.push({
        id: "intent-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        agentLabel: "agent/alpha",
        attemptToken: "tok-g",
        phase: "pending",
        attempts: 0,
        parkedAt: null,
      });
      expect(
        await supersedeOwnershipReleaseIntent({ issueId: ISSUE_ID, actor: "op", reason: "x", prisma: fixture.client }),
      ).toBe(true);
      expect(fixture.tables.ownershipReleaseIntent[0].phase).toBe("superseded");
      const actions = fixture.tables.auditLog.map((r) => r.action);
      expect(actions).toContain("ownership_release_intent_superseded");
    });
  });

  describe("review hardening (#1254)", () => {
    function makeLeaseRow(now: Date, overrides: Record<string, unknown> = {}) {
      return {
        id: "lease-x",
        agentName: "alpha",
        issueId: ISSUE_ID,
        claimToken: "tok-g",
        expiredAt: minutesAgo(now, 20),
        renewedAt: minutesAgo(now, 60),
        registeredAt: minutesAgo(now, 60),
        registrationOccurredAt: minutesAgo(now, 60),
        renewCount: 1,
        lastRenewalObservedAt: minutesAgo(now, 60),
        lastRenewalOccurredAt: minutesAgo(now, 60),
        retryAfter: null,
        waitReason: null,
        disposition: null,
        ...overrides,
      };
    }

    it("audit mode does not replay a pending intent (no mutations at all)", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReleaseIntent.push({
        id: "intent-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        agentLabel: "agent/alpha",
        attemptToken: "tok-g",
        phase: "pending",
        attempts: 1,
        parkedAt: null,
      });
      const report = await runReconcile(fixture, now, "audit");
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent[0].phase).toBe("pending");
      expect(fixture.tables.lease).toHaveLength(1);
      expect(report.released).toBe(0);
      expect(report.replayed).toBe(0);
    });

    it("a terminal-disposition lease is releasable evidence (CAS matches the disposition)", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.lease[0] = {
        ...fixture.tables.lease[0],
        disposition: "completed",
        dispositionNote: "worker died after declaring completion",
        dispositionOccurredAt: minutesAgo(now, 60),
        dispositionObservedAt: minutesAgo(now, 60),
        expiredAt: new Date(now.getTime() + 30 * MIN), // still "live" by TTL
      };
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.released).toBe(1);
      expect(agentRemoveCalls()).toEqual(["agent/alpha"]);
      expect(fixture.tables.lease).toHaveLength(0);
      expect(fixture.tables.agentWork[0].state).toBe("RELEASED");
    });

    it("a release stamps the reclaim counter and cooldown; the next cycle parks at the cap", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      await runReconcile(fixture, now, "enforce");
      await runReconcile(fixture, new Date(now.getTime() + 10 * MIN), "enforce");
      const row = fixture.tables.ownershipReconcileCandidate.find((r: any) => r.issueId === ISSUE_ID)!;
      expect(row.reclaimCount).toBe(1);
      expect(row.lastReclaimAt).not.toBeNull();
      expect(row.staleCount).toBe(0);
      expect(row.lastObservedAt).toBeNull();

      // Re-abandon three more times: the ladder parks once the counter
      // reaches the cap (3) BEFORE a fourth release.
      for (let cycle = 0; cycle < 3; cycle++) {
        fixture.tables.lease.push(makeLeaseRow(new Date(now.getTime() + 60 * MIN * (cycle + 1))));
        fixture.tables.agentWork.push({
          id: `work-${cycle + 2}`,
          agentName: "alpha",
          issueId: ISSUE_ID,
          state: "IN_PROGRESS",
          lastHeartbeatAt: minutesAgo(new Date(now.getTime() + 60 * MIN * (cycle + 1)), 60),
        });
        fixture.tables.issue[0].labels = ["status/ready", "agent/alpha"];
        forgeShared.setLabels(REPO, 42, ["status/ready", "agent/alpha"]);
        const cycleNow = new Date(now.getTime() + 60 * MIN * (cycle + 2) + 10 * MIN);
        const first = await runReconcile(fixture, cycleNow, "enforce");
        if (cycle < 2) {
          expect(first.retained).toBeGreaterThanOrEqual(1);
          const second = await runReconcile(fixture, new Date(cycleNow.getTime() + 10 * MIN), "enforce");
          expect(second.released).toBe(1);
        } else {
          // The counter reached the cap: the ladder parks at the FIRST pass,
          // needs-human, with no release.
          expect(first.held).toBe(1);
          expect(first.retained).toBe(0);
          expect(first.released).toBe(0);
          expect(forgeShared.removeCalls.filter((c) => c.label === "agent/alpha").length).toBeLessThan(4);
        }
      }
    });

    it("released/intent-held issues do not consume the per-run quota", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      // Two already-released ladder rows (no agent label any more) that once
      // starved the bounded scan.
      for (const id of ["issue-2", "issue-3"]) {
        fixture.tables.issue.push({
          id, number: 43, state: "open", labels: ["status/ready"],
          blockedReason: null, linkedPrNumber: null, linkedPrMergeState: null,
          repository: { fullName: REPO },
        });
        fixture.tables.ownershipReconcileCandidate.push({
          id: `cand-${id}`, issueId: id, agentName: "alpha", staleCount: 2,
          firstStaleAt: minutesAgo(now, 60), lastObservedAt: minutesAgo(now, 30),
          reclaimCount: 0, lastReclaimAt: null,
        });
      }
      const report = await runReconcile(fixture, now, "enforce");
      // Only the real candidate (issue-1) is examined.
      expect(report.examined).toBe(1);
      expect(report.retained).toBe(1);
    });

    it("a checkpoint heartbeat between the decision and Phase A defeats the release", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      const baseGuard = fixture.guard.fake;
      const heartbeatedOnAcquire = async (request: any, callback: any) => {
        if (request.operation === "reconcile-release") {
          fixture.tables.agentWork[0].lastHeartbeatAt = now;
        }
        return baseGuard(request, callback);
      };
      vi.stubEnv("DISPATCH_OWNERSHIP_RECONCILE_MODE", "enforce");
      const { reconcileOwnership } = await import("@/lib/ownership-reconciliation");
      const report = await reconcileOwnership(
        { prisma: fixture.client, forge: forgeShared, guard: heartbeatedOnAcquire },
        now,
      );
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.issue[0].labels).toContain("agent/alpha");
      expect(fixture.tables.lease[0].claimToken).toBe("tok-g");
      expect(report.skipped).toBeGreaterThanOrEqual(1);
    });

    it("an owner change resets the confirmation ladder for the new owner", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      // The ladder observed alpha twice; the claim has since moved to bravo
      // (operator assignment) and gone stale again.
      fixture.tables.issue[0].labels = ["status/in-progress", "agent/bravo"];
      forgeShared.setLabels(REPO, 42, ["status/in-progress", "agent/bravo"]);
      fixture.tables.lease[0].agentName = "bravo";
      fixture.tables.agentWork[0].agentName = "bravo";
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 2,
        firstStaleAt: minutesAgo(now, 60),
        lastObservedAt: minutesAgo(now, 30),
        reclaimCount: 1,
        lastReclaimAt: minutesAgo(now, 40),
      });
      const report = await runReconcile(fixture, now, "enforce");
      // Bravo gets a fresh ladder: first observation only.
      expect(report.retained).toBe(1);
      expect(report.released).toBe(0);
      const row = fixture.tables.ownershipReconcileCandidate[0];
      expect(row.agentName).toBe("bravo");
      expect(row.staleCount).toBe(1);
      expect(row.reclaimCount).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
    });

    it("replay after another writer already released clears the intent without a second event", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReleaseIntent.push({
        id: "intent-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        agentLabel: "agent/alpha",
        attemptToken: "tok-g",
        phase: "pending",
        attempts: 1,
        parkedAt: null,
      });
      // The stale-work sweep already released the claim: lease gone, label
      // gone from the live set, lifecycle event already recorded by the sweep.
      fixture.tables.lease.length = 0;
      fixture.tables.agentWork.length = 0;
      fixture.tables.issue[0].labels = ["status/in-progress"];
      forgeShared.setLabels(REPO, 42, ["status/in-progress"]);
      const report = await runReconcile(fixture, now, "enforce");
      expect(report.released).toBe(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      const releases = fixture.tables.issueLifecycleEvent.filter((e: any) => e.kind === "claim_released");
      expect(releases).toHaveLength(0); // no double-settle
      expect(fixture.tables.issue[0].labels).toEqual(["status/in-progress"]);
    });

    it("intent-only Phase A aborts when a fresh lease exists under the lock", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.lease.length = 0;
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      // A fresh claim lands between the decision and Phase A (guard-acquire
      // hook): the intent-only branch must refuse to commit.
      const baseGuard = fixture.guard.fake;
      const claimedOnAcquire = async (request: any, callback: any) => {
        if (request.operation === "reconcile-release") {
          fixture.tables.lease.push(makeLeaseRow(now, {
            id: "lease-new",
            claimToken: "tok-g1",
            expiredAt: new Date(now.getTime() + 30 * MIN),
            renewedAt: now,
            lastRenewalObservedAt: now,
          }));
        }
        return baseGuard(request, callback);
      };
      vi.stubEnv("DISPATCH_OWNERSHIP_RECONCILE_MODE", "enforce");
      const { reconcileOwnership } = await import("@/lib/ownership-reconciliation");
      const report = await reconcileOwnership(
        { prisma: fixture.client, forge: forgeShared, guard: claimedOnAcquire },
        now,
      );
      expect(forgeShared.removeCalls).toHaveLength(0);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      expect(fixture.tables.lease).toHaveLength(1);
      expect(fixture.tables.lease[0].claimToken).toBe("tok-g1");
      expect(report.skipped).toBeGreaterThanOrEqual(1);
    });
  });

    it("off mode still replays a pending intent (no new releases, but the barrier settles)", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      fixture.tables.ownershipReleaseIntent.push({
        id: "intent-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        agentLabel: "agent/alpha",
        attemptToken: "tok-g",
        phase: "pending",
        attempts: 1,
        parkedAt: null,
      });
      // Phase A already retired the token before this intent was committed.
      fixture.tables.lease[0].claimToken = null;
      const report = await runReconcile(fixture, now, "off");
      // The already-committed release settles (no claim barrier held forever).
      expect(agentRemoveCalls()).toEqual(["agent/alpha"]);
      expect(fixture.tables.ownershipReleaseIntent).toHaveLength(0);
      expect(fixture.tables.lease).toHaveLength(0);
      expect(fixture.tables.issue[0].labels).toContain("status/ready");
      // No NEW candidate work happens in off mode.
      expect(report.examined).toBe(0);
      expect(report.released).toBe(1);
    });

    it("Phase B is skipped when the reconcile-release guard was superseded before the remote delete (#1254 tripwire)", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      // Mature observation: enforce would run Phase A → B → C in this pass.
      fixture.tables.ownershipReconcileCandidate.push({
        id: "cand-1",
        issueId: ISSUE_ID,
        agentName: "alpha",
        staleCount: 1,
        firstStaleAt: minutesAgo(now, 30),
        lastObservedAt: minutesAgo(now, 10),
        reclaimCount: 0,
        lastReclaimAt: null,
      });
      // Instrumented guard: the callback runs, but its anchor re-check reports
      // that a maintainer override already cleared this reconcile-release guard.
      const baseGuard = fixture.guard.fake;
      const superseded = async (request: any, callback: any) => {
        if (request.operation === "reconcile-release") {
          return baseGuard(request, (tx: any) =>
            callback(tx, {
            resuming: false,
            stillHoldsGuard: async () => false,
            // #1254: the fenced write reports the lost guard, so the forge
            // delete is NEVER issued by the abandoned attempt.
            runFencedRemoteWrite: async () => ({ status: "guard-lost" }),
          }),
          );
        }
        return baseGuard(request, callback);
      };
      vi.stubEnv("DISPATCH_OWNERSHIP_RECONCILE_MODE", "enforce");
      const { reconcileOwnership } = await import("@/lib/ownership-reconciliation");
      const report = await reconcileOwnership(
        { prisma: fixture.client, forge: forgeShared, guard: superseded },
        now,
      );

      // The abandoned attempt issues ZERO remote deletes...
      expect(forgeShared.removeCalls).toHaveLength(0);
      // ...and the committed intent stays pending (the override's own claim,
      // or the next pass, settles or supersedes it).
      const intent = fixture.tables.ownershipReleaseIntent.find((r: any) => r.issueId === ISSUE_ID);
      expect(intent?.phase).toBe("pending");
      // Nothing settled: the claim's AgentWork row is untouched.
      expect(fixture.tables.agentWork[0].state).not.toBe("RELEASED");
      expect(report.released).toBe(0);
      expect(report.errors.some((e: string) => e.includes("guard no longer held"))).toBe(true);
      // #1254: the guard-loss tripwire records a failure audit.
      const guardLost = fixture.tables.auditLog.filter((r: any) => r.action === "ownership_reconcile_guard_lost");
      expect(guardLost).toHaveLength(1);
      expect(guardLost[0].success).toBe(false);
      expect(guardLost[0].errorMessage).toContain("mutation guard no longer held");
    });

  describe("repo casing fold in the ladder-scan pr-fix read (#1370)", () => {
    // Same rule as #1357 for inspect: PrFixQueueItem.repo is the folded
    // identity (#1145), so the bounded ladder scan must fold the cached
    // `repository.fullName` before querying — otherwise an open queue row is
    // invisible and review ownership is silently under-reported.
    it("queries the queue with the folded repo identity and retains the review-owned claim", async () => {
      const now = new Date();
      const fixture = buildFixture(now);
      const MIXED = "Octocat/Hello-World";
      fixture.tables.issue[0].repository.fullName = MIXED;
      forgeShared.labels.clear();
      forgeShared.setLabels(MIXED, 42, ["status/in-progress", "agent/alpha"]);
      fixture.tables.prFixQueueItem.push({
        id: "qfix-1",
        repo: REPO, // canonical folded identity
        status: "QUEUED",
        issue: 42,
        pr: 77,
      });
      const queueRepos: string[] = [];
      const baseFindFirst = fixture.client.prFixQueueItem.findFirst;
      fixture.client.prFixQueueItem.findFirst = async (args: any) => {
        queueRepos.push(args?.where?.repo);
        return baseFindFirst(args);
      };

      const report = await runReconcile(fixture, now, "enforce");

      expect(queueRepos.length).toBeGreaterThan(0);
      // The query must receive the folded value, never the raw cached casing.
      expect(queueRepos).toEqual(queueRepos.map((r) => r.trim().toLowerCase()));
      expect(queueRepos).not.toContain(MIXED);
      // The folded read finds the open queue row → REVIEW_OWNED → no release.
      expect(report.released).toBe(0);
      expect(forgeShared.removeCalls).toHaveLength(0);
    });
  });
});
