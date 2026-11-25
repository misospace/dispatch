import { describe, it, expect, afterEach } from "vitest";
import {
  projectExternalContribution,
  projectCourierSurface,
  type ExternalContributionWire,
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

describe("ExternalContributionWire (#1688 review)", () => {
  it("keeps nullable projection fields nullable on the wire type", () => {
    // `WireValue` is a naked conditional type, so it distributes and `null`
    // falls through unchanged (it extends neither `Date` nor `object`). This
    // assignment is the regression pin: a refactor that maps a nullable field
    // to a plain `string` stops compiling here while `strict` stays on
    // (tsconfig.json).
    const wire: Pick<
      ExternalContributionWire,
      "run" | "workItemId" | "upstreamIssue" | "lastError"
    > & {
      state: ExternalContributionWire["tracking"]["state"];
      cause: ExternalContributionWire["tracking"]["cause"];
    } = {
      run: null,
      workItemId: null,
      upstreamIssue: null,
      lastError: null,
      state: null,
      cause: null,
    };
    expect(Object.values(wire).every((value) => value === null)).toBe(true);
  });
});

describe("projectCourierSurface (#1539)", () => {
  it("shows endpoint presence, namespaces, and credential presence when configured — and no credential or endpoint value", () => {
    process.env.DISPATCH_COURIER_ADMISSION_URL = "https://courier.internal/v1/contributions";
    process.env.DISPATCH_COURIER_ADMISSION_TOKEN = "admission-secret-value";
    process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES = "team-alpha, team-beta";
    process.env.DISPATCH_COURIER_READ_TOKEN = "read-secret-value";

    const surface = projectCourierSurface();
    expect(surface).toEqual({
      endpointConfigured: true,
      namespaces: ["team-alpha", "team-beta"],
      admissionTokenConfigured: true,
      readTokenConfigured: true,
      admissionReason: null,
      trackingAvailable: true,
      trackingReason: null,
      maxDeliveryAttempts: 5,
    });
    const serialized = JSON.stringify(surface);
    expect(serialized).not.toContain("admission-secret-value");
    expect(serialized).not.toContain("read-secret-value");
    // The endpoint URL never crosses into the browser projection at all.
    expect(serialized).not.toContain("courier.internal");
  });

  it("never serializes a credential-bearing endpoint URL into the surface view", () => {
    // Config resolution validates scheme/host but not userinfo or query, so an
    // operator URL may legally carry userinfo or a token-like parameter. The
    // view exposes presence only, so none of it may reach the projection.
    process.env.DISPATCH_COURIER_ADMISSION_URL =
      "https://user:pass@gw.internal:8443/v1/contributions?token=qs3cret";
    process.env.DISPATCH_COURIER_ADMISSION_TOKEN = "admission-secret-value";
    process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES = "team-alpha";
    process.env.DISPATCH_COURIER_READ_TOKEN = "read-secret-value";

    const serialized = JSON.stringify(projectCourierSurface());
    expect(serialized).not.toContain("gw.internal");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("qs3cret");
    expect(serialized).not.toContain("admission-secret-value");
    expect(serialized).not.toContain("read-secret-value");
    expect(projectCourierSurface().endpointConfigured).toBe(true);
  });

  it("names each missing capability when unconfigured, and never claims a configured endpoint", () => {
    delete process.env.DISPATCH_COURIER_ADMISSION_URL;
    delete process.env.DISPATCH_COURIER_ADMISSION_TOKEN;
    delete process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES;
    delete process.env.DISPATCH_COURIER_READ_TOKEN;

    const surface = projectCourierSurface();
    expect(surface.endpointConfigured).toBe(false);
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
    expect(surface.endpointConfigured).toBe(false);
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
