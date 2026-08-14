import { describe, expect, it } from "vitest";

import type { InventorySnapshot } from "../../shared/inventory";
import type { LogCorrelationSnapshot, LogQuery } from "../../shared/logs";
import type { DeclareIncidentCommand, IncidentDetailResponse, IncidentListResponse, IncidentSummary, IncidentTransitionCommand } from "../../shared/incidents";
import type { PerformanceSnapshot } from "../../shared/performance";
import type { TopologySnapshot } from "../../shared/topology";
import { createInventoryHttpServer, handleInventoryRequest, safeNodeRequestMethod, type IncidentOperations, type InventoryReader, type PerformanceReader } from "../src/api";
import { IncidentRequestError } from "../src/incidents";
import { InventoryAggregator } from "../src/inventory";
import { LogRequestError, type LogReader } from "../src/logs";
import { PerformanceRequestError } from "../src/prometheus";
import type { TopologyReader } from "../src/topology";
import { catalogFixture } from "./fixtures";

const reader = new InventoryAggregator(catalogFixture, [], () => new Date("2026-08-13T01:00:00Z"));

const performanceSnapshot: PerformanceSnapshot = {
  apiVersion: 1,
  mode: "live",
  assembledAt: "2026-08-13T18:00:00.000Z",
  observedAt: "2026-08-13T18:00:00.000Z",
  environment: "demo",
  serviceId: "cpq-demo",
  window: { range: "1h", start: "2026-08-13T17:00:00.000Z", end: "2026-08-13T18:00:00.000Z", stepSeconds: 60, maxPoints: 61 },
  source: { name: "prometheus", availability: "available", message: null },
  metrics: []
};
const performanceReader: PerformanceReader = {
  async getPerformance(environment, serviceId, range): Promise<PerformanceSnapshot> {
    if (serviceId === "missing") throw new PerformanceRequestError("Unsupported service: missing");
    return { ...performanceSnapshot, environment: environment as "demo", serviceId, window: { ...performanceSnapshot.window, range: range as "1h" } };
  }
};
const topologyReader: TopologyReader = {
  async getTopology(environment): Promise<TopologySnapshot> {
    return { apiVersion: 1, mode: "live", assembledAt: "2026-08-14T10:00:00Z", environment: environment as "demo", namespaces: ["default"], truncated: false, resources: [], edges: [], source: { name: "kubernetes", availability: "available", message: null } };
  }
};

const incidentSummary: IncidentSummary = {
  id: "INC-000001", version: 1, title: "CPQ Demo is failing", description: "Live alert", serviceId: "cpq-demo",
  serviceName: "CPQ Demo", environment: "demo", severity: "P1", status: "active", startedAt: "2026-08-14T14:00:00Z",
  lastObservedAt: "2026-08-14T14:00:00Z", updatedAt: "2026-08-14T14:00:00Z", resolvedAt: null,
  acknowledgedAt: null, acknowledgedBy: null, declaredAt: null, declaredBy: null, assignee: "Unassigned", owner: "Development Lab",
  alertActive: true, recoveredAt: null, runbook: { id: "cpq-demo-incident-response", title: "CPQ Demo response", steps: ["Confirm evidence."] },
  evidence: [], silence: null
};
const incidentList: IncidentListResponse = {
  apiVersion: 1, mode: "live", assembledAt: "2026-08-14T14:00:00Z", environment: "all", statusFilter: "active",
  truncated: false,
  summary: { total: 1, active: 1, resolved: 0, unacknowledged: 1, silenced: 0 },
  alertSource: { name: "inventory-health-evaluator", availability: "available", evaluatedAt: "2026-08-14T14:00:00Z", message: null },
  notification: { state: "unconfigured", message: "No destination configured." },
  operator: { id: "lab-operator", identityMode: "configured-lab-operator" }, incidents: [incidentSummary]
};
const incidentDetail: IncidentDetailResponse = {
  apiVersion: 1, assembledAt: "2026-08-14T14:00:00Z", notification: incidentList.notification, operator: incidentList.operator,
  incident: incidentSummary, audit: []
};
const incidentOperations: IncidentOperations = {
  list(environment, statusFilter): Promise<IncidentListResponse> {
    return Promise.resolve({ ...incidentList, environment: environment as "all", statusFilter: statusFilter as "active" });
  },
  getDetail(): Promise<IncidentDetailResponse> { return Promise.resolve(incidentDetail); },
  declare(command: DeclareIncidentCommand): Promise<IncidentDetailResponse> {
    return Promise.resolve({ ...incidentDetail, incident: { ...incidentSummary, title: command.title, severity: command.severity } });
  },
  transition(_id: string, command: IncidentTransitionCommand): Promise<IncidentDetailResponse> {
    return Promise.resolve({ ...incidentDetail, incident: { ...incidentSummary, version: command.expectedVersion + 1 } });
  }
};

