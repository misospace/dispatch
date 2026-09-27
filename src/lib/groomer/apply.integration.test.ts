/**
 * Plan application (#1063) against a real PostgreSQL.
 *
 * The mocked suites evaluate their own copy of these predicates; only a real
 * database proves the selector's backoff clause and the GroomingApplication
 * claim/resume compare-and-swap behave as intended.
 *
 * Opt-in via RUN_DB_INTEGRATION=1 (the database-integration CI job), like
 * sync-lock.integration.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { selectGroomingCandidate } from "./selector";
import { makePrismaApplicationStore, type ApplicationRecord } from "./mutation-applier";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

const REPO = "it-groomer/apply";

suite("plan application against a real PostgreSQL", () => {
  let repositoryId: string;

  async function issue(number: number, extra: Record<string, unknown> = {}) {
    return prisma.issue.create({
      data: {
        number,
        repositoryId,
        title: `Unlabeled issue ${number}`,
        state: "open",
        url: `https://github.com/${REPO}/issues/${number}`,
        labels: [],
        assignees: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        ...extra,
      },
    });
  }

  beforeEach(async () => {
    await prisma.groomingApplication.deleteMany({ where: { repoFullName: REPO } });
    await prisma.groomingRun.deleteMany({ where: { repoFullName: REPO } });
    await prisma.issue.deleteMany({ where: { repository: { fullName: REPO } } });
    await prisma.automationRepo.deleteMany({ where: { fullName: REPO } });
    await prisma.repository.deleteMany({ where: { fullName: REPO } });
    const repository = await prisma.repository.create({
      data: { fullName: REPO, name: "apply", owner: "it-groomer", enabled: true },
    });
    repositoryId = repository.id;
  });

  afterAll(async () => {
    await prisma.groomingApplication.deleteMany({ where: { repoFullName: REPO } });
    await prisma.groomingRun.deleteMany({ where: { repoFullName: REPO } });
    await prisma.issue.deleteMany({ where: { repository: { fullName: REPO } } });
    await prisma.automationRepo.deleteMany({ where: { fullName: REPO } });
    await prisma.repository.deleteMany({ where: { fullName: REPO } });
    await prisma.$disconnect();
  });

  describe("selector backoff", () => {
    it("an unverifiable abort is not re-selected on the next tick; a stale abort still is", async () => {
      // #1 outranks #2 on number. #1's last run was unverifiable (backed off
      // an hour); #2's was a stale abort, which writes nothing to the issue.
      await issue(1, { groomingRetryAfter: new Date(Date.now() + 60 * 60 * 1000) });
      await issue(2);
      expect((await selectGroomingCandidate({ repoFullName: REPO }))!.number).toBe(2);
    });

    it("re-selects a backed-off issue once the backoff has passed", async () => {
      await issue(1, { groomingRetryAfter: new Date(Date.now() - 1000) });
      await issue(2);
      expect((await selectGroomingCandidate({ repoFullName: REPO }))!.number).toBe(1);
    });

    it("holds a backed-off stale issue too, but not a targeted run", async () => {
      await issue(1, {
        labels: ["status/ready", "priority/p1", "agent/a"],
        currentLane: "local",
        groomedIssueFingerprint: "fp",
        groomingStaleAt: new Date(),
        groomingRetryAfter: new Date(Date.now() + 60 * 60 * 1000),
      });
      expect(await selectGroomingCandidate({ repoFullName: REPO })).toBeNull();
      expect((await selectGroomingCandidate({ repoFullName: REPO, issueNumber: 1 }))!.number).toBe(1);
    });
  });

  describe("GroomingApplication claims", () => {
    async function run(issueId: string) {
      const automationRepo = await prisma.automationRepo.upsert({
        where: { fullName: REPO },
        create: { fullName: REPO, name: "apply", owner: "it-groomer" },
        update: {},
      });
      return prisma.groomingRun.create({
        data: {
          issueId,
          repoId: automationRepo.id,
          repoFullName: REPO,
          issueNumber: 1,
          issueUrl: `https://github.com/${REPO}/issues/1`,
          status: "running",
          dryRun: false,
        },
      });
    }

    it("lets exactly one of two concurrent claims own a new key", async () => {
      const target = await issue(1);
      // Only the claims race. Creating both runs concurrently raced the
      // fixture's automationRepo upsert into a P2002 on fullName (#1101).
      const a = await run(target.id);
      const b = await run(target.id);
      const store = makePrismaApplicationStore(prisma);
      const key = "a".repeat(64);
      const input = (groomingRunId: string) => ({ applicationKey: key, issueId: target.id, groomingRunId, repoFullName: REPO, issueNumber: 1 });
      const results = await Promise.all([store.claim(input(a.id)), store.claim(input(b.id))]);
      expect(results.filter((r) => r.existing === null)).toHaveLength(1);
      expect(await prisma.groomingApplication.count({ where: { applicationKey: key } })).toBe(1);
    });

    it("lets exactly one of two resumers take over the same abandoned claim", async () => {
      const target = await issue(1);
      const owner = await run(target.id);
      const store = makePrismaApplicationStore(prisma);
      const key = "b".repeat(64);
      await store.claim({ applicationKey: key, issueId: target.id, groomingRunId: owner.id, repoFullName: REPO, issueNumber: 1 });
      const seen = (await store.find(key)) as ApplicationRecord;
      const results = await Promise.all([store.resume(key, seen), store.resume(key, seen)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await store.find(key))!.attempts).toBe(2);
    });
  });
});
