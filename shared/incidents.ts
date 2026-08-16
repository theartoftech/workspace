import type { HealthState, InventoryEnvironment } from "./inventory";
import type { SessionUser } from "./auth";

export type IncidentEnvironment = Exclude<InventoryEnvironment, "all">;
export type IncidentSeverity = "P1" | "P2" | "P3";
export type IncidentStatus = "active" | "resolved";
export type IncidentStatusFilter = IncidentStatus | "all";
export type IncidentTransitionAction = "acknowledge" | "declare" | "silence" | "resolve";
export type IncidentAuditAction =
  | "created"
  | "acknowledged"
  | "declared"
  | "silenced"
  | "silence_expired"
  | "resolved"
  | "reopened"
  | "alert_recurred"
  | "alert_updated"
  | "condition_recovered";

export interface IncidentRunbook {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly string[];
}

export interface IncidentEvidence {
  readonly source: string;
  readonly state: HealthState | "operator";
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly occurrences: number;
  readonly message: string;
  readonly active: boolean;
}

export interface IncidentSilence {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly createdBy: string;
  readonly reason: string;
  readonly active: boolean;
}

export interface IncidentSummary {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly environment: IncidentEnvironment;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly startedAt: string;
  readonly lastObservedAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly declaredAt: string | null;
  readonly declaredBy: string | null;
  readonly assignee: string;
  readonly owner: string;
  readonly alertActive: boolean;
  readonly recoveredAt: string | null;
  readonly runbook: IncidentRunbook;
  readonly evidence: readonly IncidentEvidence[];
  readonly silence: IncidentSilence | null;
}

export interface IncidentAuditEvent {
  readonly id: number;
  readonly action: IncidentAuditAction;
  readonly actor: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly fromStatus: IncidentStatus | null;
  readonly toStatus: IncidentStatus;
  readonly version: number;
}

export interface IncidentOperator extends SessionUser {
  readonly identityMode: "cloudflare-access";
}

export interface IncidentNotificationStatus {
  readonly state: "unconfigured";
  readonly message: string;
}

export interface IncidentAlertSourceStatus {
  readonly name: "inventory-health-evaluator";
  readonly availability: "available" | "unavailable";
  readonly evaluatedAt: string | null;
  readonly message: string | null;
}

export interface IncidentListResponse {
  readonly apiVersion: 1;
  readonly mode: "live" | "partial";
  readonly assembledAt: string;
  readonly environment: InventoryEnvironment;
  readonly statusFilter: IncidentStatusFilter;
  readonly truncated: boolean;
  readonly summary: {
    readonly total: number;
    readonly active: number;
    readonly resolved: number;
    readonly unacknowledged: number;
    readonly silenced: number;
  };
  readonly alertSource: IncidentAlertSourceStatus;
  readonly notification: IncidentNotificationStatus;
  readonly operator: IncidentOperator;
  readonly incidents: readonly IncidentSummary[];
}

export interface IncidentDetailResponse {
  readonly apiVersion: 1;
  readonly assembledAt: string;
  readonly notification: IncidentNotificationStatus;
  readonly operator: IncidentOperator;
  readonly incident: IncidentSummary;
  readonly audit: readonly IncidentAuditEvent[];
}

export interface DeclareIncidentCommand {
  readonly serviceId: string;
  readonly title: string;
  readonly severity: IncidentSeverity;
  readonly reason: string;
}

export interface IncidentTransitionCommand {
  readonly action: IncidentTransitionAction;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly durationMinutes?: 15 | 60 | 360 | 1440;
}
