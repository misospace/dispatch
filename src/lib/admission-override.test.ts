import { describe, expect, it } from "vitest";
import {
  ADMISSION_OVERRIDE_PREFIX,
  MAX_OVERRIDE_REASON_LENGTH,
  buildAdmissionOverrideData,
  clearAdmissionOverrideData,
  isValidOverrideHeadSha,
  overrideDependencyNumbers,
} from "./admission-override";
import { UNKNOWN_FRESHNESS, computeGroomingIssueFingerprint } from "@/lib/groomer/freshness";

const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const NOW = new Date("2026-11-10T12:00:00.000Z");

const issue = {
  id: "issue-1",
  number: 7,
  title: "Do the thing",
  body: "Depends on #12\nDepends on #30\nDepends on #7",
  state: "OPEN",
  labels: ["status/ready"],
  commentsCount: 2,
  repoFullName: "owner/repo",
};

const input = {
  actor: "alice",
  reason: "  audited manually  ",
  headSha: HEAD_SHA,
  defaultBranch: "main",
  openDependencyKeys: new Set(["owner/repo#30", "owner/repo#12", "owner/repo#99"]),
  now: NOW,
};

describe("isValidOverrideHeadSha", () => {
  it("accepts a full 40-hex sha in any case", () => {
    expect(isValidOverrideHeadSha(HEAD_SHA)).toBe(true);
    expect(isValidOverrideHeadSha(HEAD_SHA.toUpperCase())).toBe(true);
  });

  it("rejects short, malformed, and non-string values", () => {
    expect(isValidOverrideHeadSha("abc123")).toBe(false);
    expect(isValidOverrideHeadSha(`${"g".repeat(40)}`)).toBe(false);
    expect(isValidOverrideHeadSha(`${HEAD_SHA}${"a"}`)).toBe(false);
    expect(isValidOverrideHeadSha("")).toBe(false);
    expect(isValidOverrideHeadSha(null)).toBe(false);
    expect(isValidOverrideHeadSha(42)).toBe(false);
  });
});

describe("overrideDependencyNumbers", () => {
  it("resolves dependency numbers from the issue body, excluding self-references", () => {
    expect(overrideDependencyNumbers(issue)).toEqual([12, 30]);
  });

  it("returns an empty list when the body names no dependencies", () => {
    expect(overrideDependencyNumbers({ ...issue, body: "Nothing to see here." })).toEqual([]);
    expect(overrideDependencyNumbers({ ...issue, body: null })).toEqual([]);
  });
});

