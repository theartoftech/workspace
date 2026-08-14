import type { HealthState, InventorySnapshot, ServiceInventory } from "../../../shared/inventory";
import type { PerformanceMetric, PerformanceMetricId, PerformanceSnapshot, PerformanceUnit } from "../../../shared/performance";
import type { TopologyEdge, TopologyResource, TopologyResourceKind, TopologySnapshot } from "../../../shared/topology";
import { incidentFixtures, serviceFixtures, trafficFixtures } from "./fixtures";
import type { EnvironmentId, MonitoringProvider, OverviewSnapshot, TimeRange } from "./types";

const environments = new Set<EnvironmentId>(["all", "demo", "test", "portfolio", "shared"]);
const timeRanges = new Set<TimeRange>(["15m", "1h", "6h", "24h"]);
const healthStates = new Set<HealthState>(["healthy", "degraded", "failing", "unknown", "paused", "stale"]);
const performanceMetricIds = new Set<PerformanceMetricId>([
  "request-rate", "request-total", "error-rate", "latency-p50", "latency-p95", "latency-p99", "process-cpu",
  "system-cpu", "jvm-heap", "host-memory", "db-pool-saturation", "pod-restarts"
]);
const performanceUnits = new Set<PerformanceUnit>(["requests/s", "requests", "percent", "milliseconds", "restarts"]);
const topologyKinds = new Set<TopologyResourceKind>(["Node", "Namespace", "Deployment", "StatefulSet", "Pod", "Service", "PersistentVolumeClaim", "Ingress"]);

function validateFilters(environment: EnvironmentId, timeRange: TimeRange): void {
  if (!environments.has(environment)) throw new Error(`Unsupported environment: ${environment}`);
  if (!timeRanges.has(timeRange)) throw new Error(`Unsupported time range: ${timeRange}`);
}

