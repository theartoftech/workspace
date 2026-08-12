export type EnvironmentId = "all" | "demo" | "test" | "shared";
export type TimeRange = "15m" | "1h" | "6h" | "24h";
export type HealthStatus = "healthy" | "degraded" | "critical" | "unknown";
export type DataMode = "fixture" | "live";

export interface ServiceHealth {
  readonly id: string;
  readonly name: string;
  readonly kind: "application" | "identity" | "mail" | "erp";
  readonly environment: Exclude<EnvironmentId, "all">;
  readonly status: HealthStatus;
  readonly uptime: number;
  readonly latencyMs: number;
  readonly requestRate: number;
  readonly version: string;
  readonly owner: string;
  readonly lastChecked: string;
}

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

export interface OverviewSummary {
  readonly totalServices: number;
  readonly healthyServices: number;
  readonly degradedServices: number;
  readonly criticalServices: number;
  readonly uptime: number;
  readonly activeIncidents: number;
}

export interface OverviewSnapshot {
  readonly mode: DataMode;
  readonly generatedAt: string;
  readonly environment: EnvironmentId;
  readonly timeRange: TimeRange;
  readonly summary: OverviewSummary;
  readonly services: readonly ServiceHealth[];
  readonly incidents: readonly IncidentSummary[];
  readonly traffic: readonly TrafficPoint[];
}

export interface MonitoringProvider {
  getOverview(environment: EnvironmentId, timeRange: TimeRange): Promise<OverviewSnapshot>;
}
