import { describe, it, expect, afterEach } from "vitest";
import {
  projectExternalContribution,
  projectCourierSurface,
} from "./external-contribution-view";
import type { ExternalContributionRow } from "./external-contribution";

const ENV_KEYS = [
  "DISPATCH_COURIER_ADMISSION_URL",
  "DISPATCH_COURIER_ADMISSION_TOKEN",
  "DISPATCH_COURIER_ADMISSION_NAMESPACES",
  "DISPATCH_COURIER_READ_TOKEN",
] as const;

const original: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) original[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function ledgerRow(): ExternalContributionRow {
  const now = new Date("2026-11-21T07:00:00.000Z");
  return {
    id: "req-1",
    idempotencyKey: "key-1",
    createdBy: "operator",
    namespace: "team-alpha",
    lane: "contribution",
    baseRepo: "acme/widgets",
    baseRef: "main",
    workRepo: "acme/widgets-fork",
    goal: "Add a widget",
    upstreamIssue: null,
    payloadDigest: "digest",
    deliveryStatus: "accepted",
    courierRun: "run-42",
    courierNamespace: "team-alpha",
    courierWorkItemId: "wi-1",
    resumed: false,
    courierHttpStatus: 201,
    lastError: null,
    attemptCount: 1,
    lastAttemptAt: now,
    inFlightUntil: null,
    attemptToken: null,
    trackingState: "published",
    courierPhase: "AwaitingReview",
    courierCiParked: false,
    courierCauseCategory: null,
    courierCauseOutcome: null,
    courierPrUrl: "https://github.com/acme/widgets/pull/42",
    courierPrBranch: "courier/branch",
    courierPrHeadRepo: "bot/widgets",
    courierPrHeadSha: "abc123",
    courierObservedAt: now,
    courierPhaseEnteredAt: null,
    courierFinishedAt: null,
    trackingCheckedAt: now,
    trackingError: null,
    createdAt: now,
    updatedAt: now,
  } as ExternalContributionRow;
}

describe("projectExternalContribution", () => {
  it("carries the recorded request (lane, goal) plus the lifecycle view on the shared projection", () => {
    const view = projectExternalContribution(ledgerRow());
    expect(view).toMatchObject({
      id: "req-1",
      lane: "contribution",
      goal: "Add a widget",
      baseRepo: "acme/widgets",
      status: "accepted",
    });
    expect(view.tracking).toMatchObject({ state: "published", phase: "AwaitingReview" });
    expect(view.tracking.publication?.pr).toBe("https://github.com/acme/widgets/pull/42");
  });
});

describe("projectCourierSurface (#1539)", () => {
  it("shows endpoint, namespaces, and credential presence when configured — and no credential value", () => {
    process.env.DISPATCH_COURIER_ADMISSION_URL = "https://courier.internal/v1/contributions";
    process.env.DISPATCH_COURIER_ADMISSION_TOKEN = "admission-secret-value";
    process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES = "team-alpha, team-beta";
    process.env.DISPATCH_COURIER_READ_TOKEN = "read-secret-value";

    const surface = projectCourierSurface();
    expect(surface).toEqual({
      endpoint: "https://courier.internal/v1/contributions",
      namespaces: ["team-alpha", "team-beta"],
      admissionTokenConfigured: true,
      readTokenConfigured: true,
      admissionReason: null,
      trackingAvailable: true,
      trackingReason: null,
    });
    const serialized = JSON.stringify(surface);
    expect(serialized).not.toContain("admission-secret-value");
    expect(serialized).not.toContain("read-secret-value");
  });

  it("names each missing capability when unconfigured, and never exposes a half-configured endpoint", () => {
    delete process.env.DISPATCH_COURIER_ADMISSION_URL;
    delete process.env.DISPATCH_COURIER_ADMISSION_TOKEN;
    delete process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES;
    delete process.env.DISPATCH_COURIER_READ_TOKEN;

    const surface = projectCourierSurface();
    expect(surface.endpoint).toBeNull();
    expect(surface.namespaces).toEqual([]);
    expect(surface.admissionTokenConfigured).toBe(false);
    expect(surface.readTokenConfigured).toBe(false);
    expect(surface.admissionReason).toContain("DISPATCH_COURIER_ADMISSION_URL");
    expect(surface.admissionReason).toContain("DISPATCH_COURIER_ADMISSION_TOKEN");
    expect(surface.trackingAvailable).toBe(false);
    expect(surface.trackingReason).toContain("DISPATCH_COURIER_ADMISSION_URL");
  });

  it("lists configured namespaces even while submission is disabled by a missing endpoint", () => {
    delete process.env.DISPATCH_COURIER_ADMISSION_URL;
    delete process.env.DISPATCH_COURIER_ADMISSION_TOKEN;
    process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES = "team-alpha";

    const surface = projectCourierSurface();
    expect(surface.namespaces).toEqual(["team-alpha"]);
    expect(surface.endpoint).toBeNull();
    expect(surface.admissionReason).toContain("submission is disabled");
  });

  it("keeps tracking availability honest when only the read credential is missing", () => {
    process.env.DISPATCH_COURIER_ADMISSION_URL = "https://courier.internal/v1/contributions";
    process.env.DISPATCH_COURIER_ADMISSION_TOKEN = "admission-secret-value";
    process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES = "team-alpha";
    delete process.env.DISPATCH_COURIER_READ_TOKEN;

    const surface = projectCourierSurface();
    expect(surface.trackingAvailable).toBe(false);
    expect(surface.trackingReason).toContain("DISPATCH_COURIER_READ_TOKEN");
    expect(surface.admissionReason).toBeNull();
    expect(JSON.stringify(surface)).not.toContain("admission-secret-value");
  });
});
