import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { createFixtureMonitoringProvider } from "../data/provider";
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
  it("labels fixture mode and exposes every primary route", async () => {
    renderApp();

    expect(await screen.findByRole("heading", { name: "Fleet overview" })).toBeInTheDocument();
    expect(screen.getByText("Fixture data")).toBeInTheDocument();
    for (const route of ["Overview", "Deployments", "Infrastructure", "Performance", "Incidents", "Settings"]) {
      expect(screen.getByRole("link", { name: route })).toBeInTheDocument();
    }
  });

  it("navigates between primary routes without a backend", async () => {
    const user = userEvent.setup();
    renderApp();

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
  });

  it("shows partial source evidence and internal/public disagreement", async () => {
    const partialProvider: MonitoringProvider = {
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

  it("selects, acknowledges, opens a runbook, and declares session incidents", async () => {
    const user = userEvent.setup();
    renderApp("/incidents");

    await user.click(await screen.findByRole("button", { name: /CPQ test readiness intermittently failing/u }));
    expect(screen.getByRole("heading", { name: "CPQ test readiness intermittently failing" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(screen.getByText("Acknowledged by J. Haynes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open runbook" }));
    expect(screen.getByRole("dialog", { name: /CPQ Test runbook/u })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close runbook" }));

    await user.click(screen.getByRole("button", { name: "Declare incident" }));
    await user.type(screen.getByRole("textbox", { name: "Incident title" }), "Portfolio availability investigation");
    await user.type(screen.getByRole("textbox", { name: "Affected service" }), "Portfolio");
    await user.selectOptions(screen.getByRole("combobox", { name: "Severity" }), "P2");
    await user.click(screen.getByRole("button", { name: "Create incident" }));
    expect(screen.getByRole("heading", { name: "Portfolio availability investigation" })).toBeInTheDocument();
    expect(screen.getByText("3 incidents")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeEnabled();
    expect(screen.queryByText("Acknowledged by J. Haynes")).not.toBeInTheDocument();
  });

  it("provides the Cloudflare Access logout endpoint", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("heading", { name: "Fleet overview" });
    await user.click(screen.getByRole("button", { name: "Open operator menu" }));
    expect(screen.getByRole("link", { name: "Sign out" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  });

  it("explains degraded state when workload evidence is unavailable", async () => {
    const provider: MonitoringProvider = {
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
    expect(screen.getByText("Keycloak p95 above SLO")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open operator menu" }));
    expect(screen.getByRole("button", { name: "Operator profile" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Keycloak p95 above SLO")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Operator profile" })).not.toBeInTheDocument();
  });

  it("supports empty command results and explicit close controls", async () => {
    const user = userEvent.setup();
    renderApp();

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
    expect(await screen.findByLabelText("Dependency relationships")).toHaveTextContent("Prometheus");
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
