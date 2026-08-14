import type { InventoryEnvironment } from "./inventory";
import type { PerformanceRange } from "./performance";

export type LogSeverity = "error" | "warning" | "info" | "debug" | "unknown";
export type LogSeverityFilter = "all" | LogSeverity;
export type LogSourceAvailability = "available" | "partial" | "unavailable";

export interface LogQuery {
  readonly environment: InventoryEnvironment;
  readonly serviceId: string;
  readonly range: PerformanceRange;
  readonly pod: string | null;
  readonly severity: LogSeverityFilter;
  readonly query: string;
  readonly correlationId: string;
}

export interface LogAppliedFilters {
  readonly environment: InventoryEnvironment;
  readonly serviceId: string;
  readonly range: PerformanceRange;
  readonly pod: string | null;
  readonly severity: LogSeverityFilter;
  readonly queryApplied: boolean;
  readonly correlationIdApplied: boolean;
}

export interface LogPod {
  readonly namespace: string;
  readonly name: string;
  readonly containers: readonly string[];
  readonly restartCount: number;
}

export interface LogEntry {
  readonly id: string;
  readonly timestamp: string | null;
  readonly namespace: string;
  readonly pod: string;
  readonly container: string;
  readonly previous: boolean;
  readonly severity: LogSeverity;
  readonly message: string;
  readonly correlationId: string | null;
}

export interface CorrelatedKubernetesEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly namespace: string;
  readonly targetKind: string;
  readonly targetName: string;
  readonly type: "Normal" | "Warning" | "Unknown";
  readonly reason: string;
  readonly message: string;
}

export interface LogSourceStatus {
  readonly name: "kubernetes-pod-logs" | "kubernetes-events";
  readonly availability: LogSourceAvailability;
  readonly message: string | null;
}

export interface LogOmission {
  readonly source: "workload-discovery" | "kubernetes-pod-logs" | "kubernetes-events";
  readonly scope: string;
  readonly reason: string;
}

export interface LogCorrelationSnapshot {
  readonly apiVersion: 1;
  readonly mode: "live" | "partial";
  readonly assembledAt: string;
  readonly service: { readonly id: string; readonly name: string; readonly environment: string };
  readonly window: { readonly range: PerformanceRange; readonly start: string; readonly end: string };
  readonly filters: LogAppliedFilters;
  readonly limits: {
    readonly maxPods: number;
    readonly maxStreams: number;
    readonly maxEntries: number;
    readonly maxEventsPerObject: 5;
    readonly maxEvents: number;
  };
  readonly truncated: boolean;
  readonly pods: readonly LogPod[];
  readonly entries: readonly LogEntry[];
  readonly events: readonly CorrelatedKubernetesEvent[];
  readonly sources: readonly LogSourceStatus[];
  readonly omissions: readonly LogOmission[];
  readonly redaction: {
    readonly applied: true;
    readonly replacement: "[REDACTED]";
    readonly description: string;
  };
}
