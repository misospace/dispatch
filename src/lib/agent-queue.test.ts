import { describe, expect, it } from "vitest";
import { buildAgentQueue } from "./agent-queue";

const makeIssue = (overrides: Partial<{ number: number; title: string; url: string; labels: string[] }> = {}) => ({
  number: overrides.number ?? 1,
  title: overrides.title ?? "Test issue",
  url: overrides.url ?? "https://github.com/test/repo/issues/1",
  labels: overrides.labels ?? [],
});

describe("buildAgentQueue", () => {
  it("returns empty for no issues", () => {
    const result = buildAgentQueue([], "saffron");
    expect(result).toEqual([]);
  });

  it("excludes closed (status/done) issues", () => {
    const issues = [makeIssue({ labels: ["status/done", "priority/p1"] })];
    const result = buildAgentQueue(issues, "saffron");
    expect(result).toHaveLength(0);
  });

  it("excludes done issues even with agent label", () => {
    const issues = [makeIssue({ labels: ["agent/saffron", "status/done"] })];
    const result = buildAgentQueue(issues, "saffron");
    expect(result).toHaveLength(0);
  });

  it("includes backlog issues for the agent", () => {
    const issues = [makeIssue({ labels: ["agent/saffron", "status/backlog", "priority/p1"] })];
    const result = buildAgentQueue(issues, "saffron");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].agentMatch).toBe(true);
  });

  it("includes issues with no status label", () => {
    const issues = [makeIssue({ labels: ["priority/p2"] })];
    const result = buildAgentQueue(issues, "saffron");
    expect(result).toHaveLength(1);
    expect(result[0].status).toBeNull();
  });

  it("includes in-progress issues", () => {
    const issues = [makeIssue({ labels: ["status/in-progress", "priority/p0"] })];
    const result = buildAgentQueue(issues, "saffron");
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("status/in-progress");
  });

  it("prioritizes agent-specific issues over others at same priority", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "agent/saffron"] }),
    ];
    const result = buildAgentQueue(issues, "saffron");
    expect(result[0].number).toBe(2); // agent-specific first
    expect(result[1].number).toBe(1);
  });

  it("prioritizes in-progress over backlog at same priority", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1", "status/backlog"] }),
      makeIssue({ number: 2, labels: ["priority/p1", "status/in-progress"] }),
    ];
    const result = buildAgentQueue(issues, "saffron");
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
    const result = buildAgentQueue(issues, "saffron");
    expect(result.map((i) => i.number)).toEqual([1, 2, 3, 4]);
  });

  it("includes ranking reason metadata", () => {
    const issues = [makeIssue({ labels: ["agent/saffron", "priority/p1", "status/backlog"] })];
    const result = buildAgentQueue(issues, "saffron");
    expect(result[0].rankingReason).toContain("p1");
    expect(result[0].rankingReason).toContain("agent/saffron");
  });

  it("does not hardcode agent names in logic", () => {
    const issues = [makeIssue({ labels: ["agent/beta", "priority/p1"] })];
    const resultBeta = buildAgentQueue(issues, "beta");
    const resultSaffron = buildAgentQueue(issues, "saffron");

    expect(resultBeta[0].agentMatch).toBe(true);
    expect(resultSaffron[0].agentMatch).toBe(false);
  });

  it("works across multiple repos (no hardcoded repo names)", () => {
    const issues = [
      makeIssue({ number: 1, url: "https://github.com/misospace/mission-control/issues/1", labels: ["priority/p1"] }),
      makeIssue({ number: 2, url: "https://github.com/misospace/miso-chat/issues/42", labels: ["priority/p1"] }),
    ];
    const result = buildAgentQueue(issues, "saffron");
    expect(result).toHaveLength(2);
  });

  it("returns correct type shape with all fields", () => {
    const issues = [makeIssue({ number: 42, title: "Fix bug", url: "https://gh.io/42", labels: ["priority/p0", "agent/saffron"] })];
    const result = buildAgentQueue(issues, "saffron");
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
});