const logSnapshot: LogCorrelationSnapshot = {
  apiVersion: 1, mode: "live", assembledAt: "2026-08-14T17:00:00.000Z",
  service: { id: "cpq-demo", name: "CPQ Demo", environment: "demo" },
  window: { range: "1h", start: "2026-08-14T16:00:00.000Z", end: "2026-08-14T17:00:00.000Z" },
  filters: { environment: "demo", serviceId: "cpq-demo", range: "1h", pod: null, severity: "all", queryApplied: false, correlationIdApplied: false },
  limits: { maxPods: 8, maxStreams: 16, maxEntries: 500, maxEventsPerObject: 5, maxEvents: 50 }, truncated: false,
  pods: [], entries: [], events: [],
  sources: [{ name: "kubernetes-pod-logs", availability: "available", message: null }, { name: "kubernetes-events", availability: "available", message: null }],
  omissions: [], redaction: { applied: true, replacement: "[REDACTED]", description: "Secrets are redacted." }
};
const logReader: LogReader = {
  getLogs(query: LogQuery): Promise<LogCorrelationSnapshot> {
    if (query.serviceId === "missing") return Promise.reject(new LogRequestError("Unsupported service: missing"));
    return Promise.resolve({ ...logSnapshot, service: { ...logSnapshot.service, id: query.serviceId }, window: { ...logSnapshot.window, range: query.range }, filters: { environment: query.environment, serviceId: query.serviceId, range: query.range, pod: query.pod, severity: query.severity, queryApplied: query.query !== "", correlationIdApplied: query.correlationId !== "" } });
  }
};

