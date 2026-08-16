import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { MonitoringRequestError, createFixtureMonitoringProvider } from "../data/provider";
import type { MonitoringProvider } from "../data/types";

const fixtureProvider = createFixtureMonitoringProvider();

function renderApp(route = "/"): void {
  render(
    <MemoryRouter initialEntries={[route]}>
      <App provider={fixtureProvider} />
    </MemoryRouter>
  );
}

describe("enterprise application shell", () => {
  it("does not load protected evidence until a session is authenticated", async () => {
    const getOverview = vi.fn(() => Promise.reject(new Error("Protected evidence must not be requested")));
    const provider: MonitoringProvider = {
      ...fixtureProvider,
      getSession: () => Promise.reject(new MonitoringRequestError(401, "authentication_required", "Authentication is required.")),
      getOverview
    };

    render(<MemoryRouter initialEntries={["/logs?service=cpq-demo"]}><App provider={provider} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Cloudflare Access identity required" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
    expect(getOverview).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Logs & events" })).not.toBeInTheDocument();
  });

  it("shows provider failure explicitly without granting access", async () => {
    const provider: MonitoringProvider = {
      ...fixtureProvider,
      getSession: () => Promise.reject(new MonitoringRequestError(503, "identity_provider_unavailable", "Identity provider is unavailable."))
    };

    render(<MemoryRouter><App provider={provider} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Identity validation unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Fleet overview" })).not.toBeInTheDocument();
  });

  it("keeps monitoring evidence readable for viewers while omitting incident commands", async () => {
    const provider: MonitoringProvider = {
      ...fixtureProvider,
      getSession: () => Promise.resolve({
        apiVersion: 1,
        authenticated: true,
        user: { id: "access:viewer", displayName: "Read Only", role: "viewer" },
        expiresAt: "2026-08-17T12:00:00.000Z"
      })
    };

    render(<MemoryRouter initialEntries={["/incidents"]}><App provider={provider} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Incidents" })).toBeInTheDocument();
    expect(screen.getByText("Read Only")).toBeInTheDocument();
    expect(screen.getByText("Viewer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Declare incident" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Open runbook" })).toBeInTheDocument();
  });

  it("labels fixture mode and exposes every primary route", async () => {
    renderApp();

    expect(await screen.findByRole("heading", { name: "Fleet overview" })).toBeInTheDocument();
    expect(screen.getByText("Fixture data")).toBeInTheDocument();
    for (const route of ["Overview", "Deployments", "Infrastructure", "Performance", "Incidents", "Logs", "Settings"]) {
      expect(screen.getByRole("link", { name: route })).toBeInTheDocument();
    }
  });

  it("navigates between primary routes without a backend", async () => {
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { name: "Fleet overview" });
    await user.click(screen.getByRole("link", { name: "Deployments" }));
    expect(await screen.findByRole("heading", { name: "Deployments" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Performance" }));
    expect(await screen.findByRole("heading", { name: "Performance & capacity" })).toBeInTheDocument();
  });

  it("opens a catalog-driven service detail view", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("link", { name: "CPQ Demo" }));
    expect(await screen.findByRole("heading", { name: "CPQ Demo" })).toBeInTheDocument();
    expect(screen.getByText("Reachability evidence")).toBeInTheDocument();
    expect(screen.getByText("Workload evidence")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Investigate logs" })).toHaveAttribute("href", "/logs?service=cpq-demo&range=1h");
  });

  it("correlates bounded pod logs and Kubernetes events with explicit filters", async () => {
    const user = userEvent.setup();
    let latestService = "";
    const provider: MonitoringProvider = {
      ...fixtureProvider,
      getOverview(environment, timeRange) { return fixtureProvider.getOverview(environment, timeRange); },
      getPerformance(environment, serviceId, timeRange) { return fixtureProvider.getPerformance(environment, serviceId, timeRange); },
      async getLogs(query) {
        latestService = query.serviceId;
        const response = await fixtureProvider.getLogs?.(query);
        if (response === undefined) throw new Error("Fixture log provider is unavailable");
        return response;
      }
    };
    render(<MemoryRouter initialEntries={["/logs?service=cpq-demo&range=6h"]}><App provider={provider} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Logs & events" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Time range" })).toHaveValue("6h");
    expect(screen.getByRole("combobox", { name: "Log service" })).toHaveValue("cpq-demo");
    expect(await screen.findByText("Request failed safely; password=[REDACTED]")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Kubernetes events" })).toBeInTheDocument();
    expect(screen.getByText("max 50 relevant events · 5/object")).toBeInTheDocument();
    expect(screen.getByText("Fixture container restart back-off")).toBeInTheDocument();
    expect(screen.getByText(/Server-side redaction applied/u)).toBeInTheDocument();
    expect(screen.getByText("16 stream cap")).toBeInTheDocument();
    expect(screen.getByText("1/8 mapped pods / cap")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download diagnostic JSON" })).toBeEnabled();

    await user.selectOptions(screen.getByRole("combobox", { name: "Log service" }), "portfolio");
    await user.selectOptions(screen.getByRole("combobox", { name: "Log severity" }), "error");
    await user.type(screen.getByRole("searchbox", { name: "Search log messages" }), "failed");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(latestService).toBe("portfolio"));
    expect(await screen.findByText("Request failed safely; password=[REDACTED]")).toBeInTheDocument();
  });

  it("deep-links from an incident to correlated logs without losing the time window", async () => {
    const user = userEvent.setup();
    renderApp("/incidents?range=6h");
    await screen.findByRole("heading", { name: "Incidents" });
    const link = await screen.findByRole("link", { name: /Investigate logs for OAuth \/ Keycloak/u });
    expect(link).toHaveAttribute("href", "/logs?service=oauth&range=6h");
    await user.click(link);
    expect(await screen.findByRole("heading", { name: "Logs & events" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Log service" })).toHaveValue("oauth");
    expect(screen.getByRole("combobox", { name: "Time range" })).toHaveValue("6h");
  });

  it("shows partial source evidence and internal/public disagreement", async () => {
    const partialProvider: MonitoringProvider = {
      ...fixtureProvider,
      async getOverview(environment, timeRange) {
        const fixture = await fixtureProvider.getOverview(environment, timeRange);
        return {
          ...fixture,
          mode: "partial",
          services: fixture.services.map((service) => service.id === "cpq-demo" ? {
            ...service,
            state: "failing",
            reachability: { internal: "healthy", external: "failing", comparison: "disagreement" }
          } : service),
          sources: [
            { source: "catalog", availability: "available", observedAt: null, toolUrl: null, message: null },
            { source: "kubernetes", availability: "unavailable", observedAt: null, toolUrl: null, message: "Read-only credential unavailable" }
          ]
        };
      },
      getPerformance(environment, serviceId, timeRange) {
        return fixtureProvider.getPerformance(environment, serviceId, timeRange);
      }
    };
    render(<MemoryRouter><App provider={partialProvider} /></MemoryRouter>);

    expect(await screen.findByText("Partial live inventory")).toBeInTheDocument();
    expect(screen.getByText("Read-only credential unavailable")).toBeInTheDocument();
    expect(screen.getAllByText("disagreement").length).toBeGreaterThan(0);
  });

  it("opens command search with the keyboard and navigates from a result", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.keyboard("/");
    const search = screen.getByRole("dialog", { name: "Command search" });
    expect(search).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "incident");
    await user.click(screen.getByRole("option", { name: /Incidents/ }));
    expect(await screen.findByRole("heading", { name: "Incidents" })).toBeInTheDocument();
  });

  it("searches live service inventory from command search", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: /Search workspace/u }));
    const searchDialog = screen.getByRole("dialog", { name: "Command search" });
    await user.type(screen.getByRole("searchbox"), "portfolio");
    await user.click(within(searchDialog).getByRole("option", { name: /Portfolio/u }));

    expect(await screen.findByRole("heading", { name: "Portfolio" })).toBeInTheDocument();
    expect(screen.getByText("Read-only service detail assembled from catalog, reachability probes, and mapped workloads.")).toBeInTheDocument();
  });

  it("renders live-shaped performance panels, filters services, and refreshes globally", async () => {
    const user = userEvent.setup();
    let performanceRequests = 0;
    const provider: MonitoringProvider = {
      ...fixtureProvider,
      getOverview(environment, timeRange) {
        return fixtureProvider.getOverview(environment, timeRange);
      },
      async getPerformance(environment, serviceId, timeRange) {
        performanceRequests += 1;
        return fixtureProvider.getPerformance(environment, serviceId, timeRange);
      }
    };
    render(<MemoryRouter initialEntries={["/performance"]}><App provider={provider} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Performance & capacity" })).toBeInTheDocument();
    expect(await screen.findByText("Prometheus telemetry")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Traffic & server errors" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Synthetic latency percentiles" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "JVM & process CPU" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Memory utilization" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Database saturation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pod restarts" })).toBeInTheDocument();
    expect(screen.getByText("Requests in window")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Performance service" }), "cpq-demo");
    expect(performanceRequests).toBeGreaterThanOrEqual(2);
    const beforeRefresh = performanceRequests;
    await user.click(screen.getByRole("button", { name: "Refresh monitoring data" }));
    expect(await screen.findByText(/Refreshed/u)).toBeInTheDocument();
    expect(performanceRequests).toBeGreaterThan(beforeRefresh);
    expect(screen.getByRole("combobox", { name: "Performance service" })).toHaveValue("cpq-demo");

    await user.selectOptions(screen.getByRole("combobox", { name: "Performance service" }), "portfolio");
    expect(await screen.findByRole("heading", { name: "Portfolio correlation" })).toBeInTheDocument();
  });

  it("distinguishes a zero metric from no-data and query-error panel states", async () => {
    const provider: MonitoringProvider = {
      ...fixtureProvider,
      getOverview(environment, timeRange) {
        return fixtureProvider.getOverview(environment, timeRange);
      },
      async getPerformance(environment, serviceId, timeRange) {
        const fixture = await fixtureProvider.getPerformance(environment, serviceId, timeRange);
        return {
          ...fixture,
          mode: "partial",
          source: { name: "prometheus", availability: "partial", message: "2 queries unavailable" },
          metrics: fixture.metrics.map((metric) => metric.id === "request-rate"
            ? { ...metric, points: [{ timestamp: fixture.assembledAt, value: 0 }], latest: 0 }
            : metric.id === "pod-restarts"
              ? { ...metric, status: "no-data", points: [], latest: null, message: "No restart series" }
              : metric.id === "process-cpu"
                ? { ...metric, status: "error", points: [], latest: null, message: "Query timed out" }
                : metric)
        };
      }
    };
    render(<MemoryRouter initialEntries={["/performance"]}><App provider={provider} /></MemoryRouter>);

    expect(await screen.findByText("0.00 requests/s")).toBeInTheDocument();
    expect(screen.getByText("No restart series")).toBeInTheDocument();
    expect(screen.getByText("Query timed out")).toBeInTheDocument();
    expect(screen.getByText("Partial Prometheus telemetry")).toBeInTheDocument();
  });

  it("shows all required fixture states in the settings gallery", async () => {
    renderApp("/settings");

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    for (const state of ["Loading", "Empty", "Partial failure", "Stale", "Unauthorized", "No data"]) {
      expect(screen.getByText(state)).toBeInTheDocument();
    }
  });

  it("filters fixture services by environment and accepts a new time range", async () => {
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { name: "Fleet overview" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Environment" }), "demo");
    await screen.findByText("2 services in current scope");
    expect(screen.queryByText("CPQ Test")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Time range" }), "6h");
    expect(screen.getByRole("combobox", { name: "Time range" })).toHaveValue("6h");
  });

  it("exposes the operator environment model and keeps Portfolio separate", async () => {
    const user = userEvent.setup();
    renderApp();

    const environment = await screen.findByRole("combobox", { name: "Environment" });
    expect(screen.getAllByRole("option", { name: /Demo \/ Prod|Test|Portfolio|Shared \(all\)/u })).toHaveLength(4);
    await user.selectOptions(environment, "portfolio");
    expect(await screen.findByText("1 service in current scope")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Portfolio" })).toBeInTheDocument();
    expect(screen.queryByText("CPQ Demo")).not.toBeInTheDocument();
  });

  it("triages, acknowledges, declares, silences, resolves, and creates persistent incidents", async () => {
    const user = userEvent.setup();
    renderApp("/incidents");

    await user.selectOptions(await screen.findByRole("combobox", { name: "Incident status" }), "all");
    await user.click(await screen.findByRole("button", { name: /CPQ test readiness intermittently failing/u }));
    expect(screen.getByRole("heading", { name: "CPQ test readiness intermittently failing" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Taking ownership of investigation");
    await user.click(screen.getByRole("button", { name: "Confirm acknowledge" }));
    expect(screen.getByText("Acknowledged by J. Haynes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open runbook" }));
    expect(screen.getByRole("dialog", { name: /CPQ Test runbook/u })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close runbook" }));

    await user.click(screen.getByRole("button", { name: "Declare alert as incident" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Customer impact requires incident command");
    await user.click(screen.getByRole("button", { name: "Confirm declaration" }));
    expect(screen.getByText("Declared by J. Haynes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Silence" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Suppress duplicates during bounded validation");
    await user.click(screen.getByRole("button", { name: "Confirm silence" }));
    expect(screen.getByText(/Silenced until/u)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resolve" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Health and workload evidence recovered");
    await user.click(screen.getByRole("button", { name: "Confirm resolution" }));
    expect(screen.getByText("resolved", { selector: ".incident-state" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Declare incident" }));
    await user.type(screen.getByRole("textbox", { name: "Incident title" }), "Portfolio availability investigation");
    await user.selectOptions(screen.getByRole("combobox", { name: "Affected service" }), "portfolio");
    await user.selectOptions(screen.getByRole("combobox", { name: "Severity" }), "P2");
    await user.type(screen.getByRole("textbox", { name: "Declaration reason" }), "Operator observed customer-facing errors");
    await user.click(screen.getByRole("button", { name: "Create incident" }));
    expect(screen.getByRole("heading", { name: "Portfolio availability investigation" })).toBeInTheDocument();
    expect(await screen.findByText("3 incidents")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeEnabled();
    expect(screen.getByText("Notification delivery is not configured in the deterministic fixture provider.")).toBeInTheDocument();
  }, 10_000);

  it("defaults declarations to a service in the selected environment", async () => {
    const user = userEvent.setup();
    renderApp("/incidents");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Environment" }), "portfolio");
    await screen.findByRole("heading", { name: "Incidents" });
    await user.click(screen.getByRole("button", { name: "Declare incident" }));
    expect(screen.getByRole("combobox", { name: "Affected service" })).toHaveValue("portfolio");
  });

  it("uses the local session logout endpoint", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("heading", { name: "Fleet overview" });
    await user.click(screen.getByRole("button", { name: "Open operator menu" }));
    expect(screen.getByRole("button", { name: "Sign out" }).closest("form")).toHaveAttribute("action", "/auth/logout");
    expect(screen.getByRole("button", { name: "Sign out" }).closest("form")).toHaveAttribute("method", "post");
  });

  it("explains degraded state when workload evidence is unavailable", async () => {
    const provider: MonitoringProvider = {
      ...fixtureProvider,
      async getOverview(environment, timeRange) {
        const fixture = await fixtureProvider.getOverview(environment, timeRange);
        return {
          ...fixture,
          services: fixture.services.map((service) => service.id === "cpq-test" ? {
            ...service,
            state: "degraded",
            probes: [{
              id: "cpq-test-ready-internal", name: "CPQ Test readiness", endpoint: service.endpoint,
              vantagePoint: "internal", state: "healthy", checkedAt: fixture.generatedAt, latencyMs: 4,
              statusCode: 200, source: "gatus-internal", sourceToolUrl: "/tools/gatus-internal/"
            }],
            workloads: [{
              kind: "Deployment", namespace: "cpq-test", name: "application", state: "unknown",
              checkedAt: null, ready: null, desired: null, version: null, sourceToolUrl: "#source-unavailable"
            }]
          } : service)
        };
      },
      getPerformance(environment, serviceId, timeRange) {
        return fixtureProvider.getPerformance(environment, serviceId, timeRange);
      }
    };
    render(<MemoryRouter><App provider={provider} /></MemoryRouter>);
    expect(await screen.findByText("Healthy readiness probe; Kubernetes workload evidence unavailable")).toBeInTheDocument();
  });

  it("opens and dismisses utility menus", async () => {
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { name: "Fleet overview" });
    await user.click(screen.getByRole("button", { name: "Open alerts, 2 active" }));
    expect(screen.getByText("OIDC token exchange latency above SLO")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open operator menu" }));
    expect(screen.getByRole("button", { name: "Operator profile" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("OIDC token exchange latency above SLO")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Operator profile" })).not.toBeInTheDocument();
  });

  it("supports empty command results and explicit close controls", async () => {
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { name: "Fleet overview" });
    await user.click(screen.getByRole("button", { name: /Search workspace/ }));
    await user.type(screen.getByRole("searchbox"), "no-such-command");
    expect(screen.getByText("No matching pages or services.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close command search" }));
    expect(screen.queryByRole("dialog", { name: "Command search" })).not.toBeInTheDocument();
  });

  it("renders infrastructure and rejects unknown routes explicitly", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/infrastructure"]}>
        <App provider={fixtureProvider} />
      </MemoryRouter>
    );
    expect(await screen.findByRole("heading", { name: "Infrastructure" })).toBeInTheDocument();
    expect(screen.getByText("Dependency topology")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Dependency relationships")).toHaveTextContent("Prometheus"));
    expect(await screen.findByRole("heading", { name: "Kubernetes inventory" })).toBeInTheDocument();
    unmount();

    renderApp("/not-a-monitoring-route");
    expect(await screen.findByRole("alert")).toHaveTextContent("The requested monitoring route does not exist.");
  });

  it("searches infrastructure resources and opens a source/event drill-down", async () => {
    const user = userEvent.setup();
    renderApp("/infrastructure");
    expect(await screen.findByRole("heading", { name: "Kubernetes inventory" })).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search inventory" }), "cpq-demo");
    expect(screen.getByRole("button", { name: /cpq-demo Deployment/u })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /cpq-demo Deployment/u }));
    expect(screen.getByRole("dialog", { name: "cpq-demo resource details" })).toBeInTheDocument();
    expect(screen.getByText(/Mapped services/u)).toBeInTheDocument();
    expect(screen.getByText(/No recent events/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables Kubernetes search when its credential is unavailable", async () => {
    const provider: MonitoringProvider = {
      ...fixtureProvider,
      getOverview(environment, timeRange) { return fixtureProvider.getOverview(environment, timeRange); },
      getPerformance(environment, serviceId, timeRange) { return fixtureProvider.getPerformance(environment, serviceId, timeRange); },
      getTopology(environment) {
        return Promise.resolve({
          apiVersion: 1, mode: "partial", assembledAt: "2026-08-14T10:00:00Z", environment,
          namespaces: [], truncated: false, resources: [], edges: [],
          source: { name: "kubernetes", availability: "unavailable", message: "Kubernetes read-only credential file is unavailable" }
        });
      }
    };
    render(<MemoryRouter initialEntries={["/infrastructure"]}><App provider={provider} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search inventory" })).toBeDisabled());
    expect(screen.getByText("Search is disabled until the Kubernetes credential is available.")).toBeInTheDocument();
  });
});
