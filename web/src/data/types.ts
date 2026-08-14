import type {
  HealthState,
  InventoryEnvironment,
  InventoryMode,
  InventorySourceStatus,
  InventorySummary,
  ServiceInventory
} from "../../../shared/inventory";
import type { PerformanceRange, PerformanceSnapshot } from "../../../shared/performance";

export type EnvironmentId = InventoryEnvironment;
export type TimeRange = PerformanceRange;
export type HealthStatus = HealthState;
export type DataMode = InventoryMode | "fixture";

export interface IncidentSummary {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly severity: "P1" | "P2" | "P3";
  readonly status: "investigating" | "monitoring";
  readonly startedAt: string;
  readonly assignee: string;
}

export interface TrafficPoint {
  readonly time: string;
  readonly requests: number;
  readonly errors: number;
  readonly latency: number;
}

export interface OverviewSnapshot {
  readonly mode: DataMode;
  readonly generatedAt: string;
  readonly lastObservedAt: string | null;
  readonly environment: EnvironmentId;
  readonly timeRange: TimeRange;
  readonly summary: InventorySummary;
  readonly services: readonly ServiceInventory[];
  readonly sources: readonly InventorySourceStatus[];
  readonly incidents: readonly IncidentSummary[];
  readonly traffic: readonly TrafficPoint[];
}

export interface MonitoringProvider {
  getOverview(environment: EnvironmentId, timeRange: TimeRange): Promise<OverviewSnapshot>;
  getPerformance(environment: EnvironmentId, serviceId: string, timeRange: TimeRange): Promise<PerformanceSnapshot>;
}

export type { PerformanceSnapshot } from "../../../shared/performance";
