import type {
  HealthState,
  InventoryEnvironment,
  InventoryMode,
  InventorySourceStatus,
  InventorySummary,
  ServiceInventory
} from "../../../shared/inventory";
import type { PerformanceRange, PerformanceSnapshot } from "../../../shared/performance";
import type { TopologySnapshot } from "../../../shared/topology";
import type { LogCorrelationSnapshot, LogQuery } from "../../../shared/logs";
import type {
  DeclareIncidentCommand,
  IncidentDetailResponse,
  IncidentListResponse,
  IncidentStatusFilter,
  IncidentTransitionCommand
} from "../../../shared/incidents";
import type { SessionResponse } from "../../../shared/auth";

export type EnvironmentId = InventoryEnvironment;
export type TimeRange = PerformanceRange;
export type HealthStatus = HealthState;
export type DataMode = InventoryMode | "fixture";

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
  readonly traffic: readonly TrafficPoint[];
}

export interface MonitoringProvider {
  getSession(): Promise<SessionResponse>;
  getOverview(environment: EnvironmentId, timeRange: TimeRange): Promise<OverviewSnapshot>;
  getPerformance(environment: EnvironmentId, serviceId: string, timeRange: TimeRange): Promise<PerformanceSnapshot>;
  readonly getTopology?: (environment: EnvironmentId) => Promise<TopologySnapshot>;
  readonly getLogs?: (query: LogQuery) => Promise<LogCorrelationSnapshot>;
  readonly getIncidents?: (environment: EnvironmentId, statusFilter: IncidentStatusFilter) => Promise<IncidentListResponse>;
  readonly getIncident?: (id: string) => Promise<IncidentDetailResponse>;
  readonly declareIncident?: (command: DeclareIncidentCommand) => Promise<IncidentDetailResponse>;
  readonly transitionIncident?: (id: string, command: IncidentTransitionCommand) => Promise<IncidentDetailResponse>;
}

export type { SessionResponse, SessionUser, WorkspaceRole } from "../../../shared/auth";

export type { DeclareIncidentCommand, IncidentDetailResponse, IncidentListResponse, IncidentStatusFilter, IncidentSummary, IncidentTransitionCommand } from "../../../shared/incidents";
export type { PerformanceSnapshot } from "../../../shared/performance";
export type { TopologySnapshot } from "../../../shared/topology";
export type { LogCorrelationSnapshot, LogQuery, LogSeverity, LogSeverityFilter } from "../../../shared/logs";
