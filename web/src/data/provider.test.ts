import { describe, expect, it, vi } from "vitest";

import { createFixtureMonitoringProvider, createLiveMonitoringProvider } from "./provider";

describe("fixture monitoring provider", () => {
  it("returns an explicitly labeled fixture snapshot", async () => {
    const provider = createFixtureMonitoringProvider();
    const snapshot = await provider.getOverview("all", "1h");

    expect(snapshot.mode).toBe("fixture");
    expect(snapshot.services).toHaveLength(6);
    expect(snapshot.summary.total).toBe(6);
    expect(snapshot.generatedAt).toMatch(/^2026-/);
  });

  it("filters service rows by environment", async () => {
    const provider = createFixtureMonitoringProvider();
    const snapshot = await provider.getOverview("demo", "1h");

    expect(snapshot.services.every((service) => service.environment === "demo")).toBe(true);
    expect(snapshot.summary.total).toBe(2);
  });

  it("provides deterministic performance telemetry only for tests and previews", async () => {
    const performance = await createFixtureMonitoringProvider().getPerformance("demo", "cpq-demo", "1h");

    expect(performance.mode).toBe("live");
    expect(performance.metrics.map((metric) => metric.id)).toContain("request-rate");
    expect(performance.metrics.map((metric) => metric.id)).toContain("request-total");
    expect(performance.source.name).toBe("prometheus");
  });

  it("provides deterministic searchable topology for UI tests", async () => {
    const topology = await createFixtureMonitoringProvider().getTopology?.("demo");
    expect(topology?.environment).toBe("demo");
    expect(topology?.resources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "Deployment", serviceIds: ["cpq-demo"] })]));
  });

  it("throws an explicit error for an unsupported environment", async () => {
    const provider = createFixtureMonitoringProvider();

    await expect(provider.getOverview("production" as never, "1h")).rejects.toThrow(
      "Unsupported environment"
    );
  });

  it("loads live inventory from the same-origin read-only API", async () => {
    const fetchImpl = vi.fn((): Promise<Response> => Promise.resolve(new Response(JSON.stringify({
      apiVersion: 1,
      mode: "partial",
      assembledAt: "2026-08-13T01:00:00Z",
      lastObservedAt: "2026-08-13T00:59:55Z",
      environment: "demo",
      summary: { total: 1, healthy: 0, degraded: 1, failing: 0, unknown: 0, paused: 0, stale: 0 },
      services: [{
        id: "cpq-demo", name: "CPQ Demo", kind: "application", environment: "demo", owner: "Development Lab",
        criticality: "critical", state: "degraded", lastCheckedAt: "2026-08-13T00:59:55Z", version: "4.14.0",
        endpoint: "https://demo.example.test/ready", reachability: { internal: "healthy", external: "failing", comparison: "disagreement" },
        probes: [], workloads: [], sourceLinks: []
      }],
      sources: [{ source: "kubernetes", availability: "unavailable", observedAt: null, toolUrl: null, message: "Credential unavailable" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const provider = createLiveMonitoringProvider({ fetchImpl, timeoutMs: 1000 });

    const snapshot = await provider.getOverview("demo", "1h");

    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/inventory?environment=demo", expect.objectContaining({ method: "GET" }));
    expect(snapshot.mode).toBe("partial");
    expect(snapshot.services[0]?.reachability.comparison).toBe("disagreement");
  });

  it("fails explicitly on malformed or unavailable live inventory without fixture fallback", async () => {
    const malformed = createLiveMonitoringProvider({
      fetchImpl: (): Promise<Response> => Promise.resolve(new Response(JSON.stringify({ mode: "live" }), { status: 200 })),
      timeoutMs: 1000
    });
    const unavailable = createLiveMonitoringProvider({
      fetchImpl: (): Promise<Response> => Promise.resolve(new Response("upstream down", { status: 503 })),
      timeoutMs: 1000
    });

    await expect(malformed.getOverview("all", "1h")).rejects.toThrow("malformed");
    await expect(unavailable.getOverview("all", "1h")).rejects.toThrow("HTTP 503");
  });

  it("loads and validates live performance telemetry with encoded allow-listed filters", async () => {
    const fetchImpl = vi.fn((): Promise<Response> => Promise.resolve(new Response(JSON.stringify({
      apiVersion: 1,
      mode: "live",
      assembledAt: "2026-08-13T18:00:00Z",
      observedAt: "2026-08-13T17:59:00Z",
      environment: "demo",
      serviceId: "cpq-demo",
      window: { range: "1h", start: "2026-08-13T17:00:00Z", end: "2026-08-13T18:00:00Z", stepSeconds: 60, maxPoints: 61 },
      source: { name: "prometheus", availability: "available", message: null },
      metrics: [{ id: "request-rate", label: "Request rate", unit: "requests/s", status: "ok", points: [{ timestamp: "2026-08-13T17:59:00Z", value: 0 }], latest: 0, threshold: null, message: null }]
    }), { status: 200 })));
    const provider = createLiveMonitoringProvider({ fetchImpl, timeoutMs: 1000 });

    const performance = await provider.getPerformance("demo", "cpq-demo", "1h");

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/performance?environment=demo&service=cpq-demo&range=1h",
      expect.objectContaining({ method: "GET" })
    );
    expect(performance.metrics[0]).toMatchObject({ status: "ok", latest: 0 });
  });

  it("rejects malformed performance telemetry without substituting fixtures", async () => {
    const provider = createLiveMonitoringProvider({
      fetchImpl: (): Promise<Response> => Promise.resolve(new Response(JSON.stringify({ apiVersion: 1, mode: "live" }), { status: 200 })),
      timeoutMs: 1000
    });

    await expect(provider.getPerformance("all", "all", "1h")).rejects.toThrow("Performance API returned a malformed response");
  });

  it("loads and validates topology without accepting arbitrary query input", async () => {
    const fetchImpl = vi.fn((): Promise<Response> => Promise.resolve(new Response(JSON.stringify({
      apiVersion: 1, mode: "live", assembledAt: "2026-08-14T10:00:00Z", environment: "demo", namespaces: ["default"], truncated: false,
      resources: [{ id: "Node::lab", kind: "Node", namespace: null, name: "lab", state: "healthy", summary: "Ready", issueCode: null, serviceIds: [], nodeName: null, restarts: null, capacity: null, sourceLabel: "Kubernetes", sourceToolUrl: "/tools/kubernetes/cluster/node/lab", events: [] }],
      edges: [], source: { name: "kubernetes", availability: "available", message: null }
    }), { status: 200 })));
    const provider = createLiveMonitoringProvider({ fetchImpl, timeoutMs: 1000 });
    const topology = await provider.getTopology?.("demo");
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/topology?environment=demo", expect.objectContaining({ method: "GET" }));
    expect(topology?.resources[0]).toMatchObject({ kind: "Node", name: "lab" });

    const malformed = createLiveMonitoringProvider({ fetchImpl: (): Promise<Response> => Promise.resolve(new Response(JSON.stringify({ apiVersion: 1 }), { status: 200 })), timeoutMs: 1000 });
    await expect(malformed.getTopology?.("demo")).rejects.toThrow("Topology API returned a malformed response");
  });

  it("loads persistent incidents and sends strict commands without a browser-selected actor", async () => {
    const incident = {
      id: "INC-000001", version: 1, title: "CPQ Demo is failing", description: "Live alert", serviceId: "cpq-demo",
      serviceName: "CPQ Demo", environment: "demo", severity: "P1", status: "active", startedAt: "2026-08-14T14:00:00Z",
      lastObservedAt: "2026-08-14T14:00:00Z", updatedAt: "2026-08-14T14:00:00Z", resolvedAt: null,
      acknowledgedAt: null, acknowledgedBy: null, declaredAt: null, declaredBy: null, assignee: "Unassigned", owner: "Development Lab",
      alertActive: true, recoveredAt: null, runbook: { id: "cpq-demo-response", title: "CPQ Demo response", steps: ["Confirm evidence."] },
      evidence: [{ source: "gatus-internal", state: "failing", firstObservedAt: "2026-08-14T14:00:00Z", lastObservedAt: "2026-08-14T14:00:00Z", occurrences: 1, message: "Probe failed.", active: true }], silence: null
    } as const;
    const list = {
      apiVersion: 1, mode: "live", assembledAt: "2026-08-14T14:00:00Z", environment: "all", statusFilter: "active",
      truncated: false,
      summary: { total: 1, active: 1, resolved: 0, unacknowledged: 1, silenced: 0 },
      alertSource: { name: "inventory-health-evaluator", availability: "available", evaluatedAt: "2026-08-14T14:00:00Z", message: null },
      notification: { state: "unconfigured", message: "No destination configured." },
      operator: { id: "lab-operator", identityMode: "configured-lab-operator" }, incidents: [incident]
    } as const;
    const detail = { apiVersion: 1, assembledAt: list.assembledAt, notification: list.notification, operator: list.operator, incident, audit: [] } as const;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(list), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...detail, incident: { ...incident, version: 2, acknowledgedAt: list.assembledAt, acknowledgedBy: "lab-operator" } }), { status: 200 }));
    const provider = createLiveMonitoringProvider({ fetchImpl, timeoutMs: 1000 });

    expect(await provider.getIncidents?.("all", "active")).toMatchObject({ summary: { active: 1 }, incidents: [{ id: "INC-000001" }] });
    await provider.declareIncident?.({ serviceId: "cpq-demo", title: "Operator declaration", severity: "P2", reason: "Confirmed impact" });
    await provider.transitionIncident?.("INC-000001", { action: "acknowledge", expectedVersion: 1, reason: "Taking command" });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/v1/incidents?environment=all&status=active", expect.objectContaining({ method: "GET" }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/v1/incidents", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ serviceId: "cpq-demo", title: "Operator declaration", severity: "P2", reason: "Confirmed impact" })
    }));
    const declarationRequest = fetchImpl.mock.calls[1] as unknown as readonly [string, RequestInit] | undefined;
    expect(declarationRequest?.[1].body).toBeTypeOf("string");
    expect(declarationRequest?.[1].body).not.toContain("actor");
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/v1/incidents/INC-000001/transitions", expect.objectContaining({ method: "POST" }));
  });

  it("rejects malformed incident responses without fixture fallback", async () => {
    const provider = createLiveMonitoringProvider({
      fetchImpl: (): Promise<Response> => Promise.resolve(new Response(JSON.stringify({ apiVersion: 1, incidents: [{}] }), { status: 200 })),
      timeoutMs: 1000
    });
    await expect(provider.getIncidents?.("all", "active")).rejects.toThrow("Incident API returned a malformed response");
  });

  it("does not expose Shared as a selectable incident environment", async () => {
    const fetchImpl = vi.fn((): Promise<Response> => Promise.resolve(new Response("{}", { status: 200 })));
    const live = createLiveMonitoringProvider({ fetchImpl, timeoutMs: 1000 });
    await expect(createFixtureMonitoringProvider().getIncidents?.("shared", "active")).rejects.toThrow("Unsupported incident filter");
    await expect(live.getIncidents?.("shared", "active")).rejects.toThrow("Unsupported incident filter");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
