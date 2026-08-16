import type { InventoryEnvironment } from "./inventory";

export type PerformanceRange = "15m" | "1h" | "6h" | "24h";
export type PerformanceMode = "live" | "partial";
export type PerformanceMetricStatus = "ok" | "no-data" | "error";
export type PerformanceUnit =
  | "requests/s"
  | "requests"
  | "percent"
  | "milliseconds"
  | "restarts"
  | "transactions/s"
  | "connections"
  | "deadlocks"
  | "seconds"
  | "bytes";
export type PerformanceMetricId =
  | "request-rate"
  | "request-total"
  | "error-rate"
  | "latency-p50"
  | "latency-p95"
  | "latency-p99"
  | "process-cpu"
  | "system-cpu"
  | "jvm-heap"
  | "host-memory"
  | "db-pool-saturation"
  | "db-availability"
  | "db-connection-saturation"
  | "db-transaction-rate"
  | "db-waiting-connections"
  | "db-deadlocks"
  | "db-longest-transaction"
  | "db-size"
  | "pod-restarts";

export interface PerformancePoint {
  readonly timestamp: string;
  readonly value: number;
}

export interface PerformanceMetric {
  readonly id: PerformanceMetricId;
  readonly label: string;
  readonly unit: PerformanceUnit;
  readonly status: PerformanceMetricStatus;
  readonly points: readonly PerformancePoint[];
  readonly latest: number | null;
  readonly threshold: number | null;
  readonly message: string | null;
}

export interface PerformanceWindow {
  readonly range: PerformanceRange;
  readonly start: string;
  readonly end: string;
  readonly stepSeconds: number;
  readonly maxPoints: number;
}

export interface PerformanceSnapshot {
  readonly apiVersion: 1;
  readonly mode: PerformanceMode;
  readonly assembledAt: string;
  readonly observedAt: string | null;
  readonly environment: InventoryEnvironment;
  readonly serviceId: string;
  readonly window: PerformanceWindow;
  readonly source: {
    readonly name: "prometheus";
    readonly availability: "available" | "partial" | "unavailable";
    readonly message: string | null;
  };
  readonly metrics: readonly PerformanceMetric[];
}
