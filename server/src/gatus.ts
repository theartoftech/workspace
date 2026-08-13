import type { HealthState, VantagePoint } from "../../shared/inventory";
import type { CatalogDefinition } from "./catalog";
import type { JsonHttpClient } from "./http";
import { UpstreamError } from "./http";
import type { SourceCollection, SourceCollector, SourceObservation } from "./source";

interface GatusResult {
  readonly status: number;
  readonly duration: number;
  readonly success: boolean;
  readonly timestamp: string;
}

interface GatusEndpoint {
  readonly name: string;
  readonly group: string;
  readonly enabled: boolean;
  readonly results: readonly GatusResult[];
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UpstreamError("malformed", `Gatus returned malformed ${context}`);
  return value as Record<string, unknown>;
}

function parseEndpoint(value: unknown, index: number): GatusEndpoint {
  const raw = object(value, `endpoint ${index}`);
  if (typeof raw.name !== "string" || typeof raw.group !== "string" || !Array.isArray(raw.results)) {
    throw new UpstreamError("malformed", `Gatus returned malformed endpoint ${index}`);
  }
  const results = raw.results.map((result, resultIndex): GatusResult => {
    const parsed = object(result, `endpoint ${index} result ${resultIndex}`);
    if (typeof parsed.status !== "number" || typeof parsed.duration !== "number" || typeof parsed.success !== "boolean" || typeof parsed.timestamp !== "string") {
      throw new UpstreamError("malformed", `Gatus returned malformed endpoint ${index} result ${resultIndex}`);
    }
    const timestamp = new Date(parsed.timestamp);
    if (Number.isNaN(timestamp.getTime())) throw new UpstreamError("malformed", `Gatus returned invalid timestamp for endpoint ${index}`);
    return { status: parsed.status, duration: parsed.duration, success: parsed.success, timestamp: timestamp.toISOString() };
  });
  return { name: raw.name, group: raw.group, enabled: raw.enabled !== false, results };
}

function newest(results: readonly GatusResult[]): GatusResult | null {
  return results.reduce<GatusResult | null>((latest, item) => latest === null || item.timestamp > latest.timestamp ? item : latest, null);
}

function latestTimestamp(observations: readonly SourceObservation[]): string | null {
  return observations.reduce<string | null>((latest, item) => item.checkedAt !== null && (latest === null || item.checkedAt > latest) ? item.checkedAt : latest, null);
}

export class GatusAdapter implements SourceCollector {
  readonly source: "gatus-internal" | "gatus-public-path";
  readonly toolUrl: string;
  private readonly apiUrl: string;
  private readonly client: JsonHttpClient;
  private readonly staleAfterSeconds: number;
  private readonly vantagePoint: VantagePoint;

  constructor(source: "gatus-internal" | "gatus-public-path", apiUrl: string, toolUrl: string, client: JsonHttpClient, staleAfterSeconds: number) {
    if (!Number.isFinite(staleAfterSeconds) || staleAfterSeconds < 1) throw new Error("staleAfterSeconds must be positive");
    this.source = source;
    this.vantagePoint = source === "gatus-internal" ? "internal" : "external";
    this.apiUrl = apiUrl;
    this.toolUrl = toolUrl;
    this.client = client;
    this.staleAfterSeconds = staleAfterSeconds;
  }

  async collect(catalog: CatalogDefinition, now = new Date()): Promise<SourceCollection> {
    const payload = await this.client.getJson(this.apiUrl);
    if (!Array.isArray(payload)) throw new UpstreamError("malformed", "Gatus returned malformed endpoint collection");
    const endpoints = payload.map(parseEndpoint);
    const endpointByName = new Map(endpoints.map((endpoint) => [endpoint.name, endpoint]));
    const observations: SourceObservation[] = [];
    for (const service of catalog.services) {
      for (const probe of service.probes.filter((item) => item.vantagePoints.includes(this.vantagePoint))) {
        const endpoint = endpointByName.get(probe.id);
        if (endpoint === undefined) {
          observations.push({ serviceId: service.id, probeId: probe.id, state: "unknown", checkedAt: null, latencyMs: null, statusCode: null });
          continue;
        }
        if (!endpoint.enabled) {
          observations.push({ serviceId: service.id, probeId: probe.id, state: "paused", checkedAt: null, latencyMs: null, statusCode: null });
          continue;
        }
        const result = newest(endpoint.results);
        if (result === null) {
          observations.push({ serviceId: service.id, probeId: probe.id, state: "unknown", checkedAt: null, latencyMs: null, statusCode: null });
          continue;
        }
        const ageSeconds = (now.getTime() - new Date(result.timestamp).getTime()) / 1000;
        const state: HealthState = ageSeconds > this.staleAfterSeconds ? "stale" : result.success ? "healthy" : "failing";
        observations.push({ serviceId: service.id, probeId: probe.id, state, checkedAt: result.timestamp, latencyMs: result.duration / 1_000_000, statusCode: result.status });
      }
    }
    return { source: this.source, toolUrl: this.toolUrl, observedAt: latestTimestamp(observations), observations };
  }
}