describe("buildAdmissionOverrideData", () => {
  it("writes the override id as both the override record and the freshness baseline", () => {
    const data = buildAdmissionOverrideData(issue, input);
    expect(typeof data.admissionOverrideId).toBe("string");
    expect(String(data.admissionOverrideId).startsWith(ADMISSION_OVERRIDE_PREFIX)).toBe(true);
    expect(data.groomedRunId).toBe(data.admissionOverrideId);
  });

  it("uses an explicit overrideId when one is provided", () => {
    const data = buildAdmissionOverrideData(issue, { ...input, overrideId: "override_fixed" });
    expect(data.admissionOverrideId).toBe("override_fixed");
    expect(data.groomedRunId).toBe("override_fixed");
  });

  it("records the operator, timestamp, sha, and branch", () => {
    const data = buildAdmissionOverrideData(issue, input);
    expect(data.admissionOverrideBy).toBe("alice");
    expect(data.admissionOverrideAt).toBe(NOW);
    expect(data.admissionOverrideHeadSha).toBe(HEAD_SHA);
    expect(data.groomedHeadSha).toBe(HEAD_SHA);
    expect(data.groomedDefaultBranch).toBe("main");
    expect(data.groomingVerifiedSha).toBe(HEAD_SHA);
    expect(data.groomedAt).toBe(NOW);
    expect(data.groomedEvidenceScope).toBe("global");
    expect(data.groomedEvidenceDigest).toBeNull();
  });

  it("trims the reason and drops an empty one", () => {
    expect(buildAdmissionOverrideData(issue, input).admissionOverrideReason).toBe("audited manually");
    expect(buildAdmissionOverrideData(issue, { ...input, reason: null }).admissionOverrideReason).toBeNull();
    expect(buildAdmissionOverrideData(issue, { ...input, reason: "   " }).admissionOverrideReason).toBeNull();
  });

  it("caps the reason at the documented maximum length", () => {
    const data = buildAdmissionOverrideData(issue, { ...input, reason: "x".repeat(3000) });
    expect(data.admissionOverrideReason).toBe("x".repeat(MAX_OVERRIDE_REASON_LENGTH));
  });

  it("records the dependency keys and the sorted open-blocker subset", () => {
    const data = buildAdmissionOverrideData(issue, input);
    expect(data.groomedDependencyKeys).toEqual(["owner/repo#12", "owner/repo#30"]);
    expect(data.groomedOpenBlockerKeys).toEqual(["owner/repo#12", "owner/repo#30"]);
  });

  it("omits open blockers that are not in the dependency set and sorts the rest", () => {
    const data = buildAdmissionOverrideData(issue, {
      ...input,
      openDependencyKeys: new Set(["owner/repo#30", "owner/repo#99"]),
    });
    expect(data.groomedOpenBlockerKeys).toEqual(["owner/repo#30"]);
  });

  it("pins the issue fingerprint to the issue state the override vouches for", () => {
    const data = buildAdmissionOverrideData(issue, input);
    expect(data.groomedIssueFingerprint).toBe(computeGroomingIssueFingerprint(issue));
  });
});

describe("clearAdmissionOverrideData", () => {
  it("resets freshness to unknown when the override is still the baseline, preserving groomingRetryAfter", () => {
    const data = clearAdmissionOverrideData({ groomedRunId: "override_x", admissionOverrideId: "override_x" });
    expect(data.admissionOverrideId).toBeNull();
    expect(data.admissionOverrideBy).toBeNull();
    expect(data.admissionOverrideAt).toBeNull();
    expect(data.admissionOverrideReason).toBeNull();
    expect(data.admissionOverrideHeadSha).toBeNull();
    expect(data.groomedRunId).toBeNull();
    expect(data.groomedIssueFingerprint).toBeNull();
    expect(data.groomingStaleAt).toBeNull();
    expect(data.groomingStaleReasons).toEqual([]);
    // groomingRetryAfter survives the clear so an existing backoff is not dropped.
    expect("groomingRetryAfter" in data).toBe(false);
  });

  it("leaves a real groom's baseline alone when the override is no longer the baseline", () => {
    const data = clearAdmissionOverrideData({ groomedRunId: "groom_123", admissionOverrideId: "override_x" });
    expect(data.admissionOverrideId).toBeNull();
    // The real groom's baseline columns are left alone — absent from the update payload.
    expect("groomedRunId" in data).toBe(false);
    expect("groomedIssueFingerprint" in data).toBe(false);
    expect("groomingStaleAt" in data).toBe(false);
  });

  it("clears only the override columns when neither an override nor a baseline exists", () => {
    const data = clearAdmissionOverrideData({ groomedRunId: null, admissionOverrideId: null });
    expect(Object.keys(data).sort()).toEqual(
      [
        "admissionOverrideAt",
        "admissionOverrideBy",
        "admissionOverrideHeadSha",
        "admissionOverrideId",
        "admissionOverrideReason",
      ].sort(),
    );
  });

  it("matches the UNKNOWN_FRESHNESS shape minus the retained retry column", () => {
    const { groomingRetryAfter: _retained, ...expected } = UNKNOWN_FRESHNESS;
    void _retained;
    const data = clearAdmissionOverrideData({ groomedRunId: "override_x", admissionOverrideId: "override_x" });
    for (const key of Object.keys(expected)) {
      expect(data[key]).toEqual(expected[key]);
    }
  });
});
