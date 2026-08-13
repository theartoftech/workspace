import type {
  HealthState,
  InventoryEnvironment,
  InventorySnapshot,
  InventorySourceStatus,
  InventorySummary,
  ProbeInventory,
  ReachabilityComparison,
  ServiceInventory,
  SourceAvailability,
  VantagePoint,
  WorkloadInventory
} from "../../shared/inventory";
import type { CatalogDefinition, CatalogProbeDefinition, CatalogServiceDefinition, CatalogWorkloadDefinition } from "./catalog";
import { redactDiagnostic, UpstreamError } from "./http";
import type { SourceCollection, SourceCollector, SourceObservation } from "./source";

export type { SourceCollection, SourceCollector } from "./source";

const environments = new Set<InventoryEnvironment>(["all", "demo", "test", "shared"]);

function iso(value: string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latest(values: readonly (string | null)[]): string | null {
  return values.reduce<string | null>((current, value) => {
    const normalized = iso(value);
    return normalized !== null && (current === null || normalized > current) ? normalized : current;
  }, null);
}

function stateFrom(items: readonly HealthState[]): HealthState {
  if (items.length === 0) return "unknown";
  if (items.includes("failing")) return "failing";
  if (items.includes("stale")) return "stale";
  if (items.includes("degraded")) return "degraded";
  if (items.every((state) => state === "paused")) return "paused";
  if (items.includes("unknown")) return items.includes("healthy") || items.includes("paused") ? "degraded" : "unknown";
  return "healthy";
}

function vantageState(probes: readonly ProbeInventory[], vantagePoint: VantagePoint): HealthState | null {
  const states = probes.filter((probe) => probe.vantagePoint === vantagePoint).map((probe) => probe.state);
  return states.length === 0 ? null : stateFrom(states);
}

function reachability(probes: readonly ProbeInventory[], definition: CatalogServiceDefinition): ReachabilityComparison {
  const internalConfigured = definition.probes.some((probe) => probe.vantagePoints.includes("internal"));
  const externalConfigured = definition.probes.some((probe) => probe.vantagePoints.includes("external"));
  const internal = vantageState(probes, "internal");
  const external = vantageState(probes, "external");
  if (!internalConfigured || !externalConfigured) return { internal, external, comparison: "not-configured" };
  if (internal === null || external === null || internal === "unknown" || external === "unknown") return { internal, external, comparison: "incomplete" };
  return { internal, external, comparison: internal === external ? "aligned" : "disagreement" };
}

function probeInventory(
  service: CatalogServiceDefinition,
  probe: CatalogProbeDefinition,
  observations: readonly SourceObservation[],
  collections: ReadonlyMap<string, SourceCollection>,
  attemptedSources: ReadonlySet<string>
): ProbeInventory[] {
  return probe.vantagePoints.flatMap((vantagePoint): readonly ProbeInventory[] => {
    const source = vantagePoint === "internal" ? "gatus-internal" : "gatus-public-path";
    const collection = collections.get(source);
    const observation = observations.find((item) => item.serviceId === service.id && item.probeId === probe.id);
    const shouldRepresent = observation !== undefined || attemptedSources.has(source);
    if (!shouldRepresent) return [];
    return [{
      id: probe.id,
      name: probe.displayName,
      endpoint: probe.url,
      vantagePoint,
      state: observation?.state ?? "unknown",
      checkedAt: iso(observation?.checkedAt ?? null),
      latencyMs: observation?.latencyMs ?? null,
      statusCode: observation?.statusCode ?? null,
      source,
      sourceToolUrl: collection?.toolUrl ?? "#source-unavailable"
    }];
  });
}

function workloadInventory(
  service: CatalogServiceDefinition,
  workload: CatalogWorkloadDefinition,
  observations: readonly SourceObservation[],
  collection: SourceCollection | undefined,
  attempted: boolean
): WorkloadInventory | null {
  const key = `${workload.kind}:${workload.namespace}:${workload.name}`;
  const observation = observations.find((item) => item.serviceId === service.id && item.workloadKey === key);
  if (observation === undefined && !attempted) return null;
  return {
    kind: workload.kind,
    namespace: workload.namespace,
    name: workload.name,
    state: observation?.state ?? "unknown",
    checkedAt: iso(observation?.checkedAt ?? null),
    ready: observation?.ready ?? null,
    desired: observation?.desired ?? null,
    version: observation?.version ?? null,
    sourceToolUrl: collection?.toolUrl ?? "#source-unavailable"
  };
}

function summarize(services: readonly ServiceInventory[]): InventorySummary {
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

function sourceAvailability(collection: SourceCollection): SourceAvailability {
  return collection.observations.some((observation) => observation.state === "stale") ? "stale" : "available";
}

export class InventoryAggregator {
  private readonly catalog: CatalogDefinition;
  private readonly collectors: readonly SourceCollector[];
  private readonly now: () => Date;

  constructor(catalog: CatalogDefinition, collectors: readonly SourceCollector[], now: () => Date = () => new Date()) {
    this.catalog = catalog;
    this.collectors = collectors;
    this.now = now;
  }

  async getInventory(environment: string): Promise<InventorySnapshot> {
    if (!environments.has(environment as InventoryEnvironment)) throw new Error(`Unsupported environment: ${environment}`);
    const selectedEnvironment = environment as InventoryEnvironment;
    const settled = await Promise.allSettled(this.collectors.map(async (collector) => ({ collector, collection: await collector.collect(this.catalog) })));
    const collections = new Map<string, SourceCollection>();
    const sourceStatuses: InventorySourceStatus[] = [{ source: "catalog", availability: "available", observedAt: null, toolUrl: null, message: null }];
    settled.forEach((result, index) => {
      const collector = this.collectors[index];
      if (collector === undefined) return;
      if (result.status === "fulfilled") {
        collections.set(collector.source, result.value.collection);
        sourceStatuses.push({ source: collector.source, availability: sourceAvailability(result.value.collection), observedAt: iso(result.value.collection.observedAt), toolUrl: collector.toolUrl, message: null });
      } else {
        const cause = result.reason as unknown;
        sourceStatuses.push({
          source: collector.source,
          availability: "unavailable",
          observedAt: null,
          toolUrl: collector.toolUrl,
          message: redactDiagnostic(cause instanceof UpstreamError || cause instanceof Error ? cause.message : "Unknown upstream error")
        });
      }
    });
    const attemptedSources = new Set(this.collectors.map((collector) => collector.source));
    const allObservations = [...collections.values()].flatMap((collection) => collection.observations);
    const services = this.catalog.services
      .filter((service) => selectedEnvironment === "all" || service.environment === selectedEnvironment)
      .map((service): ServiceInventory => {
        const probes = service.probes.flatMap((probe) => probeInventory(service, probe, allObservations, collections, attemptedSources));
        const kubernetes = collections.get("kubernetes");
        const workloads = service.workloads.map((workload) => workloadInventory(service, workload, allObservations, kubernetes, attemptedSources.has("kubernetes"))).filter((item): item is WorkloadInventory => item !== null);
        const states = [...probes.map((probe) => probe.state), ...workloads.map((workload) => workload.state)];
        const sourceLinkEntries: Array<readonly [string, { readonly label: string; readonly url: string }]> = [
          ...probes.map((probe) => [probe.sourceToolUrl, { label: probe.source === "gatus-internal" ? "Internal Gatus" : "Public-path Gatus", url: probe.sourceToolUrl }] as const),
          ...workloads.map((workload) => [workload.sourceToolUrl, { label: "Kubernetes", url: workload.sourceToolUrl }] as const)
        ];
        const sourceLinks = [...new Map(sourceLinkEntries).values()].filter((link) => !link.url.startsWith("#"));
        return {
          id: service.id,
          name: service.displayName,
          kind: service.kind,
          environment: service.environment,
          owner: service.owner,
          criticality: service.criticality,
          state: stateFrom(states),
          lastCheckedAt: latest([...probes.map((probe) => probe.checkedAt), ...workloads.map((workload) => workload.checkedAt)]),
          version: workloads.find((workload) => workload.version !== null)?.version ?? null,
          endpoint: service.probes[0]?.url ?? "",
          reachability: reachability(probes, service),
          probes,
          workloads,
          sourceLinks
        };
      });
    return {
      apiVersion: 1,
      mode: sourceStatuses.some((source) => source.availability !== "available") ? "partial" : "live",
      assembledAt: this.now().toISOString(),
      lastObservedAt: latest(sourceStatuses.map((source) => source.observedAt)),
      environment: selectedEnvironment,
      summary: summarize(services),
      services,
      sources: sourceStatuses
    };
  }
}