function request(
  path: string,
  method = "GET",
  inventoryReader: InventoryReader = reader,
  metricsReader: PerformanceReader = performanceReader,
  incidents: IncidentOperations = incidentOperations,
  body?: string
): Promise<Response> {
  return handleInventoryRequest(new Request(`http://inventory-api.local${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body
  }), inventoryReader, metricsReader, topologyReader, incidents, logReader);
}

describe("read-only inventory API", () => {
  it("serves health and filtered inventory with no-store headers", async () => {
    const health = await request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "healthy" });

    const response = await request("/api/v1/inventory?environment=demo");
    const body = await response.json() as InventorySnapshot;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.environment).toBe("demo");
    expect(body.services.map((service) => service.id)).toEqual(["cpq-demo"]);
  });

  it("returns a service detail envelope with source status", async () => {
    const response = await request("/api/v1/services/cpq-demo");
    const body = await response.json() as { readonly service: { readonly id: string }; readonly sources: readonly unknown[] };

    expect(response.status).toBe(200);
    expect(body.service.id).toBe("cpq-demo");
    expect(body.sources.length).toBeGreaterThan(0);
  });

  it("serves performance only through bounded allow-listed filters", async () => {
    const response = await request("/api/v1/performance?environment=demo&service=cpq-demo&range=1h");
    const body = await response.json() as PerformanceSnapshot;

    expect(response.status).toBe(200);
    expect(body.serviceId).toBe("cpq-demo");
    expect(body.window.range).toBe("1h");

    for (const path of [
      "/api/v1/performance?environment=production",
      "/api/v1/performance?range=30d",
      "/api/v1/performance?service=missing",
      "/api/v1/performance?query=up",
      "/api/v1/performance?promql=up"
    ]) {
      const invalid = await request(path);
      expect(invalid.status).toBe(400);
    }
  });

  it("serves topology through an allow-listed environment filter", async () => {
    const response = await request("/api/v1/topology?environment=demo");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ apiVersion: 1, environment: "demo", namespaces: ["default"] });
    expect((await request("/api/v1/topology?environment=production")).status).toBe(400);
    expect((await request("/api/v1/topology?query=pods")).status).toBe(400);
  });

  it("serves bounded correlated logs only through strict allow-listed filters", async () => {
    const response = await request("/api/v1/logs?environment=demo&service=cpq-demo&range=1h&pod=application-a&severity=error&query=timeout&correlationId=req-42");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      apiVersion: 1,
      filters: { environment: "demo", serviceId: "cpq-demo", range: "1h", pod: "application-a", severity: "error", queryApplied: true, correlationIdApplied: true }
    });

    for (const path of [
      "/api/v1/logs",
      "/api/v1/logs?service=missing",
      "/api/v1/logs?service=cpq-demo&environment=shared",
      "/api/v1/logs?service=cpq-demo&range=30d",
      "/api/v1/logs?service=cpq-demo&severity=fatal",
      "/api/v1/logs?service=cpq-demo&promql=up",
      "/api/v1/logs?service=cpq-demo&service=mailpit"
    ]) expect((await request(path)).status).toBe(400);

    const head = await request("/api/v1/logs?service=cpq-demo", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("serves bounded incident lists and detail through explicit filters", async () => {
    const response = await request("/api/v1/incidents?environment=demo&status=active");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ apiVersion: 1, environment: "demo", statusFilter: "active" });

    const detail = await request("/api/v1/incidents/INC-000001");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ incident: { id: "INC-000001" }, audit: [] });

    expect((await request("/api/v1/incidents?environment=production")).status).toBe(400);
    expect((await request("/api/v1/incidents?environment=shared")).status).toBe(400);
    expect((await request("/api/v1/incidents?status=deleted")).status).toBe(400);
    expect((await request("/api/v1/incidents?query=arbitrary")).status).toBe(400);
  });

  it("allows strict JSON writes only on the incident command surface", async () => {
    const declaration = await request("/api/v1/incidents", "POST", reader, performanceReader, incidentOperations, JSON.stringify({
      serviceId: "cpq-demo", title: "Persistent declaration", severity: "P2", reason: "Operator confirmed impact"
    }));
    expect(declaration.status).toBe(201);
    expect(await declaration.json()).toMatchObject({ incident: { title: "Persistent declaration", severity: "P2" } });

    const transition = await request("/api/v1/incidents/INC-000001/transitions", "POST", reader, performanceReader, incidentOperations, JSON.stringify({
      action: "acknowledge", expectedVersion: 1, reason: "Taking command"
    }));
    expect(transition.status).toBe(200);
    expect(await transition.json()).toMatchObject({ incident: { version: 2 } });

    expect((await request("/api/v1/inventory", "POST", reader, performanceReader, incidentOperations, "{}")).status).toBe(405);
    expect((await request("/api/v1/incidents", "DELETE")).status).toBe(405);
    expect((await request("/api/v1/incidents", "POST", reader, performanceReader, incidentOperations, "not-json")).status).toBe(400);
    expect((await request("/api/v1/incidents", "POST", reader, performanceReader, incidentOperations, JSON.stringify({
      serviceId: "cpq-demo", title: "Unexpected", severity: "P2", reason: "Rejected field", actor: "browser-chosen"
    }))).status).toBe(400);
    expect((await request("/api/v1/incidents", "POST", reader, performanceReader, incidentOperations, JSON.stringify({ value: "x".repeat(17_000) }))).status).toBe(413);
  });

  it("redacts unexpected incident failures while preserving explicit request errors", async () => {
    const failing: IncidentOperations = {
      ...incidentOperations,
      list(): Promise<IncidentListResponse> { return Promise.reject(new Error("token=must-not-leak")); }
    };
    const response = await request("/api/v1/incidents", "GET", reader, performanceReader, failing);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(JSON.stringify({ error: { code: "incidents_unavailable", message: "Incident operations could not be completed." } }));

    const rejected: IncidentOperations = {
      ...incidentOperations,
      getDetail(): Promise<IncidentDetailResponse> {
        return Promise.reject(new IncidentRequestError("incident_not_found", 404, "The requested incident does not exist."));
      }
    };
    const missing = await request("/api/v1/incidents/INC-000099", "GET", reader, performanceReader, rejected);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "incident_not_found", message: "The requested incident does not exist." } });
  });

  it("rejects malformed incident commands, ambiguous routes, and browser-selected fields", async () => {
    const noContentType = await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/incidents", {
      method: "POST",
      body: JSON.stringify({ serviceId: "cpq-demo", title: "Missing media type", severity: "P2", reason: "Must be rejected" })
    }), reader, performanceReader, topologyReader, incidentOperations);
    expect(noContentType.status).toBe(400);
    const misleadingContentType = await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json-patch+json" },
      body: JSON.stringify({ serviceId: "cpq-demo", title: "Wrong media type", severity: "P2", reason: "Must be rejected" })
    }), reader, performanceReader, topologyReader, incidentOperations);
    expect(misleadingContentType.status).toBe(400);

    for (const body of [
      "[]",
      JSON.stringify({ serviceId: "cpq-demo", title: "Missing reason", severity: "P2" })
    ]) {
      expect((await request("/api/v1/incidents", "POST", reader, performanceReader, incidentOperations, body)).status).toBe(400);
    }

    expect((await request("/api/v1/incidents?environment=demo", "POST", reader, performanceReader, incidentOperations, JSON.stringify({
      serviceId: "cpq-demo", title: "Query ambiguity", severity: "P2", reason: "Must be rejected"
    }))).status).toBe(400);
    expect((await request("/api/v1/incidents/INC-000001?status=active")).status).toBe(400);
    expect((await request("/api/v1/incidents/INC-000001/transitions", "GET")).status).toBe(405);
    expect((await request("/api/v1/incidents/INC-000001", "POST", reader, performanceReader, incidentOperations, "{}")).status).toBe(405);

    expect((await request("/api/v1/incidents/INC-000001/transitions", "POST", reader, performanceReader, incidentOperations, JSON.stringify({
      action: "silence", expectedVersion: 1, reason: "Invalid duration", durationMinutes: 12.5
    }))).status).toBe(400);
    expect((await request("/api/v1/incidents/INC-000001/transitions", "POST", reader, performanceReader, incidentOperations, JSON.stringify({
      action: "acknowledge", expectedVersion: Number.MAX_SAFE_INTEGER + 1, reason: "Unsafe version"
    }))).status).toBe(400);
    const silence = await request("/api/v1/incidents/INC-000001/transitions", "POST", reader, performanceReader, incidentOperations, JSON.stringify({
      action: "silence", expectedVersion: 1, reason: "Bounded maintenance", durationMinutes: 15
    }));
    expect(silence.status).toBe(200);
  });

  it("reports optional API capabilities as unavailable without affecting health", async () => {
    const base = new Request("http://inventory-api.local/api/v1/incidents");
    expect((await handleInventoryRequest(base, reader, performanceReader, topologyReader)).status).toBe(503);
    expect((await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/performance"), reader)).status).toBe(503);
    expect((await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/topology"), reader, performanceReader)).status).toBe(503);
    expect((await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/logs?service=cpq-demo"), reader, performanceReader, topologyReader, incidentOperations)).status).toBe(503);

    const unavailableTopology: TopologyReader = {
      async getTopology(): Promise<TopologySnapshot> { throw new Error("token=must-not-leak"); }
    };
    const topology = await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/topology"), reader, performanceReader, unavailableTopology);
    expect(topology.status).toBe(500);
    expect(await topology.text()).not.toContain("must-not-leak");
  });

  it("does not leak unexpected Prometheus errors", async () => {
    const failingPerformanceReader: PerformanceReader = {
      async getPerformance(): Promise<PerformanceSnapshot> {
        throw new Error("Prometheus authorization=Bearer super-secret");
      }
    };
    const response = await request("/api/v1/performance", "GET", reader, failingPerformanceReader);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("Performance telemetry could not be assembled");
    expect(body).not.toContain("super-secret");
  });

  it("does not leak unexpected Kubernetes log errors", async () => {
    const failing: LogReader = { getLogs(): Promise<LogCorrelationSnapshot> { return Promise.reject(new Error("authorization=Bearer super-secret")); } };
    const response = await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/logs?service=cpq-demo"), reader, performanceReader, topologyReader, incidentOperations, failing);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Log correlation could not be assembled");
    expect(body).not.toContain("super-secret");
  });

  it("rejects writes, unsupported filters, and missing services explicitly", async () => {
    const write = await request("/api/v1/inventory", "POST");
    expect(write.status).toBe(405);
    expect(write.headers.get("allow")).toBe("GET, HEAD");

    const invalid = await request("/api/v1/inventory?environment=production");
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("Unsupported environment");

    const missing = await request("/api/v1/services/not-real");
    expect(missing.status).toBe(404);
  });

  it("supports HEAD and does not expose unexpected server errors", async () => {
    const head = await request("/api/v1/inventory", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const failingReader: InventoryReader = {
      async getInventory(): Promise<InventorySnapshot> {
        throw new Error("authorization=Bearer super-secret");
      }
    };
    const response = await request("/api/v1/inventory", "GET", failingReader);
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toContain("Inventory could not be assembled");
    expect(body).not.toContain("super-secret");
  });

  it("runs the Node server adapter and enforces the wire body limit", async () => {
    const server = createInventoryHttpServer(reader, performanceReader, topologyReader, incidentOperations);
    expect(server.listening).toBe(false);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Test server did not expose a TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const declaration = await fetch(`${base}/api/v1/incidents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: "cpq-demo", title: "Wire declaration", severity: "P2", reason: "Adapter test" })
      });
      expect(declaration.status).toBe(201);

      const oversized = await fetch(`${base}/api/v1/incidents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(17_000) })
      });
      expect(oversized.status).toBe(413);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }

    const missing = await request("/api/v2/inventory");
    expect(missing.status).toBe(404);
  });

  it("normalizes forbidden Node HTTP methods to a safe 405 request", () => {
    expect(safeNodeRequestMethod("GET")).toBe("GET");
    expect(safeNodeRequestMethod("HEAD")).toBe("HEAD");
    expect(safeNodeRequestMethod("POST")).toBe("POST");
    expect(safeNodeRequestMethod("TRACE")).toBe("DELETE");
    expect(safeNodeRequestMethod(undefined)).toBe("GET");
  });
});
