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
    expect(prompt).toContain('Choose "cloud" when the work requires deciding between alternatives');
    expect(prompt).toContain("Judgement, not size, is the test");
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
    expect(prompt).toContain("does not orient a worker in");
  });

  it("gates enrichment on repo orientation, not on body length", () => {
    // A detailed report from someone who does not know the codebase is long
    // and still needs enrichment. Gating on length skipped exactly those.
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).not.toContain("< 100 characters");
    expect(prompt).toContain("Length is NOT the test");
  });

  it("requires naming real files and forbids guessing paths", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain("name the specific files a worker will need to change");
    expect(prompt).toContain("never guess a path");
  });

  it("keeps the rule against clobbering an existing body", () => {
    const prompt = buildGroomerSystemPrompt(baseParams);
    expect(prompt).toContain("Do NOT clobber existing body content");
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
    expect(prompt).toContain('Most ready work belongs in "local"');
  });

  describe("lane selection", () => {
    it("lets the groomer assign the escalation lane directly", () => {
      const prompt = buildGroomerSystemPrompt(baseParams);
      expect(prompt).toContain("Assign it directly when the issue calls for it");
      expect(prompt).not.toContain("you never need to pre-escalate");
      expect(prompt).not.toContain("the bridge automatically escalates");
    });

    it("keeps size out of the escalation test", () => {
      const prompt = buildGroomerSystemPrompt(baseParams);
      expect(prompt).toContain("do NOT escalate merely because an issue touches many files");
      expect(prompt).toContain("Judgement, not size, is the test");
    });

    it("makes no claim about what model any lane runs", () => {
      const prompt = buildGroomerSystemPrompt(baseParams);
      // Lane capability comes from the operator's lane descriptions, not from
      // assumptions baked into the prompt about local vs hosted models.
      expect(prompt).not.toContain("The local model is a capable coding model");
    });

    it("omits escalation guidance entirely when no escalation lane is configured", () => {
      const prompt = buildGroomerSystemPrompt({ ...baseParams, escalationLaneId: "" });
      expect(prompt).not.toContain("Judgement, not size, is the test");
      expect(prompt).toContain('Most ready work belongs in "local"');
    });
  });
});
