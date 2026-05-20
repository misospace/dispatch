import { describe, expect, it } from "vitest";
import { buildAgentQueue, isRenovateIssue } from "./agent-queue";

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

  it("includes same-agent claimed backlog issues when includeClaimed is true", () => {
    const issues = [makeIssue({ labels: ["agent/worker-agent", "status/backlog", "priority/p1"] })];
    const result = buildAgentQueue(issues, "worker-agent", { includeClaimed: true });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].agentMatch).toBe(true);
  });

  it("excludes other-agent claimed issues by default", () => {
    const issues = [makeIssue({ labels: ["agent/beta", "status/backlog", "priority/p1"] })];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(0);
  });

  it("includes issues with no status label", () => {
    const issues = [makeIssue({ labels: ["priority/p2"] })];
    const result = buildAgentQueue(issues, "worker-agent");
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

  it("prioritizes in-progress over backlog at same priority", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/backlog"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/in-progress"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result[0].number).toBe(2); // in-progress first
    expect(result[1].number).toBe(1);
  });

  it("sorts by priority: p0 before p1 before p2 before p3", () => {
    const issues = [
      makeIssue({ number: 4, labels: ["priority/p3"] }),
      makeIssue({ number: 1, labels: ["priority/p0"] }),
      makeIssue({ number: 3, labels: ["priority/p2"] }),
      makeIssue({ number: 2, labels: ["priority/p1"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result.map((i) => i.number)).toEqual([1, 2, 3, 4]);
  });

  it("includes ranking reason metadata", () => {
    const issues = [makeIssue({ labels: ["agent/worker-agent", "priority/p1", "status/backlog"] })];
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
      makeIssue({ number: 1, url: "https://github.com/misospace/dispatch/issues/1", labels: ["priority/p1"] }),
      makeIssue({ number: 2, url: "https://github.com/misospace/miso-chat/issues/42", labels: ["priority/p1"] }),
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
      makeIssue({ number: 1, title: "Dependency Dashboard", labels: ["priority/p1"] }),
      makeIssue({ number: 2, title: "Fix login bug", labels: ["priority/p1"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("excludes Renovate issues with 'Update dependency' title by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Update dependency lodash to v4.18.0", labels: [] }),
      makeIssue({ number: 2, title: "Add dark mode", labels: ["enhancement"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("excludes Renovate issues with 'renovate' label by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Bump lodash", labels: ["renovate"] }),
      makeIssue({ number: 2, title: "Fix crash on startup", labels: ["bug"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("includes Renovate issues when includeRenovate=true", () => {
    const issues = [
      makeIssue({ number: 1, title: "Dependency Dashboard", labels: ["priority/p1"] }),
      makeIssue({ number: 2, title: "Fix login bug", labels: ["priority/p1"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { includeRenovate: true });
    expect(result).toHaveLength(2);
  });

  it("does not exclude non-Renovate issues", () => {
    const issues = [
      makeIssue({ number: 1, title: "Update README", labels: ["documentation"] }),
      makeIssue({ number: 2, title: "Fix null pointer", labels: ["bug", "priority/p0"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(2);
  });

  it("excludes Renovate issues with 'Update image' title by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Update image node to v20", labels: [] }),
      makeIssue({ number: 2, title: "Implement search", labels: ["enhancement"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("excludes Renovate issues with 'dependencies' label by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Bump all deps", labels: ["dependencies"] }),
      makeIssue({ number: 2, title: "Fix API timeout", labels: ["bug"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("excludes Renovate issues with 'automated' label by default", () => {
    const issues = [
      makeIssue({ number: 1, title: "Bump eslint", labels: ["automated"] }),
      makeIssue({ number: 2, title: "Add unit tests", labels: ["testing"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("respects lane filter when excluding Renovate issues", () => {
    const issues = [
      makeIssue({ number: 1, title: "Dependency Dashboard", labels: ["priority/p1"], lane: "normal" }),
      makeIssue({ number: 2, title: "Fix crash", labels: ["priority/p0"], lane: "normal" }),
      makeIssue({ number: 3, title: "Escalated issue", labels: ["priority/p0"], lane: "escalated" }),
    ];
    const result = buildAgentQueue(issues, "worker-agent", { lane: "normal" });
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
      makeIssue({ number: 1, url: "https://github.com/misospace/dispatch/issues/1", title: "Dependency Dashboard", labels: ["priority/p1"] }),
      makeIssue({ number: 2, url: "https://github.com/misospace/miso-chat/issues/42", title: "Fix bug", labels: ["bug"] }),
    ];
    const result = buildAgentQueue(issues, "worker-agent");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });
});
