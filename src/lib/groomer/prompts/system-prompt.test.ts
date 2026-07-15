import { describe, expect, it } from "vitest";
import { buildGroomerSystemPrompt } from "./system-prompt";

describe("buildGroomerSystemPrompt", () => {
  const baseParams = {
    laneIds: "local|cloud|frontier|backlog",
    claimableIds: "local|cloud|frontier",
    backlogLaneId: "backlog",
    laneGuide: '  - "local" (default): Local development work\n  - "cloud" (escalation): Cloud infrastructure',
    defaultLaneId: "local",
    escalationLaneId: "cloud",
    statusLabels: "status/ready, status/in-progress, status/backlog",
    priorityLabels: "priority/p0, priority/p1, priority/p2, priority/p3",
    typeLabels: "type/bug, type/feature, type/chore, type/research, type/security",
  };

  it("interpolates lane ids into the prompt", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain("local|cloud|frontier|backlog");
  });

  it("interpolates claimable lane ids", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain("local|cloud|frontier");
  });

  it("includes backlog lane exclusion when backlogLaneId is set", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain('NEVER "backlog"');
  });

  it("omits backlog lane exclusion when backlogLaneId is empty", () => {
    const prompt = buildGroomerSystemPrompt({ ...baseParams, backlogLaneId: "" });
    expect(prompt).not.toContain('NEVER "backlog"');
  });

  it("includes escalation guidance when escalationLaneId is set", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain('Choose "cloud" ONLY for genuinely hard work');
  });

  it("omits escalation guidance when escalationLaneId is empty", () => {
    const prompt = buildGroomerSystemPrompt({ ...baseParams, escalationLaneId: "" });
    expect(prompt).not.toContain("ONLY for genuinely hard work");
  });

  it("includes the lane guide in the prompt", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain('Claimable lanes:');
    expect(prompt).toContain('"local" (default)');
  });

  it("interpolates status labels", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain("status/ready, status/in-progress, status/backlog");
  });

  it("interpolates priority labels", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain("priority/p0, priority/p1, priority/p2, priority/p3");
  });

  it("interpolates type labels", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain("type/bug, type/feature, type/chore, type/research, type/security");
  });

  it("includes title rewriting rules", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain("Title rewriting rules:");
    expect(prompt).toContain("length < 10 chars");
  });

  it("includes body enrichment rules", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain("Body enrichment rules:");
    expect(prompt).toContain("< 100 characters");
  });

  it("includes comment rules about @mentions", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain("Comment rules:");
    expect(prompt).toContain("NEVER include @username mentions in githubComment");
  });

  it("includes the JSON schema example", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain('"actionability": "ready|needs_info|blocked|backlog|already_done"');
    expect(prompt).toContain('"labelsToAdd": ["status/ready", "priority/p1"]');
  });

  it("includes default lane guidance", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain('Default to "local" for the large majority of ready work');
  });
});
