import type { HealthState, InventorySnapshot, ServiceInventory } from "../../../shared/inventory";
import type {
  DeclareIncidentCommand,
  IncidentAuditAction,
  IncidentAuditEvent,
  IncidentDetailResponse,
  IncidentListResponse,
  IncidentSeverity,
  IncidentStatus,
  IncidentStatusFilter,
  IncidentSummary,
  IncidentTransitionCommand
} from "../../../shared/incidents";
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
const incidentEnvironments = new Set<EnvironmentId>(["all", "demo", "test", "portfolio"]);
const incidentSeverities = new Set<IncidentSeverity>(["P1", "P2", "P3"]);
const incidentStatuses = new Set<IncidentStatus>(["active", "resolved"]);
const incidentStatusFilters = new Set<IncidentStatusFilter>(["active", "resolved", "all"]);
const incidentAuditActions = new Set<IncidentAuditAction>(["created", "acknowledged", "declared", "silenced", "silence_expired", "resolved", "reopened", "alert_recurred", "alert_updated", "condition_recovered"]);

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

function timestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestamp(value);
}

function isIncident(value: unknown): value is IncidentSummary {
  const raw = record(value);
  const runbook = record(raw?.runbook);
  const silence = raw?.silence === null ? null : record(raw?.silence);
  return raw !== null
    && typeof raw.id === "string" && /^INC-[0-9]{6}$/u.test(raw.id)
    && Number.isSafeInteger(raw.version) && Number(raw.version) >= 1
    && typeof raw.title === "string" && typeof raw.description === "string"
    && typeof raw.serviceId === "string" && typeof raw.serviceName === "string"
    && ["demo", "test", "portfolio", "shared"].includes(String(raw.environment))
    && incidentSeverities.has(raw.severity as IncidentSeverity)
    && incidentStatuses.has(raw.status as IncidentStatus)
    && timestamp(raw.startedAt) && timestamp(raw.lastObservedAt) && timestamp(raw.updatedAt)
    && nullableTimestamp(raw.resolvedAt) && nullableTimestamp(raw.acknowledgedAt) && nullableTimestamp(raw.declaredAt) && nullableTimestamp(raw.recoveredAt)
    && (raw.acknowledgedBy === null || typeof raw.acknowledgedBy === "string")
    && (raw.declaredBy === null || typeof raw.declaredBy === "string")
    && typeof raw.assignee === "string" && typeof raw.owner === "string" && typeof raw.alertActive === "boolean"
    && runbook !== null && typeof runbook.id === "string" && typeof runbook.title === "string"
    && Array.isArray(runbook.steps) && runbook.steps.every((step) => typeof step === "string")
    && Array.isArray(raw.evidence) && raw.evidence.every((item) => {
      const evidence = record(item);
      return evidence !== null && typeof evidence.source === "string"
        && [...healthStates, "operator"].includes(String(evidence.state))
        && timestamp(evidence.firstObservedAt) && timestamp(evidence.lastObservedAt)
        && Number.isInteger(evidence.occurrences) && Number(evidence.occurrences) >= 1
        && typeof evidence.message === "string" && typeof evidence.active === "boolean";
    })
    && (silence === null || timestamp(silence.createdAt) && timestamp(silence.expiresAt)
      && typeof silence.createdBy === "string" && typeof silence.reason === "string" && typeof silence.active === "boolean");
}

function isIncidentEnvelope(value: unknown): boolean {
  const raw = record(value); const notification = record(raw?.notification); const operator = record(raw?.operator);
  return raw !== null && notification !== null && notification.state === "unconfigured" && typeof notification.message === "string"
    && operator !== null && typeof operator.id === "string" && operator.identityMode === "configured-lab-operator";
}

function parseIncidentList(value: unknown): IncidentListResponse {
  const raw = record(value); const summary = record(raw?.summary); const source = record(raw?.alertSource);
  if (raw === null || raw.apiVersion !== 1 || !["live", "partial"].includes(String(raw.mode)) || !timestamp(raw.assembledAt)
    || !environments.has(raw.environment as EnvironmentId) || !incidentStatusFilters.has(raw.statusFilter as IncidentStatusFilter) || typeof raw.truncated !== "boolean"
    || summary === null || !["total", "active", "resolved", "unacknowledged", "silenced"].every((key) => Number.isInteger(summary[key]) && Number(summary[key]) >= 0)
    || source === null || source.name !== "inventory-health-evaluator" || !["available", "unavailable"].includes(String(source.availability))
    || !nullableTimestamp(source.evaluatedAt) || !(source.message === null || typeof source.message === "string")
    || !isIncidentEnvelope(raw) || !Array.isArray(raw.incidents) || !raw.incidents.every(isIncident) || raw.incidents.length > 100) {
    throw new Error("Incident API returned a malformed response");
  }
  return value as IncidentListResponse;
}

