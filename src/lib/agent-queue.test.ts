import { describe, expect, it, afterEach } from "vitest";
import { buildAgentQueue, isRenovateIssue } from "./agent-queue";
import { setLaneConfig, resetLaneConfig } from "./lane-config";

const makeIssue = (overrides: Partial<{ number: number; title: string; url: string; labels: string[]; lane?: string }> = {}) => ({
  number: overrides.number ?? 1,
  title: overrides.title ?? "Test issue",
  url: overrides.url ?? "https://github.com/test/repo/issues/1",
  labels: overrides.labels ?? [],
  lane: overrides.lane,
});

describe("isRenovateIssue", () => {
  it("detects Dependency Dashboard title", () => {
    expect(isRenovateIssue({ title: "Dependency Dashboard", labels: [] })).toBe(true);
  });

  it("detects Update dependency title", () => {
    expect(isRenovateIssue({ title: "Update dependency lodash to v4.18.0", labels: [] })).toBe(true);
  });

  it("detects Update image title", () => {
    expect(isRenovateIssue({ title: "Update image node to v20", labels: [] })).toBe(true);
  });

  it("detects Update deps title", () => {
    expect(isRenovateIssue({ title: "Update deps devDependencies", labels: [] })).toBe(true);
  });

  it("detects renovate label", () => {
    expect(isRenovateIssue({ title: "Bump lodash", labels: ["renovate"] })).toBe(true);
  });

  it("detects dependencies label", () => {
    expect(isRenovateIssue({ title: "Bump lodash", labels: ["dependencies"] })).toBe(true);
  });

  it("detects automated label", () => {
    expect(isRenovateIssue({ title: "Bump lodash", labels: ["automated"] })).toBe(true);
  });

  it("returns false for normal issues", () => {
    expect(isRenovateIssue({ title: "Fix login bug", labels: ["bug", "priority/p1"] })).toBe(false);
  });

  it("is case-insensitive for labels", () => {
    expect(isRenovateIssue({ title: "Bump lodash", labels: ["RENOVATE"] })).toBe(true);
    expect(isRenovateIssue({ title: "Bump lodash", labels: ["Dependencies"] })).toBe(true);
  });

  it("is case-insensitive for title patterns", () => {
    expect(isRenovateIssue({ title: "dependency dashboard", labels: [] })).toBe(true);
    expect(isRenovateIssue({ title: "DEPENDENCY DASHBOARD", labels: [] })).toBe(true);
    expect(isRenovateIssue({ title: "update dependency foo", labels: [] })).toBe(true);
  });
});

