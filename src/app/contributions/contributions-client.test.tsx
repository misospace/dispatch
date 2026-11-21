import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/client-auth", () => ({
  authedFetch: vi.fn(),
}));

import { ContributionsClient } from "./contributions-client";
import { authedFetch } from "@/lib/client-auth";
import type { CourierSurfaceView } from "@/lib/external-contribution-view";

const configured: CourierSurfaceView = {
  endpointConfigured: true,
  namespaces: ["team-alpha", "team-beta"],
  admissionTokenConfigured: true,
  readTokenConfigured: true,
  admissionReason: null,
  trackingAvailable: true,
  trackingReason: null,
  maxDeliveryAttempts: 5,
};

const disabled: CourierSurfaceView = {
  endpointConfigured: false,
  namespaces: [],
  admissionTokenConfigured: false,
  readTokenConfigured: false,
  admissionReason:
    "Courier admission is not configured — submission is disabled. Set DISPATCH_COURIER_ADMISSION_URL and DISPATCH_COURIER_ADMISSION_TOKEN (server-side) to enable it.",
  trackingAvailable: false,
  trackingReason:
    "Courier tracking is unavailable — the read-only credential is not configured. Set DISPATCH_COURIER_READ_TOKEN (the counterpart of Courier's contributeAPI.readKeySecret). Submission remains unaffected.",
  maxDeliveryAttempts: 5,
};

function rowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    idempotencyKey: "key-1",
    status: "accepted",
    run: "run-42",
    namespace: "team-alpha",
    workItemId: "wi-1",
    resumed: false,
    baseRepo: "acme/widgets",
    baseRef: "main",
    workRepo: "acme/widgets-fork",
    lane: "contribution",
    goal: "Add a widget",
    upstreamIssue: null,
    attempts: 1,
    lastError: null,
    tracking: {
      state: "published",
      stale: false,
      phase: "AwaitingReview",
      ciParked: false,
      cause: null,
      publication: {
        pr: "https://github.com/acme/widgets/pull/42",
        branch: "courier/branch",
        headRepo: "bot/widgets",
        headSha: "abc123",
      },
      observedAt: "2026-11-21T07:00:00.000Z",
      phaseEnteredAt: null,
      finishedAt: null,
      checkedAt: null,
      lastError: null,
    },
    createdAt: "2026-11-21T07:00:00.000Z",
    updatedAt: null,
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const listed = (...rows: unknown[]) => json({ requests: rows });

function lastPostBody(): Record<string, unknown> {
  const calls = vi.mocked(authedFetch).mock.calls.filter(
    ([, options]) => options?.method === "POST",
  );
  const last = calls[calls.length - 1];
  return JSON.parse(String(last?.[1]?.body));
}

beforeEach(() => {
  vi.mocked(authedFetch).mockReset();
});

