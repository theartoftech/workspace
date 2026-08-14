import type { HealthState, InventoryEnvironment, InventoryMode } from "./inventory";

export type TopologyResourceKind = "Node" | "Namespace" | "Deployment" | "StatefulSet" | "Pod" | "Service" | "PersistentVolumeClaim" | "Ingress";
export type TopologyIssueCode = "crash-loop" | "pending" | "failed-mount" | "node-pressure" | "restarts" | "storage-capacity" | "unavailable";

export interface TopologyEvent {
  readonly type: "Normal" | "Warning" | "Unknown";
  readonly reason: string;
  readonly message: string;
  readonly observedAt: string | null;
}

export interface TopologyResource {
  readonly id: string;
  readonly kind: TopologyResourceKind;
  readonly namespace: string | null;
  readonly name: string;
  readonly state: HealthState;
  readonly summary: string;
  readonly issueCode: TopologyIssueCode | null;
  readonly serviceIds: readonly string[];
  readonly nodeName: string | null;
  readonly restarts: number | null;
  readonly capacity: string | null;
  readonly sourceLabel: "Kubernetes" | "Catalog";
  readonly sourceToolUrl: string;
  readonly events: readonly TopologyEvent[];
}

export interface TopologyEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: "depends-on" | "runs-as" | "scheduled-on" | "observes";
}

export interface TopologySnapshot {
  readonly apiVersion: 1;
  readonly mode: InventoryMode;
  readonly assembledAt: string;
  readonly environment: InventoryEnvironment;
  readonly namespaces: readonly string[];
  readonly truncated: boolean;
  readonly resources: readonly TopologyResource[];
  readonly edges: readonly TopologyEdge[];
  readonly source: {
    readonly name: "kubernetes";
    readonly availability: "available" | "unavailable";
    readonly message: string | null;
  };
}
