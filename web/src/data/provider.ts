import type { HealthState, InventorySnapshot, ServiceInventory } from "../../../shared/inventory";
import { incidentFixtures, serviceFixtures, trafficFixtures } from "./fixtures";
import type { EnvironmentId, MonitoringProvider, OverviewSnapshot, TimeRange } from "./types";

const environments = new Set<EnvironmentId>(["all", "demo", "test", "shared"]);
const timeRanges = new Set<TimeRange>(["15m", "1h", "6h", "24h"]);
const healthStates = new Set<HealthState>(["healthy", "degraded", "failing", "unknown", "paused", "stale"]);

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
    && ["demo", "test", "shared"].includes(String(raw.environment))
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
  return {
    async getOverview(environment: EnvironmentId, timeRange: TimeRange): Promise<OverviewSnapshot> {
      validateFilters(environment, timeRange);
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(`/api/v1/inventory?environment=${encodeURIComponent(environment)}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal
        });
      } catch (cause: unknown) {
        if (controller.signal.aborted) throw new Error(`Inventory API timed out after ${timeoutMs} ms`);
        throw new Error(`Inventory API request failed: ${cause instanceof Error ? cause.message : "unknown error"}`);
      } finally {
        window.clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`Inventory API returned HTTP ${response.status}`);
      let payload: unknown;
      try {
        payload = await response.json() as unknown;
      } catch {
        throw new Error("Inventory API returned malformed JSON");
      }
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
    }
  };
}