describe("buildAgentQueue", () => {
  it("returns empty for no issues", () => {
    const result = buildAgentQueue([], "worker-agent");
    expect(result).toEqual([]);
  });

  it("excludes closed (status/done) issues", () => {
    const issues = [makeIssue({ labels: ["status/done", "priority/p1"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(0);
  });

  it("excludes done issues even with agent label", () => {
    const issues = [makeIssue({ labels: ["agent/worker-agent", "status/done"] })];
    const result = buildAgentQueue(issues, "worker-agent", { includeClaimed: true });
    expect(result).toHaveLength(0);
  });

  it("excludes same-agent claimed backlog issues by default", () => {
    const issues = [makeIssue({ labels: ["agent/worker-agent", "status/backlog", "priority/p1"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(0);
  });

  it("includes same-agent claimed backlog issues when includeClaimed and claimableOnly are true", () => {
    const issues = [makeIssue({ labels: ["agent/worker-agent", "status/backlog", "priority/p1"] })];
    const result = buildAgentQueue(issues, "worker-agent", { includeClaimed: true, claimableOnly: false });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].agentMatch).toBe(true);
  });

  it("excludes other-agent claimed issues by default", () => {
    const issues = [makeIssue({ labels: ["agent/beta", "status/backlog", "priority/p1"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(0);
  });

  it("excludes no-status issues from default worker queue", () => {
    const issues = [makeIssue({ labels: ["priority/p2"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(0);
  });

  it("excludes unlabelled no-status issues from normal worker queue by default", () => {
    const issues = [makeIssue({ number: 1, labels: [] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(0);
  });

  it("includes no-status issues when claimableOnly=false", () => {
    const issues = [makeIssue({ labels: ["priority/p2"] })];
    const result = buildAgentQueue(issues, "worker-agent", { claimableOnly: false });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBeNull();
  });

  it("includes no-status issues when claimableOnly=false", () => {
    const issues = [makeIssue({ labels: ["priority/p2"] })];
    const result = buildAgentQueue(issues, "worker-agent", { claimableOnly: false });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBeNull();
  });

  it("includes in-progress issues", () => {
    const issues = [makeIssue({ labels: ["status/in-progress", "priority/p0"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("status/in-progress");
  });

  it("prioritizes agent-specific issues over others at same priority", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "agent/worker-agent"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { includeClaimed: true });
    expect(result[0].number).toBe(2); // agent-specific first
    expect(result[1].number).toBe(1);
  });

  it("prioritizes in-progress over ready at same priority", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/ready"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/in-progress"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result[0].number).toBe(2); // in-progress first
    expect(result[1].number).toBe(1);
  });

  it("sorts by priority: p0 before p1 before p2 before p3", () => {
    const issues = [
      makeIssue({ number: 4, labels: ["priority/p3", "status/ready"] }),
      makeIssue({ number: 1, labels: ["priority/p0", "status/ready"] }),
      makeIssue({ number: 3, labels: ["priority/p2", "status/ready"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result.map((i) => i.number)).toEqual([1, 2, 3, 4]);
  });

  it("includes ranking reason metadata", () => {
    const issues = [makeIssue({ labels: ["agent/worker-agent", "priority/p1", "status/ready"] })];
    const result = buildAgentQueue(issues, "worker-agent", { includeClaimed: true });
    expect(result[0].rankingReason).toContain("p1");
    expect(result[0].rankingReason).toContain("agent/worker-agent");
  });

  it("does not hardcode agent names in logic", () => {
    const issues = [makeIssue({ labels: ["agent/beta", "priority/p1"] })];
    const resultBeta = buildAgentQueue(issues, "beta", { includeClaimed: true });
    const resultWorker = buildAgentQueue(issues, "worker-agent", { includeClaimed: true });

    expect(resultBeta[0].agentMatch).toBe(true);
    expect(resultWorker[0].agentMatch).toBe(false);
  });

  it("works across multiple repos (no hardcoded repo names)", () => {
    const issues = [
      makeIssue({ number: 1, url: "https://github.com/misospace/dispatch/issues/1", labels: ["priority/p1", "status/ready"] }),
      makeIssue({ number: 2, url: "https://github.com/misospace/miso-chat/issues/42", labels: ["priority/p1", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(2);
  });

  it("returns correct type shape with all fields", () => {
    const issues = [makeIssue({ number: 42, title: "Fix bug", url: "https://gh.io/42", labels: ["priority/p0", "agent/worker-agent"] })];
    const result = buildAgentQueue(issues, "worker-agent", { includeClaimed: true });
    expect(result).toHaveLength(1);
    const issue = result[0];
    expect(issue).toHaveProperty("number", 42);
    expect(issue).toHaveProperty("title", "Fix bug");
    expect(issue).toHaveProperty("url", "https://gh.io/42");
    expect(issue).toHaveProperty("labels");
    expect(issue).toHaveProperty("priority", "priority/p0");
    expect(issue).toHaveProperty("status", null);
    expect(issue).toHaveProperty("agentMatch", true);
    expect(issue).toHaveProperty("rankingReason");
  });

  // ── Renovate exclusion tests ──────────────────────────────────────

  it("excludes Renovate issues from agent queue by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Dependency Dashboard", labels: ["priority/p1", "status/ready"] }),
      makeIssue({ number: 2, title: "Fix login bug", labels: ["priority/p1", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("excludes Renovate issues with 'Update dependency' title by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Update dependency lodash to v4.18.0", labels: ["status/ready"] }),
      makeIssue({ number: 2, title: "Add dark mode", labels: ["enhancement", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("excludes Renovate issues with 'renovate' label by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Bump lodash", labels: ["renovate", "status/ready"] }),
      makeIssue({ number: 2, title: "Fix crash on startup", labels: ["bug", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("includes Renovate issues when includeRenovate=true", () => {
    const issues = [
      makeIssue({ number: 1, title: "Dependency Dashboard", labels: ["priority/p1", "status/ready"] }),
      makeIssue({ number: 2, title: "Fix login bug", labels: ["priority/p1", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { includeRenovate: true });
    expect(result).toHaveLength(2);
  });

  it("does not exclude non-Renovate issues", () => {
    const issues = [
      makeIssue({ number: 1, title: "Update README", labels: ["documentation", "status/ready"] }),
      makeIssue({ number: 2, title: "Fix null pointer", labels: ["bug", "priority/p0", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(2);
  });

  it("excludes Renovate issues with 'Update image' title by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Update image node to v20", labels: ["status/ready"] }),
      makeIssue({ number: 2, title: "Implement search", labels: ["enhancement", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("excludes Renovate issues with 'dependencies' label by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Bump all deps", labels: ["dependencies", "status/ready"] }),
      makeIssue({ number: 2, title: "Fix API timeout", labels: ["bug", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("excludes Renovate issues with 'automated' label by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Bump eslint", labels: ["automated", "status/ready"] }),
      makeIssue({ number: 2, title: "Add unit tests", labels: ["testing", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("respects lane filter when excluding Renovate issues", () => {
    const issues = [
      makeIssue({ number: 1, title: "Dependency Dashboard", labels: ["priority/p1", "status/ready"], lane: "local" }),
      makeIssue({ number: 2, title: "Fix crash", labels: ["priority/p0", "status/ready"], lane: "local" }),
      makeIssue({ number: 3, title: "Escalated issue", labels: ["priority/p0", "status/ready"], lane: "frontier" }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { lane: "local" });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("excludes Renovate issues even when agent-specific", () => {
    const issues = [
      makeIssue({ number: 1, title: "Dependency Dashboard", labels: ["agent/worker-agent", "priority/p1"] }),
      makeIssue({ number: 2, title: "Fix critical bug", labels: ["agent/worker-agent", "priority/p0"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { includeClaimed: true });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("includes Renovate issues when agent-specific and includeRenovate=true", () => {
    const issues = [
      makeIssue({ number: 1, title: "Dependency Dashboard", labels: ["agent/worker-agent", "priority/p1"] }),
      makeIssue({ number: 2, title: "Fix critical bug", labels: ["agent/worker-agent", "priority/p0"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { includeClaimed: true, includeRenovate: true });
    expect(result).toHaveLength(2);
  });

  it("excludes Renovate issues across multiple repos", () => {
    const issues = [
      makeIssue({ number: 1, url: "https://github.com/misospace/dispatch/issues/1", title: "Dependency Dashboard", labels: ["priority/p1", "status/ready"] }),
      makeIssue({ number: 2, url: "https://github.com/misospace/miso-chat/issues/42", title: "Fix bug", labels: ["bug", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });
});

describe("buildAgentQueue with status/ready", () => {
  it("includes ready issues as actionable", () => {
    const issues = [makeIssue({ labels: ["status/ready", "priority/p1"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("status/ready");
  });

  it("prioritizes in-progress over ready at same priority", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/ready"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/in-progress"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result[0].number).toBe(2); // in-progress first
    expect(result[1].number).toBe(1); // ready second
  });

  it("prioritizes in-progress over ready", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/ready"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/in-progress"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result[0].number).toBe(2); // in-progress first
    expect(result[1].number).toBe(1); // ready second
  });

  it("includes ready issues across multiple priorities", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p0", "status/ready"] }),
      makeIssue({ number: 2, labels: ["priority/p2", "status/ready"] }),
      makeIssue({ number: 3, labels: ["priority/p1", "status/in-progress"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result.map((i) => i.number)).toEqual([1, 3, 2]); // p0 ready > p1 in-progress > p2 ready
  });

  it("excludes ready issues only when explicitly filtered by lane=backlog", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/ready"], lane: "local" }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/backlog"], lane: "backlog" }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { lane: "backlog", claimableOnly: false });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2); // only backlog lane item
  });
});

describe("buildAgentQueue with claimable-only behavior", () => {
  it("excludes status/backlog from default queue (claimableOnly=true by default)", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/ready"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/backlog"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].claimable).toBe(true);
  });

  it("includes status/backlog when claimableOnly=false", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/ready"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/backlog"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { claimableOnly: false });
    expect(result).toHaveLength(2);
    expect(result.find((i) => i.number === 1)?.claimable).toBe(true);
    expect(result.find((i) => i.number === 2)?.claimable).toBe(false);
  });

  it("marks ready issues as claimable", () => {
    const issues = [makeIssue({ labels: ["priority/p1", "status/ready"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result[0].claimable).toBe(true);
  });

  it("marks in-progress issues as claimable", () => {
    const issues = [makeIssue({ labels: ["priority/p1", "status/in-progress"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result[0].claimable).toBe(true);
  });

  it("marks no-status issues as claimable when included", () => {
    const issues = [makeIssue({ labels: ["priority/p1"] })];
    const result = buildAgentQueue(issues, "worker-agent", { claimableOnly: false });
    expect(result[0].claimable).toBe(true);
  });

  it("excludes status/backlog from default queue across priorities", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p0", "status/backlog"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/ready"] }),
      makeIssue({ number: 3, labels: ["priority/p2", "status/in-progress"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.number)).toEqual([2, 3]);
    expect(result.every((i) => i.claimable)).toBe(true);
  });

  it("includes claimed backlog when claimableOnly=false and includeClaimed=true", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["agent/worker-agent", "priority/p1", "status/backlog"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { includeClaimed: true, claimableOnly: false });
    expect(result).toHaveLength(2);
    expect(result.find((i) => i.number === 1)?.claimable).toBe(false);
    expect(result.find((i) => i.number === 2)?.claimable).toBe(true);
  });

  it("excludes backlog from default queue even with lane filter (no lane specified)", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/ready"], lane: "local" }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/backlog"], lane: "local" }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("backlog lane returns nothing when claimableOnly=true (no claimable backlog items exist)", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/backlog"], lane: "backlog" }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/ready"], lane: "local" }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { lane: "backlog" });
    expect(result).toHaveLength(0);
  });

  it("backlog lane returns items when claimableOnly=false", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/backlog"], lane: "backlog" }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/ready"], lane: "local" }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { lane: "backlog", claimableOnly: false });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].claimable).toBe(false);
  });

  it("excludes status/backlog and no-status issues from default queue", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/backlog"] }),
      makeIssue({ number: 3, labels: ["priority/p1", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(3); // only ready included
  });

  it("works with includeRenovate and claimableOnly together", () => {
    const issues = [
      makeIssue({ number: 1, title: "Dependency Dashboard", labels: ["priority/p1"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/backlog"] }),
      makeIssue({ number: 3, labels: ["priority/p1", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { includeRenovate: true, claimableOnly: false });
    expect(result).toHaveLength(3);
    expect(result.find((i) => i.number === 3)?.claimable).toBe(true);
    expect(result.find((i) => i.number === 2)?.claimable).toBe(false);
    // no-status issue included with claimableOnly=false but marked non-claimable
    expect(result.find((i) => i.number === 1)?.claimable).toBe(true);
  });

  it("excludes status/backlog from default queue with lane=local", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/backlog"], lane: "local" }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/ready"], lane: "local" }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { lane: "local" });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("respects claimableOnly=false with lane=frontier", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p0", "status/backlog"], lane: "frontier" }),
      makeIssue({ number: 2, labels: ["priority/p0", "status/ready"], lane: "frontier" }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { lane: "frontier", claimableOnly: false });
    expect(result).toHaveLength(2);
    expect(result.find((i) => i.number === 1)?.claimable).toBe(false);
    expect(result.find((i) => i.number === 2)?.claimable).toBe(true);
  });
});

describe("buildAgentQueue agent assignment fixes (issue #291)", () => {
  it("includes same-agent + status/in-progress by default", () => {
    const issues = [makeIssue({ labels: ["agent/worker-agent", "status/in-progress", "priority/p0"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].agentMatch).toBe(true);
  });

  it("excludes same-agent + status/in-review from default worker queue", () => {
    const issues = [makeIssue({ labels: ["agent/worker-agent", "status/in-review", "priority/p0"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(0);
  });

  it("includes same-agent + status/ready by default", () => {
    const issues = [makeIssue({ labels: ["agent/worker-agent", "status/ready", "priority/p0"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].agentMatch).toBe(true);
  });

  it("excludes issues labelled for a different agent by default", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["agent/other-agent", "status/ready", "priority/p0"] }),
      makeIssue({ number: 2, labels: ["agent/worker-agent", "status/ready", "priority/p0"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2); // only worker-agent's own work is included
  });

  it("excludes no-status/unlabelled issues from normal worker queue by default", () => {
    const issues = [
      makeIssue({ number: 1, labels: [] }),
      makeIssue({ number: 2, labels: ["agent/worker-agent", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2); // only ready included
  });

  it("excludes Renovate Dashboard title by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Renovate Dashboard 🤖", labels: [] }),
      makeIssue({ number: 2, title: "Fix critical bug", labels: ["priority/p0", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("includes Renovate Dashboard when includeRenovate=true", () => {
    const issues = [
      makeIssue({ number: 1, title: "Renovate Dashboard 🤖", labels: ["priority/p1", "status/ready"] }),
      makeIssue({ number: 2, title: "Fix critical bug", labels: ["priority/p0", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { includeRenovate: true });
    expect(result).toHaveLength(2);
  });

  it("ranks in-progress before ready; excludes in-review from default queue", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["agent/worker-agent", "status/ready"] }),
      makeIssue({ number: 2, labels: ["agent/worker-agent", "status/in-review"] }),
      makeIssue({ number: 3, labels: ["agent/worker-agent", "status/in-progress"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result.map((i) => i.number)).toEqual([3, 1]); // in-review excluded
  });

  it("prioritizes same-agent over other-agent at same status", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["agent/other-agent", "status/ready", "priority/p0"] }),
      makeIssue({ number: 2, labels: ["agent/worker-agent", "status/ready", "priority/p0"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { includeClaimed: true });
    expect(result[0].number).toBe(2); // worker-agent's work comes first
    expect(result[1].number).toBe(1); // other-agent's work is included but ranked lower
  });

  it("excludes same-agent in-review issues from default queue", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["agent/worker-agent", "status/in-review", "priority/p0"] }),
      makeIssue({ number: 2, labels: ["agent/worker-agent", "status/ready", "priority/p1"] }),
      makeIssue({ number: 3, labels: ["agent/other-agent", "status/in-progress", "priority/p0"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result.map((i) => i.number)).toEqual([2]); // in-review excluded, other-agent excluded
  });

  it("excludes same-agent no-status issues from default worker queue", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["agent/worker-agent"] }),
      makeIssue({ number: 2, labels: ["agent/worker-agent", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2); // only ready included, no-status excluded
  });

  it("includes no-status same-agent issue when claimableOnly=false", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["agent/worker-agent"] }),
      makeIssue({ number: 2, labels: ["agent/worker-agent", "status/ready"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { claimableOnly: false });
    expect(result).toHaveLength(2);
    expect(result[0].number).toBe(2); // ready first
    expect(result[1].number).toBe(1); // no-status second
  });
});

describe("buildAgentQueue excludes non-worker-actionable issues (issue #369)", () => {
  describe("configurable lanes", () => {
    afterEach(() => {
      resetLaneConfig();
    });

    it("single claimable lane config works", () => {
      setLaneConfig({
        lanes: [
          { id: "default", title: "Default", claimable: true },
          { id: "backlog", title: "Backlog", claimable: false },
        ],
      });

      const issues = [
        makeIssue({ number: 1, labels: ["priority/p1", "status/ready"], lane: "default" }),
        makeIssue({ number: 2, labels: ["priority/p1", "status/ready"], lane: "backlog" }),
      ];

      // Default queue includes only claimable lane (default), excludes backlog lane
      const result = buildAgentQueue(issues, "worker-agent");
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(1);

      // Explicit lane filter works
      const defaultOnly = buildAgentQueue(issues, "worker-agent", { lane: "default" });
      expect(defaultOnly).toHaveLength(1);
      expect(defaultOnly[0].number).toBe(1);
    });

    it("three claimable lanes config works", () => {
      setLaneConfig({
        lanes: [
          { id: "fast", title: "Fast Lane", claimable: true },
          { id: "slow", title: "Slow Lane", claimable: true },
          { id: "critical", title: "Critical", claimable: true },
          { id: "parked", title: "Parked", claimable: false },
        ],
      });

      const issues = [
        makeIssue({ number: 1, labels: ["priority/p0", "status/ready"], lane: "fast" }),
        makeIssue({ number: 2, labels: ["priority/p1", "status/ready"], lane: "slow" }),
        makeIssue({ number: 3, labels: ["priority/p0", "status/ready"], lane: "critical" }),
        makeIssue({ number: 4, labels: ["priority/p1", "status/ready"], lane: "parked" }),
      ];

      // Default queue includes all claimable lanes, excludes parked
      const result = buildAgentQueue(issues, "worker-agent");
      expect(result).toHaveLength(3);
      expect(result.map((i) => i.number)).toEqual([1, 3, 2]); // p0 fast, p0 critical, p1 slow

      // Each lane filter works independently
      const fastOnly = buildAgentQueue(issues, "worker-agent", { lane: "fast" });
      expect(fastOnly).toHaveLength(1);
      expect(fastOnly[0].number).toBe(1);

      const criticalOnly = buildAgentQueue(issues, "worker-agent", { lane: "critical" });
      expect(criticalOnly).toHaveLength(1);
      expect(criticalOnly[0].number).toBe(3);
    });

    it("non-claimable lane is excluded from default worker queue", () => {
      setLaneConfig({
        lanes: [
          { id: "work", title: "Work", claimable: true },
          { id: "triage", title: "Triage", claimable: false },
        ],
      });

      const issues = [
        makeIssue({ number: 1, labels: ["priority/p1", "status/ready"], lane: "work" }),
        makeIssue({ number: 2, labels: ["priority/p1", "status/ready"], lane: "triage" }),
      ];

      const result = buildAgentQueue(issues, "worker-agent");
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(1);

      // Non-claimable lane can be included with claimableOnly=false
      const all = buildAgentQueue(issues, "worker-agent", { claimableOnly: false });
      expect(all).toHaveLength(2);
    });

    it("non-claimable lane items not accidentally worker-claimable", () => {
      setLaneConfig({
        lanes: [
          { id: "work", title: "Work", claimable: true },
          { id: "backlog", title: "Backlog", claimable: false },
        ],
      });

      const issues = [
        makeIssue({ number: 1, labels: ["priority/p0", "status/ready"], lane: "backlog" }),
      ];

      const result = buildAgentQueue(issues, "worker-agent");
      expect(result).toHaveLength(0);
    });

    it("custom claimable lane can be queried successfully", () => {
      setLaneConfig({
        lanes: [
          { id: "alpha", title: "Alpha", claimable: true },
          { id: "backlog", title: "Backlog", claimable: false },
        ],
      });

      const issues = [
        makeIssue({ number: 1, labels: ["priority/p1", "status/ready"], lane: "alpha" }),
      ];

      const result = buildAgentQueue(issues, "worker-agent", { lane: "alpha" });
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(1);
    });
  });

  it("excludes status/in-review from default worker queue", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["status/in-review", "priority/p0"] }),
      makeIssue({ number: 2, labels: ["status/ready", "priority/p1"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2); // only ready included
  });

  it("excludes no-status issues with labels from default worker queue", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p0", "bug"] }),
      makeIssue({ number: 2, labels: ["status/ready", "priority/p1"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2); // only ready included
  });

  it("excludes no-status same-agent issues from default worker queue", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["agent/worker-agent", "priority/p0"] }),
      makeIssue({ number: 2, labels: ["status/ready", "priority/p1"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2); // only ready included, no-status excluded even with agent label
  });

  it("includes status/in-review when claimableOnly=false", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["status/in-review", "priority/p0"] }),
      makeIssue({ number: 2, labels: ["status/ready", "priority/p1"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { claimableOnly: false });
    expect(result).toHaveLength(2);
    expect(result[0].number).toBe(1); // in-review included with claimableOnly=false
  });

  it("includes no-status issues when claimableOnly=false", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p0"] }),
      makeIssue({ number: 2, labels: ["status/ready", "priority/p1"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { claimableOnly: false });
    expect(result).toHaveLength(2);
  });

  it("includes status/ready issues in default worker queue", () => {
    const issues = [makeIssue({ labels: ["status/ready", "priority/p1"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("status/ready");
  });

  it("includes status/in-progress issues in default worker queue", () => {
    const issues = [makeIssue({ labels: ["status/in-progress", "priority/p0"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("status/in-progress");
  });

  it("excludes all non-actionable statuses from default queue: no-status, backlog, in-review, done", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p0"] }), // no-status
      makeIssue({ number: 2, labels: ["status/backlog", "priority/p0"] }),
      makeIssue({ number: 3, labels: ["status/in-review", "priority/p0"] }),
      makeIssue({ number: 4, labels: ["status/done", "priority/p0"] }),
      makeIssue({ number: 5, labels: ["status/ready", "priority/p1"] }),
      makeIssue({ number: 6, labels: ["status/in-progress", "priority/p2"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.number)).toEqual([5, 6]); // only ready and in-progress
  });

  it("returns only status/ready when no other actionable issues exist", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p0"] }), // no-status
      makeIssue({ number: 2, labels: ["status/in-review", "priority/p0"] }),
      makeIssue({ number: 3, labels: ["status/ready", "priority/p2"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(3);
  });

  it("returns empty queue when only non-actionable issues exist", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p0"] }), // no-status
      makeIssue({ number: 2, labels: ["status/in-review", "priority/p0"] }),
      makeIssue({ number: 3, labels: ["status/backlog", "priority/p0"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(0);
  });

  describe("custom lanes", () => {
    afterEach(() => {
      resetLaneConfig();
    });

    it("accepts custom configured lanes and filters by them", () => {
      setLaneConfig({
        lanes: [
          { id: "fast", title: "Fast Lane", claimable: true },
          { id: "slow", title: "Slow Lane", claimable: true },
          { id: "parked", title: "Parked", claimable: false },
        ],
      });

      const issues = [
        makeIssue({ number: 1, labels: ["priority/p1", "status/ready"], lane: "fast" }),
        makeIssue({ number: 2, labels: ["priority/p1", "status/ready"], lane: "slow" }),
        // Note: parked issue uses status/ready (not status/backlog) to test lane filtering
        // separately from status-based filtering
        makeIssue({ number: 3, labels: ["priority/p1", "status/ready"], lane: "parked" }),
      ];

      // Filter by custom lane
      const fastOnly = buildAgentQueue(issues, "worker-agent", { lane: "fast" });
      expect(fastOnly).toHaveLength(1);
      expect(fastOnly[0].number).toBe(1);

      // Default (no lane filter) excludes parked (non-claimable) lane
      const allClaimable = buildAgentQueue(issues, "worker-agent");
      expect(allClaimable).toHaveLength(2);
      expect(allClaimable.map((i) => i.number)).toEqual([1, 2]);

      // Include parked with claimableOnly=false
      const allIncludingParked = buildAgentQueue(issues, "worker-agent", { claimableOnly: false });
      expect(allIncludingParked).toHaveLength(3);
    });
  });

  describe("lane aliases", () => {
    afterEach(() => {
      resetLaneConfig();
    });

    it("queue includes aliased issues under the resolved configured lane", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true, role: "default" },
          { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: {
          normal: "local",
          escalated: "frontier",
          backlog: "parking-lot",
        },
      });

      const issues = [
        makeIssue({ number: 1, labels: ["priority/p1", "status/ready"], lane: "local" }),
        makeIssue({ number: 2, labels: ["priority/p0", "status/ready"], lane: "local" }),
        makeIssue({ number: 3, labels: ["priority/p1", "status/ready"], lane: "parking-lot" }),
      ];

      // Filter by resolved lane "local" should include both "normal" (aliased) and "local" issues
      const result = buildAgentQueue(issues, "worker-agent", { lane: "local" });
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.number)).toEqual([2, 1]); // p0 local, then p1 normal(alias)
    });

    it("board/list includes unknown-lane issues when no lane filter is used", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { normal: "local" },
      });

      const issues = [
        makeIssue({ number: 1, labels: ["priority/p1", "status/ready"], lane: "local" }),
        makeIssue({ number: 2, labels: ["priority/p1", "status/ready"], lane: "unknown-lane" }),
      ];

      // Default queue (no lane filter) should include unknown-lane issues
      const result = buildAgentQueue(issues, "worker-agent");
      expect(result).toHaveLength(2);
    });

    it("aliased backlog lane is excluded from default claimable queue", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { backlog: "parking-lot" },
      });

      const issues = [
        makeIssue({ number: 1, labels: ["priority/p1", "status/ready"], lane: "local" }),
        makeIssue({ number: 2, labels: ["priority/p1", "status/backlog"], lane: "backlog" }),
      ];

      // Issue with lane "backlog" should resolve to "parking-lot" (non-claimable) and be excluded
      const result = buildAgentQueue(issues, "worker-agent");
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(1);
    });

    it("unknown-lane issues are not excluded from default queue", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { normal: "local" },
      });

      const issues = [
        makeIssue({ number: 1, labels: ["priority/p1", "status/ready"], lane: "local" }),
        makeIssue({ number: 2, labels: ["priority/p1", "status/ready"], lane: "some-old-lane" }),
      ];

      // Unknown lane should not be excluded (preserve visibility)
      const result = buildAgentQueue(issues, "worker-agent");
      expect(result).toHaveLength(2);
    });

    it("configured lane query includes raw stored lane IDs that alias to the configured lane", () => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true },
          { id: "parking-lot", title: "Parking Lot", claimable: false },
        ],
        laneAliases: { normal: "local", escalated: "local" },
      });

      const issues = [
        makeIssue({ number: 1, labels: ["priority/p1", "status/ready"], lane: "local" }),
        makeIssue({ number: 2, labels: ["priority/p0", "status/ready"], lane: "frontier" }),
        makeIssue({ number: 3, labels: ["priority/p2", "status/ready"], lane: "local" }),
      ];

      // Filter by "local" should include all three (normal, escalated, and local)
      const result = buildAgentQueue(issues, "worker-agent", { lane: "local" });
      expect(result).toHaveLength(3);
      expect(result.map((i) => i.number)).toEqual([2, 1, 3]); // p0 escalated, p1 normal, p2 local
    });
  });
});
