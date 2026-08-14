export type InventoryEnvironment = "all" | "demo" | "test" | "portfolio" | "shared";
export type ServiceEnvironment = Exclude<InventoryEnvironment, "all">;
export type HealthState = "healthy" | "degraded" | "failing" | "unknown" | "paused" | "stale";
export type InventoryMode = "live" | "partial";
export type InventorySourceName = "catalog" | "gatus-internal" | "gatus-public-path" | "kubernetes";
export type SourceAvailability = "available" | "unavailable" | "stale";
export type VantagePoint = "internal" | "external";

export interface InventorySourceStatus {
  readonly source: InventorySourceName;
  readonly availability: SourceAvailability;
  readonly observedAt: string | null;
  readonly toolUrl: string | null;
  readonly message: string | null;
}

export interface ProbeInventory {
  readonly id: string;
  readonly name: string;
  readonly endpoint: string;
  readonly vantagePoint: VantagePoint;
  readonly state: HealthState;
  readonly checkedAt: string | null;
  readonly latencyMs: number | null;
  readonly statusCode: number | null;
  readonly source: Extract<InventorySourceName, "gatus-internal" | "gatus-public-path">;
  readonly sourceToolUrl: string;
}

export interface WorkloadInventory {
  readonly kind: "Deployment" | "Pod";
  readonly namespace: string;
  readonly name: string;
  readonly state: HealthState;
  readonly checkedAt: string | null;
  readonly ready: number | null;
  readonly desired: number | null;
  readonly version: string | null;
  readonly sourceToolUrl: string;
}

export interface ReachabilityComparison {
  readonly internal: HealthState | null;
  readonly external: HealthState | null;
  readonly comparison: "aligned" | "disagreement" | "incomplete" | "not-configured";
}

export interface ServiceInventory {
  readonly id: string;
  readonly name: string;
  readonly kind: "application" | "identity" | "mail" | "erp";
  readonly environment: ServiceEnvironment;
  readonly owner: string;
  readonly criticality: "critical" | "high" | "medium";
  readonly state: HealthState;
  readonly lastCheckedAt: string | null;
  readonly version: string | null;
  readonly endpoint: string;
  readonly reachability: ReachabilityComparison;
  readonly probes: readonly ProbeInventory[];
  readonly workloads: readonly WorkloadInventory[];
  readonly sourceLinks: readonly { readonly label: string; readonly url: string }[];
}

export interface InventorySummary {
  readonly total: number;
  readonly healthy: number;
  readonly degraded: number;
  readonly failing: number;
  readonly unknown: number;
  readonly paused: number;
  readonly stale: number;
}

export interface InventorySnapshot {
  readonly apiVersion: 1;
  readonly mode: InventoryMode;
  readonly assembledAt: string;
  readonly lastObservedAt: string | null;
  readonly environment: InventoryEnvironment;
  readonly summary: InventorySummary;
  readonly services: readonly ServiceInventory[];
  readonly sources: readonly InventorySourceStatus[];
}

export interface ServiceDetailResponse {
  readonly apiVersion: 1;
  readonly mode: InventoryMode;
  readonly assembledAt: string;
  readonly service: ServiceInventory;
  readonly sources: readonly InventorySourceStatus[];
}