function summarize(services: readonly ServiceInventory[]): OverviewSnapshot["summary"] {
  const count = (state: HealthState): number => services.filter((service) => service.state === state).length;
  return {
    total: services.length,
    healthy: count("healthy"),
    degraded: count("degraded"),
    failing: count("failing"),
    unknown: count("unknown"),
    paused: count("paused"),
    stale: count("stale")
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isService(value: unknown): value is ServiceInventory {
  const raw = record(value);
  const reachability = record(raw?.reachability);
  return raw !== null
    && typeof raw.id === "string"
    && typeof raw.name === "string"
    && ["application", "identity", "mail", "erp"].includes(String(raw.kind))
    && ["demo", "test", "portfolio", "shared"].includes(String(raw.environment))
    && typeof raw.owner === "string"
    && healthStates.has(raw.state as HealthState)
    && (typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null)
    && (typeof raw.version === "string" || raw.version === null)
    && typeof raw.endpoint === "string"
    && reachability !== null
    && Array.isArray(raw.probes)
    && Array.isArray(raw.workloads)
    && Array.isArray(raw.sourceLinks);
}

function parseInventory(value: unknown): InventorySnapshot {
  const raw = record(value);
  const summary = record(raw?.summary);
  if (raw === null
    || raw.apiVersion !== 1
    || (raw.mode !== "live" && raw.mode !== "partial")
    || typeof raw.assembledAt !== "string"
    || (typeof raw.lastObservedAt !== "string" && raw.lastObservedAt !== null)
    || !environments.has(raw.environment as EnvironmentId)
    || summary === null
    || !Array.isArray(raw.services)
    || !raw.services.every(isService)
    || !Array.isArray(raw.sources)) {
    throw new Error("Inventory API returned a malformed response");
  }
  for (const key of ["total", "healthy", "degraded", "failing", "unknown", "paused", "stale"] as const) {
    if (!Number.isInteger(summary[key])) throw new Error("Inventory API returned a malformed response");
  }
  return value as InventorySnapshot;
}

function isPerformanceMetric(value: unknown): value is PerformanceMetric {
  const raw = record(value);
  if (raw === null
    || !performanceMetricIds.has(raw.id as PerformanceMetricId)
    || typeof raw.label !== "string"
    || !performanceUnits.has(raw.unit as PerformanceUnit)
    || !["ok", "no-data", "error"].includes(String(raw.status))
    || !Array.isArray(raw.points)
    || !(raw.latest === null || typeof raw.latest === "number" && Number.isFinite(raw.latest))
    || !(raw.threshold === null || typeof raw.threshold === "number" && Number.isFinite(raw.threshold))
    || !(raw.message === null || typeof raw.message === "string")) return false;
  return raw.points.every((point) => {
    const parsed = record(point);
    return parsed !== null
      && typeof parsed.timestamp === "string"
      && !Number.isNaN(new Date(parsed.timestamp).getTime())
      && typeof parsed.value === "number"
      && Number.isFinite(parsed.value);
  });
}

function parsePerformance(value: unknown): PerformanceSnapshot {
  const raw = record(value);
  const window = record(raw?.window);
  const source = record(raw?.source);
  if (raw === null
    || raw.apiVersion !== 1
    || !["live", "partial"].includes(String(raw.mode))
    || typeof raw.assembledAt !== "string"
    || !(raw.observedAt === null || typeof raw.observedAt === "string")
    || !environments.has(raw.environment as EnvironmentId)
    || typeof raw.serviceId !== "string"
    || window === null
    || !timeRanges.has(window.range as TimeRange)
    || typeof window.start !== "string"
    || typeof window.end !== "string"
    || !Number.isInteger(window.stepSeconds)
    || !Number.isInteger(window.maxPoints)
    || source === null
    || source.name !== "prometheus"
    || !["available", "partial", "unavailable"].includes(String(source.availability))
    || !(source.message === null || typeof source.message === "string")
    || !Array.isArray(raw.metrics)
    || !raw.metrics.every(isPerformanceMetric)) {
    throw new Error("Performance API returned a malformed response");
  }
  return value as PerformanceSnapshot;
}

function isTopologyResource(value: unknown): value is TopologyResource {
  const raw = record(value);
  return raw !== null
    && typeof raw.id === "string"
    && topologyKinds.has(raw.kind as TopologyResourceKind)
    && (typeof raw.namespace === "string" || raw.namespace === null)
    && typeof raw.name === "string"
    && healthStates.has(raw.state as HealthState)
    && typeof raw.summary === "string"
    && (typeof raw.issueCode === "string" || raw.issueCode === null)
    && Array.isArray(raw.serviceIds)
    && raw.serviceIds.every((id) => typeof id === "string")
    && (typeof raw.nodeName === "string" || raw.nodeName === null)
    && (typeof raw.restarts === "number" || raw.restarts === null)
    && (typeof raw.capacity === "string" || raw.capacity === null)
    && (raw.sourceLabel === "Kubernetes" || raw.sourceLabel === "Catalog")
    && typeof raw.sourceToolUrl === "string"
    && Array.isArray(raw.events);
}

function parseTopology(value: unknown): TopologySnapshot {
  const raw = record(value); const source = record(raw?.source);
  if (raw === null || raw.apiVersion !== 1 || !["live", "partial"].includes(String(raw.mode))
    || typeof raw.assembledAt !== "string" || !environments.has(raw.environment as EnvironmentId)
    || !Array.isArray(raw.namespaces) || !raw.namespaces.every((item) => typeof item === "string")
    || typeof raw.truncated !== "boolean" || !Array.isArray(raw.resources) || !raw.resources.every(isTopologyResource)
    || !Array.isArray(raw.edges) || source === null || source.name !== "kubernetes"
    || !["available", "unavailable"].includes(String(source.availability))
    || !(source.message === null || typeof source.message === "string")) throw new Error("Topology API returned a malformed response");
  return value as TopologySnapshot;
}

function fixtureTopology(environment: EnvironmentId): TopologySnapshot {
  const services = environment === "all" ? serviceFixtures : serviceFixtures.filter((service) => service.environment === environment);
  const resources: TopologyResource[] = services.map((service, index) => ({
    id: `Deployment:${service.environment}:${service.id}`, kind: "Deployment", namespace: service.environment, name: service.id,
    state: service.state, summary: service.state === "healthy" ? "1/1 replicas ready" : "0/1 replicas ready",
    issueCode: service.state === "healthy" ? null : "pending", serviceIds: [service.id], nodeName: null, restarts: index === 1 ? 2 : 0,
    capacity: null, sourceLabel: "Kubernetes", sourceToolUrl: `/tools/kubernetes/namespaces/${service.environment}/deployment/${service.id}`, events: []
  }));
  const edges: TopologyEdge[] = services.flatMap((service) => [
    { from: `service:${service.id}`, to: `Deployment:${service.environment}:${service.id}`, relation: "runs-as" as const },
    { from: "platform:prometheus", to: `service:${service.id}`, relation: "observes" as const }
  ]);
  if (services.some((service) => service.id === "cpq-demo") && services.some((service) => service.id === "mailpit")) edges.push({ from: "service:cpq-demo", to: "service:mailpit", relation: "depends-on" });
  return { apiVersion: 1, mode: "live", assembledAt: "2026-08-14T10:00:00Z", environment, namespaces: [...new Set(resources.map((resource) => resource.namespace).filter((item): item is string => item !== null))], truncated: false, resources, edges, source: { name: "kubernetes", availability: "available", message: null } };
}

function fixturePerformance(environment: EnvironmentId, serviceId: string, range: TimeRange): PerformanceSnapshot {
  const points = trafficFixtures.map((point, index) => ({
    timestamp: new Date(Date.parse("2026-08-12T14:20:00Z") + index * 300_000).toISOString(),
    value: point.requests / 60
  }));
  const metric = (id: PerformanceMetricId, label: string, unit: PerformanceUnit, values = points): PerformanceMetric => ({
    id, label, unit, status: "ok", points: values, latest: values.at(-1)?.value ?? null, threshold: null, message: null
  });
  return {
    apiVersion: 1,
    mode: "live",
    assembledAt: "2026-08-12T15:15:00Z",
    observedAt: points.at(-1)?.timestamp ?? null,
    environment,
    serviceId,
    window: { range, start: points[0]?.timestamp ?? "2026-08-12T14:15:00Z", end: "2026-08-12T15:15:00Z", stepSeconds: 300, maxPoints: 13 },
    source: { name: "prometheus", availability: "available", message: null },
    metrics: [
      metric("request-rate", "Request rate", "requests/s"),
      metric("request-total", "Requests in selected window", "requests", points.map((point, index) => ({ ...point, value: index * 24 }))),
      metric("error-rate", "Server error rate", "percent", points.map((point) => ({ ...point, value: 0.2 }))),
      metric("latency-p50", "Synthetic latency p50", "milliseconds", points.map((point) => ({ ...point, value: 18 }))),
      metric("latency-p95", "Synthetic latency p95", "milliseconds", points.map((point) => ({ ...point, value: 42 }))),
      metric("latency-p99", "Synthetic latency p99", "milliseconds", points.map((point) => ({ ...point, value: 55 }))),
      metric("process-cpu", "Application process CPU", "percent", points.map((point) => ({ ...point, value: 8 }))),
      metric("system-cpu", "Application host CPU", "percent", points.map((point) => ({ ...point, value: 22 }))),
      metric("jvm-heap", "JVM heap utilization", "percent", points.map((point) => ({ ...point, value: 48 }))),
      metric("host-memory", "Lab host memory utilization", "percent", points.map((point) => ({ ...point, value: 62 }))),
      metric("db-pool-saturation", "Database pool saturation", "percent", points.map((point) => ({ ...point, value: 20 }))),
      metric("pod-restarts", "Pod restarts", "restarts", points.map((point) => ({ ...point, value: 0 })))
    ]
  };
}

export function createFixtureMonitoringProvider(): MonitoringProvider {
  return {
    getOverview(environment: EnvironmentId, timeRange: TimeRange): Promise<OverviewSnapshot> {
      return Promise.resolve().then(() => {
        validateFilters(environment, timeRange);
        const services = environment === "all" ? serviceFixtures : serviceFixtures.filter((service) => service.environment === environment);
        return {
          mode: "fixture",
          generatedAt: "2026-08-12T15:15:00Z",
          lastObservedAt: "2026-08-12T15:14:42Z",
          environment,
          timeRange,
          summary: summarize(services),
          services,
          sources: [{ source: "catalog", availability: "available", observedAt: null, toolUrl: null, message: null }],
          incidents: incidentFixtures,
          traffic: trafficFixtures
        } as const;
      });
    },
    getPerformance(environment: EnvironmentId, serviceId: string, timeRange: TimeRange): Promise<PerformanceSnapshot> {
      return Promise.resolve().then(() => {
        validateFilters(environment, timeRange);
        return fixturePerformance(environment, serviceId, timeRange);
      });
    },
    getTopology(environment: EnvironmentId): Promise<TopologySnapshot> {
      return Promise.resolve().then(() => { if (!environments.has(environment)) throw new Error(`Unsupported environment: ${environment}`); return fixtureTopology(environment); });
    }
  };
}

export interface LiveMonitoringProviderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createLiveMonitoringProvider(options: LiveMonitoringProviderOptions = {}): MonitoringProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error("Live provider timeoutMs must be 100..30000");
  async function fetchJson(path: string, label: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(path, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
    } catch (cause: unknown) {
      if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs} ms`);
      throw new Error(`${label} request failed: ${cause instanceof Error ? cause.message : "unknown error"}`);
    } finally {
      window.clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    try {
      return await response.json() as unknown;
    } catch {
      throw new Error(`${label} returned malformed JSON`);
    }
  }
  return {
    async getOverview(environment: EnvironmentId, timeRange: TimeRange): Promise<OverviewSnapshot> {
      validateFilters(environment, timeRange);
      const payload = await fetchJson(`/api/v1/inventory?environment=${encodeURIComponent(environment)}`, "Inventory API");
      const inventory = parseInventory(payload);
      return {
        mode: inventory.mode,
        generatedAt: inventory.assembledAt,
        lastObservedAt: inventory.lastObservedAt,
        environment: inventory.environment,
        timeRange,
        summary: inventory.summary,
        services: inventory.services,
        sources: inventory.sources,
        incidents: incidentFixtures,
        traffic: trafficFixtures
      };
    },
    async getPerformance(environment: EnvironmentId, serviceId: string, timeRange: TimeRange): Promise<PerformanceSnapshot> {
      validateFilters(environment, timeRange);
      const path = `/api/v1/performance?environment=${encodeURIComponent(environment)}&service=${encodeURIComponent(serviceId)}&range=${encodeURIComponent(timeRange)}`;
      return parsePerformance(await fetchJson(path, "Performance API"));
    },
    async getTopology(environment: EnvironmentId): Promise<TopologySnapshot> {
      if (!environments.has(environment)) throw new Error(`Unsupported environment: ${environment}`);
      return parseTopology(await fetchJson(`/api/v1/topology?environment=${encodeURIComponent(environment)}`, "Topology API"));
    }
  };
}
