import type { HealthState, InventorySourceName } from "../../shared/inventory";
import type { CatalogDefinition } from "./catalog";
import { UpstreamError } from "./http";

export interface SourceObservation {
  readonly serviceId: string;
  readonly probeId?: string;
  readonly workloadKey?: string;
  readonly state: HealthState;
  readonly checkedAt: string | null;
  readonly latencyMs?: number | null;
  readonly statusCode?: number | null;
  readonly version?: string | null;
  readonly ready?: number | null;
  readonly desired?: number | null;
}

export interface SourceCollection {
  readonly source: Exclude<InventorySourceName, "catalog">;
  readonly toolUrl: string;
  readonly observedAt: string | null;
  readonly observations: readonly SourceObservation[];
}

export interface SourceCollector {
  readonly source: Exclude<InventorySourceName, "catalog">;
  readonly toolUrl: string;
  collect(catalog: CatalogDefinition): Promise<SourceCollection>;
}

export class UnavailableSourceCollector implements SourceCollector {
  readonly source: Exclude<InventorySourceName, "catalog">;
  readonly toolUrl: string;
  private readonly reason: string;

  constructor(source: Exclude<InventorySourceName, "catalog">, toolUrl: string, reason: string) {
    this.source = source;
    this.toolUrl = toolUrl;
    this.reason = reason;
  }

  collect(_catalog: CatalogDefinition): Promise<SourceCollection> {
    return Promise.reject(new UpstreamError("unavailable", this.reason));
  }
}