function isAudit(value: unknown): value is IncidentAuditEvent {
  const raw = record(value);
  return raw !== null && Number.isSafeInteger(raw.id) && Number(raw.id) >= 1
    && incidentAuditActions.has(raw.action as IncidentAuditAction) && typeof raw.actor === "string" && typeof raw.reason === "string"
    && timestamp(raw.createdAt) && (raw.fromStatus === null || incidentStatuses.has(raw.fromStatus as IncidentStatus))
    && incidentStatuses.has(raw.toStatus as IncidentStatus) && Number.isSafeInteger(raw.version) && Number(raw.version) >= 1;
}

function parseIncidentDetail(value: unknown): IncidentDetailResponse {
  const raw = record(value);
  if (raw === null || raw.apiVersion !== 1 || !timestamp(raw.assembledAt) || !isIncidentEnvelope(raw)
    || !isIncident(raw.incident) || !Array.isArray(raw.audit) || raw.audit.length > 100 || !raw.audit.every(isAudit)) {
    throw new Error("Incident API returned a malformed response");
  }
  return value as IncidentDetailResponse;
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
  let incidents: readonly IncidentSummary[] = incidentFixtures.map((incident) => ({ ...incident, evidence: [...incident.evidence], runbook: { ...incident.runbook, steps: [...incident.runbook.steps] } }));
  const audit = new Map<string, IncidentAuditEvent[]>(incidents.map((incident) => [incident.id, [{
    id: 1,
    action: "created",
    actor: "system:fixture",
    reason: "Deterministic incident fixture.",
    createdAt: incident.startedAt,
    fromStatus: null,
    toStatus: "active",
    version: 1
  }]]));
  const operator = { id: "J. Haynes", identityMode: "configured-lab-operator" } as const;
  const fixtureNotification = { state: "unconfigured", message: "Notification delivery is not configured in the deterministic fixture provider." } as const;
  function detail(id: string): IncidentDetailResponse {
    const incident = incidents.find((item) => item.id === id);
    if (incident === undefined) throw new Error("The requested fixture incident does not exist");
    return { apiVersion: 1, assembledAt: "2026-08-12T15:15:00Z", notification: fixtureNotification, operator, incident, audit: audit.get(id) ?? [] };
  }
  function incidentList(environment: EnvironmentId, statusFilter: IncidentStatusFilter): IncidentListResponse {
    const filtered = incidents.filter((incident) => (environment === "all" || incident.environment === environment) && (statusFilter === "all" || incident.status === statusFilter));
    return {
      apiVersion: 1, mode: "live", assembledAt: "2026-08-12T15:15:00Z", environment, statusFilter, truncated: false,
      summary: {
        total: filtered.length,
        active: filtered.filter((incident) => incident.status === "active").length,
        resolved: filtered.filter((incident) => incident.status === "resolved").length,
        unacknowledged: filtered.filter((incident) => incident.status === "active" && incident.acknowledgedAt === null).length,
        silenced: filtered.filter((incident) => incident.silence?.active === true).length
      },
      alertSource: { name: "inventory-health-evaluator", availability: "available", evaluatedAt: "2026-08-12T15:15:00Z", message: null },
      notification: fixtureNotification, operator, incidents: filtered
    };
  }
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
    },
    getIncidents(environment: EnvironmentId, statusFilter: IncidentStatusFilter): Promise<IncidentListResponse> {
      return Promise.resolve().then(() => {
        if (!incidentEnvironments.has(environment) || !incidentStatusFilters.has(statusFilter)) throw new Error("Unsupported incident filter");
        return incidentList(environment, statusFilter);
      });
    },
    getIncident(id: string): Promise<IncidentDetailResponse> {
      return Promise.resolve().then(() => detail(id));
    },
    declareIncident(command: DeclareIncidentCommand): Promise<IncidentDetailResponse> {
      return Promise.resolve().then(() => {
        const service = serviceFixtures.find((item) => item.id === command.serviceId);
        if (service === undefined || command.title.trim() === "" || command.reason.trim() === "") throw new Error("Fixture declaration is invalid");
        const now = "2026-08-12T15:15:00Z";
        const id = `INC-${String(3001 + incidents.length).padStart(6, "0")}`;
        const incident: IncidentSummary = {
          id, version: 1, title: command.title.trim(), description: `Operator-declared incident affecting ${service.name}.`,
          serviceId: service.id, serviceName: service.name, environment: service.environment, severity: command.severity, status: "active",
          startedAt: now, lastObservedAt: now, updatedAt: now, resolvedAt: null, acknowledgedAt: null, acknowledgedBy: null,
          declaredAt: now, declaredBy: operator.id, assignee: operator.id, owner: service.owner, alertActive: false, recoveredAt: null,
          runbook: { id: `${service.id}-incident-response`, title: `${service.name} incident response`, steps: ["Confirm current monitoring evidence.", "Inspect performance and infrastructure.", "Record findings before changing state."] },
          evidence: [{ source: "operator", state: "operator", firstObservedAt: now, lastObservedAt: now, occurrences: 1, message: command.reason, active: true }], silence: null
        };
        incidents = [...incidents, incident];
        audit.set(id, [{ id: 1, action: "created", actor: operator.id, reason: command.reason, createdAt: now, fromStatus: null, toStatus: "active", version: 1 }]);
        return detail(id);
      });
    },
    transitionIncident(id: string, command: IncidentTransitionCommand): Promise<IncidentDetailResponse> {
      return Promise.resolve().then(() => {
        const incident = incidents.find((item) => item.id === id);
        if (incident === undefined || incident.version !== command.expectedVersion || incident.status !== "active") throw new Error("Fixture incident transition conflicts with current state");
        const now = "2026-08-12T15:16:00Z";
        const version = incident.version + 1;
        let updated: IncidentSummary;
        let action: IncidentAuditAction;
        if (command.action === "acknowledge") {
          if (incident.acknowledgedAt !== null) throw new Error("Fixture incident is already acknowledged");
          updated = { ...incident, version, updatedAt: now, acknowledgedAt: now, acknowledgedBy: operator.id, assignee: operator.id };
          action = "acknowledged";
        } else if (command.action === "declare") {
          if (incident.declaredAt !== null) throw new Error("Fixture incident is already declared");
          updated = { ...incident, version, updatedAt: now, declaredAt: now, declaredBy: operator.id, assignee: operator.id };
          action = "declared";
        } else if (command.action === "silence") {
          if (command.durationMinutes === undefined) throw new Error("Fixture silence requires a duration");
          updated = { ...incident, version, updatedAt: now, silence: { createdAt: now, expiresAt: new Date(Date.parse(now) + command.durationMinutes * 60_000).toISOString(), createdBy: operator.id, reason: command.reason, active: true } };
          action = "silenced";
        } else {
          updated = { ...incident, version, updatedAt: now, status: "resolved", resolvedAt: now };
          action = "resolved";
        }
        incidents = incidents.map((item) => item.id === id ? updated : item);
        audit.set(id, [...(audit.get(id) ?? []), { id: (audit.get(id)?.length ?? 0) + 1, action, actor: operator.id, reason: command.reason, createdAt: now, fromStatus: "active", toStatus: updated.status, version }]);
        return detail(id);
      });
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
  async function fetchJson(path: string, label: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method,
        headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (cause: unknown) {
      if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs} ms`);
      throw new Error(`${label} request failed: ${cause instanceof Error ? cause.message : "unknown error"}`);
    } finally {
      window.clearTimeout(timeout);
    }
    if (!response.ok) {
      let message = `${label} returned HTTP ${response.status}`;
      try {
        const errorPayload = record(await response.json() as unknown);
        const error = record(errorPayload?.error);
        if (typeof error?.message === "string") message = error.message;
      } catch { /* retain the explicit HTTP error */ }
      throw new Error(message);
    }
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
    },
    async getIncidents(environment: EnvironmentId, statusFilter: IncidentStatusFilter): Promise<IncidentListResponse> {
      if (!incidentEnvironments.has(environment) || !incidentStatusFilters.has(statusFilter)) throw new Error("Unsupported incident filter");
      return parseIncidentList(await fetchJson(`/api/v1/incidents?environment=${encodeURIComponent(environment)}&status=${encodeURIComponent(statusFilter)}`, "Incident API"));
    },
    async getIncident(id: string): Promise<IncidentDetailResponse> {
      return parseIncidentDetail(await fetchJson(`/api/v1/incidents/${encodeURIComponent(id)}`, "Incident API"));
    },
    async declareIncident(command: DeclareIncidentCommand): Promise<IncidentDetailResponse> {
      return parseIncidentDetail(await fetchJson("/api/v1/incidents", "Incident API", "POST", command));
    },
    async transitionIncident(id: string, command: IncidentTransitionCommand): Promise<IncidentDetailResponse> {
      return parseIncidentDetail(await fetchJson(`/api/v1/incidents/${encodeURIComponent(id)}/transitions`, "Incident API", "POST", command));
    }
  };
}