describe("ContributionsClient", () => {
  it("shows the configured surface (endpoint presence, namespaces, credential presence) without credentials or the endpoint URL", async () => {
    vi.mocked(authedFetch).mockResolvedValue(listed());
    render(<ContributionsClient config={configured} />);

    await waitFor(() => expect(screen.getByText("No contribution requests recorded yet.")).toBeTruthy());
    // The panel shows endpoint PRESENCE only — the admission URL (credential-
    // bearing transport config) never enters the browser tree.
    expect(screen.getByText("Admission endpoint")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("courier.internal");
    expect(screen.getByText("team-alpha, team-beta")).toBeTruthy();
    expect(screen.getAllByText("configured").length).toBeGreaterThanOrEqual(3);
    expect(document.body.textContent).not.toMatch(/bearer|token: /i);
  });

  it("names the capability gap and disables submission when the surface is unconfigured", async () => {
    vi.mocked(authedFetch).mockResolvedValue(listed());
    render(<ContributionsClient config={disabled} />);

    await waitFor(() => expect(screen.getByText("No contribution requests recorded yet.")).toBeTruthy());
    // The named gap shows in both the config panel and the disabled form.
    expect(screen.getAllByText(/Courier admission is not configured — submission is disabled/).length).toBe(2);
    expect(screen.getByText(/read-only credential is not configured/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /submit contribution/i })).toBeNull();
  });

  it("renders stored requests with delivery and lifecycle badges, and treats absent tracking as unknown", async () => {
    vi.mocked(authedFetch).mockResolvedValue(
      listed(
        rowFixture(),
        rowFixture({
          id: "req-2",
          status: "uncertain",
          run: null,
          tracking: { ...rowFixture().tracking, state: null, publication: null },
        }),
      ),
    );
    render(<ContributionsClient config={configured} />);

    await waitFor(() => expect(screen.getAllByText("acme/widgets ← acme/widgets-fork").length).toBe(2));
    expect(screen.getByText("accepted")).toBeInTheDocument();
    expect(screen.getByText("uncertain")).toBeInTheDocument();
    expect(screen.getByText("published")).toBeInTheDocument();
    // Absence of tracking is "unobserved", never a completion-flavoured state.
    expect(screen.getByText("unobserved")).toBeInTheDocument();
    // Only the recorded PR is linked; the untracked row shows no broken link.
    const links = screen.getAllByRole("link", { name: /pull request/i });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://github.com/acme/widgets/pull/42");
  });

  it("submits exactly one request identity per form session and rotates it after success", async () => {
    vi.mocked(authedFetch)
      .mockResolvedValueOnce(listed())
      .mockResolvedValue(json(rowFixture({ id: "req-new", status: "accepted", run: "run-new" }), 201));
    render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(screen.getByText("No contribution requests recorded yet.")).toBeTruthy());

    await userEvent.type(screen.getByLabelText("Base repo"), "acme/widgets");
    await userEvent.type(screen.getByLabelText("Work repo"), "acme/widgets-fork");
    await userEvent.type(screen.getByLabelText("Goal"), "Add a widget");
    await userEvent.click(screen.getByRole("button", { name: /submit contribution/i }));

    await waitFor(() => expect(screen.getByText(/Contribution submitted — courier run run-new/)).toBeTruthy());
    const first = lastPostBody();
    expect(first).toMatchObject({
      namespace: "team-alpha",
      lane: "contribution",
      baseRepo: "acme/widgets",
      baseRef: "main",
      workRepo: "acme/widgets-fork",
      goal: "Add a widget",
    });
    expect(typeof first.idempotencyKey).toBe("string");
    expect(String(first.idempotencyKey).length).toBeGreaterThan(8);
    // Goal is now visible in the list row details data.
    expect(screen.getByText("acme/widgets ← acme/widgets-fork")).toBeInTheDocument();

    // A deliberate new contribution uses a fresh identity, not the settled one.
    await userEvent.type(screen.getByLabelText("Base repo"), "acme/other");
    await userEvent.type(screen.getByLabelText("Work repo"), "acme/other-fork");
    await userEvent.type(screen.getByLabelText("Goal"), "Other work");
    await userEvent.click(screen.getByRole("button", { name: /submit contribution/i }));
    await waitFor(() => expect(vi.mocked(authedFetch)).toHaveBeenCalledTimes(3));
    expect(String(lastPostBody().idempotencyKey)).not.toBe(String(first.idempotencyKey));
  });

  it("keeps the request identity across an uncertain delivery so a retry replays it", async () => {
    vi.mocked(authedFetch)
      .mockResolvedValueOnce(listed())
      .mockResolvedValue(json({ error: "courier admission timed out; delivery outcome unknown", ...rowFixture({ status: "uncertain", run: null }) }, 504));
    render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(screen.getByText("No contribution requests recorded yet.")).toBeTruthy());

    await userEvent.type(screen.getByLabelText("Base repo"), "acme/widgets");
    await userEvent.type(screen.getByLabelText("Work repo"), "acme/widgets-fork");
    await userEvent.type(screen.getByLabelText("Goal"), "Add a widget");
    await userEvent.click(screen.getByRole("button", { name: /submit contribution/i }));

    await waitFor(() => expect(screen.getByText(/retries the SAME request identity/i)).toBeTruthy());
    const uncertainKey = lastPostBody().idempotencyKey;

    await userEvent.click(screen.getByRole("button", { name: /submit contribution/i }));
    await waitFor(() => expect(vi.mocked(authedFetch)).toHaveBeenCalledTimes(3));
    expect(lastPostBody().idempotencyKey).toBe(uncertainKey);
  });

  it("replays the durable identity from the stored row after a reload instead of forking a new one", async () => {
    // Session one: the submit lands in uncertain delivery; the ledger row
    // (and its recorded key) is now the only durable copy of the identity.
    vi.mocked(authedFetch)
      .mockResolvedValueOnce(listed())
      .mockResolvedValue(
        json(
          {
            error: "courier admission timed out; delivery outcome unknown",
            ...rowFixture({
              status: "uncertain",
              run: null,
              tracking: { ...rowFixture().tracking, state: null, publication: null },
            }),
          },
          504,
        ),
      );
    const first = render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(first.getByText("No contribution requests recorded yet.")).toBeTruthy());
    await userEvent.type(first.getByLabelText("Base repo"), "acme/widgets");
    await userEvent.type(first.getByLabelText("Work repo"), "acme/widgets-fork");
    await userEvent.type(first.getByLabelText("Goal"), "Add a widget");
    await userEvent.click(first.getByRole("button", { name: /submit contribution/i }));
    await waitFor(() => expect(first.getByText(/retries the SAME request identity/i)).toBeTruthy());
    const durableKey = String(lastPostBody().idempotencyKey);
    const canonical = lastPostBody();
    first.unmount();

    // Reload: a fresh mount starts a NEW form-session key; the ledger row is
    // the durable identity, and "Retry delivery" must replay exactly it.
    vi.mocked(authedFetch).mockReset();
    vi.mocked(authedFetch).mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/external-contributions" && options?.method === "POST") {
        return json(rowFixture({ status: "accepted", run: "run-42" }), 201);
      }
      if (url === "/api/external-contributions") {
        return listed(
          rowFixture({
            status: "uncertain",
            run: null,
            idempotencyKey: durableKey,
            tracking: { ...rowFixture().tracking, state: null, publication: null },
          }),
        );
      }
      throw new Error(`unexpected url ${url}`);
    });
    render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(screen.getByText("uncertain")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /retry delivery/i }));
    await waitFor(() =>
      expect(screen.getByText(/Re-delivered under the SAME request identity/)).toBeTruthy(),
    );

    const posts = vi
      .mocked(authedFetch)
      .mock.calls.filter(([, options]) => options?.method === "POST");
    // Exactly one POST — the retry reused the stored identity, it did not add one.
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0]?.[1]?.body));
    expect(body.idempotencyKey).toBe(durableKey);
    expect(body).toMatchObject({
      namespace: canonical.namespace,
      lane: canonical.lane,
      baseRepo: canonical.baseRepo,
      baseRef: canonical.baseRef,
      workRepo: canonical.workRepo,
      goal: canonical.goal,
    });
  });

  it("says a retry on an already-settled identity replayed it instead of claiming a new delivery", async () => {
    const unsettled = rowFixture({
      status: "uncertain",
      run: null,
      tracking: { ...rowFixture().tracking, state: null, publication: null },
    });
    vi.mocked(authedFetch).mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/external-contributions" && options?.method === "POST") {
        // 200 replay_accepted: the identity had already settled elsewhere.
        return json(rowFixture({ status: "accepted", run: "run-42" }), 200);
      }
      if (url === "/api/external-contributions") return listed(unsettled);
      throw new Error(`unexpected url ${url}`);
    });
    render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(screen.getByText("uncertain")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /retry delivery/i }));
    await waitFor(() =>
      expect(screen.getByText(/already settled with Courier \(run run-42\).*created nothing new/i)).toBeTruthy(),
    );
  });

  it("does not offer retry delivery once the attempt budget is spent", async () => {
    vi.mocked(authedFetch).mockResolvedValue(
      listed(
        rowFixture({
          status: "uncertain",
          run: null,
          attempts: 5,
          tracking: { ...rowFixture().tracking, state: null, publication: null },
        }),
      ),
    );
    render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(screen.getByText("uncertain")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /retry delivery/i })).toBeNull();
  });

  it("renders a recorded non-http(s) PR value as text, never as an href", async () => {
    vi.mocked(authedFetch).mockResolvedValue(
      listed(
        rowFixture({
          tracking: {
            ...rowFixture().tracking,
            publication: { ...rowFixture().tracking.publication, pr: "javascript:alert(1)" },
          },
        }),
      ),
    );
    render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(screen.getByText("accepted")).toBeInTheDocument());

    // The hostile value stays visible (honesty) but is never a clickable link.
    expect(screen.queryByRole("link", { name: /pull request/i })).toBeNull();
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
    expect(document.querySelector("a[href^='javascript:']")).toBeNull();
  });

  it("shows the attempt bound from the server config, not a client-side constant", async () => {
    const seven = { ...configured, maxDeliveryAttempts: 7 };
    vi.mocked(authedFetch).mockImplementation(async (url: string) => {
      if (url === "/api/external-contributions") return listed(rowFixture());
      if (url === "/api/external-contributions/req-1") return json(rowFixture());
      throw new Error(`unexpected url ${url}`);
    });
    render(<ContributionsClient config={seven} />);
    await waitFor(() => expect(screen.getByText("accepted")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^details$/i }));
    await waitFor(() => expect(screen.getByText(/of 7/)).toBeInTheDocument());
  });

  it("rotates the identity after a settled Courier rejection", async () => {
    vi.mocked(authedFetch)
      .mockResolvedValueOnce(listed())
      .mockResolvedValue(json({ error: "courier admission rejected with HTTP 403: lane not permitted", ...rowFixture({ status: "rejected", run: null }) }, 403));
    render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(screen.getByText("No contribution requests recorded yet.")).toBeTruthy());

    await userEvent.type(screen.getByLabelText("Base repo"), "acme/widgets");
    await userEvent.type(screen.getByLabelText("Work repo"), "acme/widgets-fork");
    await userEvent.type(screen.getByLabelText("Goal"), "Add a widget");
    await userEvent.click(screen.getByRole("button", { name: /submit contribution/i }));

    await waitFor(() => expect(screen.getByText(/fresh request identity/)).toBeTruthy());
    const rejectedKey = lastPostBody().idempotencyKey;
    await userEvent.click(screen.getByRole("button", { name: /submit contribution/i }));
    await waitFor(() => expect(vi.mocked(authedFetch)).toHaveBeenCalledTimes(3));
    expect(lastPostBody().idempotencyKey).not.toBe(rejectedKey);
  });

  it("rejects control characters in lane before submitting, mirroring the server rule", async () => {
    vi.mocked(authedFetch).mockResolvedValue(listed());
    render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(screen.getByText("No contribution requests recorded yet.")).toBeTruthy());

    await userEvent.type(screen.getByLabelText("Base repo"), "acme/widgets");
    await userEvent.type(screen.getByLabelText("Work repo"), "acme/widgets-fork");
    await userEvent.type(screen.getByLabelText("Goal"), "Add a widget");
    fireEvent.input(screen.getByLabelText("Lane"), { target: { value: "contrib\tution" } });
    await userEvent.click(screen.getByRole("button", { name: /submit contribution/i }));

    await waitFor(() =>
      expect(screen.getByText("lane must not contain control characters.")).toBeTruthy(),
    );
    // Only the initial list load happened — the invalid form never submitted.
    expect(vi.mocked(authedFetch)).toHaveBeenCalledTimes(1);
  });

  it("opens one request's details from the ledger route and shows the recorded goal", async () => {
    vi.mocked(authedFetch).mockImplementation(async (url: string) => {
      if (url === "/api/external-contributions") return listed(rowFixture());
      if (url === "/api/external-contributions/req-1") {
        return json(rowFixture({ goal: "Add a very specific widget", upstreamIssue: "https://github.com/acme/widgets/issues/12" }));
      }
      throw new Error(`unexpected url ${url}`);
    });
    render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(screen.getByText("accepted")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^details$/i }));
    await waitFor(() => expect(screen.getByText("Add a very specific widget")).toBeTruthy());
    expect(screen.getByText("Idempotency key:", { exact: false })).toBeInTheDocument();
    expect(
      screen.getByText("https://github.com/acme/widgets/issues/12", { selector: "a" }).getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/issues/12");
  });

  it("refreshes tracking only for accepted requests and surfaces the bounded cooldown honestly", async () => {
    vi.mocked(authedFetch).mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/external-contributions") {
        return listed(
          rowFixture(),
          rowFixture({ id: "req-5", status: "pending", run: null }),
        );
      }
      if (url === "/api/external-contributions/req-1/refresh" && options?.method === "POST") {
        return json({ refreshed: false, cooldownRemainingMs: 9_500, ...rowFixture() });
      }
      throw new Error(`unexpected url ${url}`);
    });
    render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(screen.getByText("accepted")).toBeInTheDocument());

    // Only the accepted request offers a tracking refresh.
    const refreshButtons = screen.getAllByRole("button", { name: /refresh tracking/i });
    expect(refreshButtons).toHaveLength(1);

    await userEvent.click(refreshButtons[0]);
    await waitFor(() =>
      expect(screen.getByText(/less than 10s ago — showing stored evidence/i)).toBeTruthy(),
    );
  });

  it("shows a failed refresh without hiding it behind a generic failure", async () => {
    vi.mocked(authedFetch).mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/external-contributions") return listed(rowFixture());
      if (options?.method === "POST") {
        return json({ error: "Courier tracking is unavailable — the read-only credential is not configured. Set DISPATCH_COURIER_READ_TOKEN (the counterpart of Courier's contributeAPI.readKeySecret). Submission remains unaffected.", refreshed: false, ...rowFixture() }, 503);
      }
      throw new Error(`unexpected url ${url}`);
    });
    render(<ContributionsClient config={configured} />);
    await waitFor(() => expect(screen.getByText("accepted")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /refresh tracking/i }));
    await waitFor(() =>
      expect(screen.getByText(/read-only credential is not configured/)).toBeInTheDocument(),
    );
  });
});
