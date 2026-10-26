import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveSyncPipelineState,
  syncPipelineDeclarationFromEnv,
  type SyncPipelineDeclaration,
  type SyncPipelineState,
} from "@/lib/sync-pipeline";

const FACTS = {
  schedulerEnabled: false,
  syncIntervalMs: 900_000,
};

describe("syncPipelineDeclarationFromEnv", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("defaults to auto when unset", () => {
    expect(syncPipelineDeclarationFromEnv({})).toBe("auto");
    expect(syncPipelineDeclarationFromEnv({ DISPATCH_SYNC_PIPELINE: "  " })).toBe("auto");
  });

  it("trims and lowercases the recognised values", () => {
    expect(syncPipelineDeclarationFromEnv({ DISPATCH_SYNC_PIPELINE: "external" })).toBe("external");
    expect(syncPipelineDeclarationFromEnv({ DISPATCH_SYNC_PIPELINE: " EXTERNAL " })).toBe("external");
    expect(syncPipelineDeclarationFromEnv({ DISPATCH_SYNC_PIPELINE: "Off" })).toBe("off");
    expect(syncPipelineDeclarationFromEnv({ DISPATCH_SYNC_PIPELINE: "AUTO" })).toBe("auto");
  });

  it("falls back to auto for an unrecognised value and warns once", () => {
    expect(syncPipelineDeclarationFromEnv({ DISPATCH_SYNC_PIPELINE: "maybe" })).toBe("auto");
    expect(warn).toHaveBeenCalledTimes(1);
    // The same bad value must not warn again.
    expect(syncPipelineDeclarationFromEnv({ DISPATCH_SYNC_PIPELINE: "maybe" })).toBe("auto");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns once when an external driver declares no sync interval", async () => {
    // A fresh module instance so the warn-once dedupe flag is untouched.
    vi.resetModules();
    const { syncPipelineDeclarationFromEnv: fresh } = await import("@/lib/sync-pipeline");
    expect(fresh({ DISPATCH_SYNC_PIPELINE: "external" })).toBe("external");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("DISPATCH_SYNC_INTERVAL_MS");
    // A second call must not warn again.
    expect(fresh({ DISPATCH_SYNC_PIPELINE: "external" })).toBe("external");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn when an external driver declares its own cadence", async () => {
    vi.resetModules();
    const { syncPipelineDeclarationFromEnv: fresh } = await import("@/lib/sync-pipeline");
    expect(
      fresh({
        DISPATCH_SYNC_PIPELINE: "external",
        DISPATCH_SYNC_INTERVAL_MS: "3600000",
      }),
    ).toBe("external");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("resolveSyncPipelineState", () => {
  const cases: Array<{
    name: string;
    declaration: SyncPipelineDeclaration;
    facts: typeof FACTS;
    expected: SyncPipelineState;
  }> = [
    {
      name: "off declaration wins over every other fact",
      declaration: "off",
      facts: { schedulerEnabled: true, syncIntervalMs: 900_000 },
      expected: "off",
    },
    {
      name: "off declaration wins even without a scheduler",
      declaration: "off",
      facts: { schedulerEnabled: false, syncIntervalMs: 0 },
      expected: "off",
    },
    {
      name: "external declaration arms the pipeline without an in-process scheduler",
      declaration: "external",
      facts: FACTS,
      expected: "armed",
    },
    {
      name: "external declaration arms the pipeline even with the sync job disabled",
      declaration: "external",
      facts: { schedulerEnabled: false, syncIntervalMs: 0 },
      expected: "armed",
    },
    {
      name: "auto with the sync job disabled is off",
      declaration: "auto",
      facts: { schedulerEnabled: true, syncIntervalMs: 0 },
      expected: "off",
    },
    {
      name: "auto with the in-process scheduler ticking is armed",
      declaration: "auto",
      facts: { schedulerEnabled: true, syncIntervalMs: 900_000 },
      expected: "armed",
    },
    {
      name: "auto with the in-process scheduler disabled is unknown (an external driver must be declared)",
      declaration: "auto",
      facts: FACTS,
      expected: "unknown",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveSyncPipelineState(c.declaration, c.facts)).toBe(c.expected);
    });
  }

  it("sync history can never arm the pipeline", () => {
    // The old table armed the pipeline on "a sync ever completed" — one
    // manual sync in the DEFAULT deployment then paged CRITICAL A2.
    const factsWithHistory = {
      schedulerEnabled: false,
      syncIntervalMs: 900_000,
      evidence: true,
    } as unknown as typeof FACTS;
    expect(resolveSyncPipelineState("auto", factsWithHistory)).toBe("unknown");
  });
});
