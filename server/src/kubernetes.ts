import type { HealthState } from "../../shared/inventory";
import type { CatalogDefinition, CatalogWorkloadDefinition } from "./catalog";
import type { JsonHttpClient } from "./http";
import { UpstreamError } from "./http";
import type { SourceCollection, SourceCollector, SourceObservation } from "./source";

export interface KubernetesAdapterOptions {
  readonly apiUrl: string;
  readonly bearerToken: string;
  readonly toolUrl: string;
  readonly staleAfterSeconds: number;
  readonly client: JsonHttpClient;
  readonly concurrency?: number;
  readonly now?: () => Date;
}

interface ParsedWorkload {
  readonly state: HealthState;
  readonly ready: number | null;
  readonly desired: number | null;
  readonly version: string | null;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UpstreamError("malformed", `Kubernetes returned malformed ${context}`);
  return value as Record<string, unknown>;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function imageVersion(image: string): string {
  const name = image.split("/").at(-1) ?? image;
  const digestIndex = name.indexOf("@sha256:");
  if (digestIndex >= 0) return `sha256:${name.slice(digestIndex + 8, digestIndex + 20)}`;
  const tagIndex = name.lastIndexOf(":");
  return tagIndex >= 0 ? name.slice(tagIndex + 1) : name;
}

function containerImage(spec: Record<string, unknown>, context: string): string | null {
  const template = record(spec.template, `${context}.spec.template`);
  const templateSpec = record(template.spec, `${context}.spec.template.spec`);
  if (!Array.isArray(templateSpec.containers) || templateSpec.containers.length === 0) throw new UpstreamError("malformed", `Kubernetes returned malformed ${context} containers`);
  const container = record(templateSpec.containers[0], `${context} container`);
  if (typeof container.image !== "string") throw new UpstreamError("malformed", `Kubernetes returned malformed ${context} image`);
  return imageVersion(container.image);
}

function parseDeployment(value: unknown): ParsedWorkload {
  const raw = record(value, "Deployment");
  const metadata = record(raw.metadata, "Deployment metadata");
  if (typeof metadata.name !== "string" || typeof metadata.namespace !== "string") throw new UpstreamError("malformed", "Kubernetes returned malformed Deployment metadata");
  const spec = record(raw.spec, "Deployment spec");
  const status = record(raw.status, "Deployment status");
  const desired = optionalNumber(spec.replicas);
  const ready = optionalNumber(status.readyReplicas) ?? 0;
  let state: HealthState;
  if (spec.paused === true) state = "paused";
  else if (desired === null) state = "unknown";
  else if (desired > 0 && ready >= desired) state = "healthy";
  else if (desired > 0 && ready === 0) state = "failing";
  else state = "degraded";
  return { state, ready, desired, version: containerImage(spec, "Deployment") };
}

function parsePod(value: unknown): ParsedWorkload {
  const raw = record(value, "Pod");
  const metadata = record(raw.metadata, "Pod metadata");
  if (typeof metadata.name !== "string" || typeof metadata.namespace !== "string") throw new UpstreamError("malformed", "Kubernetes returned malformed Pod metadata");
  const spec = record(raw.spec, "Pod spec");
  const status = record(raw.status, "Pod status");
  if (typeof status.phase !== "string" || !Array.isArray(spec.containers) || spec.containers.length === 0) throw new UpstreamError("malformed", "Kubernetes returned malformed Pod state");
  const container = record(spec.containers[0], "Pod container");
  if (typeof container.image !== "string") throw new UpstreamError("malformed", "Kubernetes returned malformed Pod image");
  const desired = spec.containers.length;
  if (status.phase !== "Running") {
    const state: HealthState = status.phase === "Pending" ? "degraded" : status.phase === "Failed" ? "failing" : "unknown";
    return { state, ready: 0, desired, version: imageVersion(container.image) };
  }
  if (!Array.isArray(status.containerStatuses) || status.containerStatuses.length === 0) {
    return { state: "unknown", ready: null, desired, version: imageVersion(container.image) };
  }
  const containerStatuses = status.containerStatuses.map((item, index) => record(item, `Pod container status ${index}`));
  const ready = containerStatuses.filter((item) => item.ready === true).length;
  const crashLooping = containerStatuses.some((item) => {
    if (typeof item.state !== "object" || item.state === null || Array.isArray(item.state)) return false;
    const waiting = (item.state as Record<string, unknown>).waiting;
    return typeof waiting === "object" && waiting !== null && !Array.isArray(waiting)
      && (waiting as Record<string, unknown>).reason === "CrashLoopBackOff";
  });
  const state: HealthState = crashLooping ? "failing" : ready >= desired ? "healthy" : "degraded";
  return { state, ready, desired, version: imageVersion(container.image) };
}

function workloadUrl(apiUrl: string, workload: CatalogWorkloadDefinition): string {
  const root = apiUrl.replace(/\/$/u, "");
  const namespace = encodeURIComponent(workload.namespace);
  const name = encodeURIComponent(workload.name);
  return workload.kind === "Deployment"
    ? `${root}/apis/apps/v1/namespaces/${namespace}/deployments/${name}`
    : `${root}/api/v1/namespaces/${namespace}/pods/${name}`;
}

async function mapConcurrent<Input, Output>(items: readonly Input[], concurrency: number, mapper: (item: Input) => Promise<Output>): Promise<readonly Output[]> {
  const results: Output[] = new Array<Output>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await mapper(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export class KubernetesAdapter implements SourceCollector {
  readonly source = "kubernetes" as const;
  readonly toolUrl: string;
  private readonly options: Required<Omit<KubernetesAdapterOptions, "concurrency" | "now">> & { readonly concurrency: number; readonly now: () => Date };

  constructor(options: KubernetesAdapterOptions) {
    if (options.apiUrl.trim() === "" || options.bearerToken.trim() === "") throw new Error("Kubernetes apiUrl and bearerToken are required");
    const concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("Kubernetes concurrency must be 1..16");
    this.toolUrl = options.toolUrl;
    this.options = { ...options, concurrency, now: options.now ?? (() => new Date()) };
  }

  async collect(catalog: CatalogDefinition): Promise<SourceCollection> {
    const requests = catalog.services.flatMap((service) => service.workloads.map((workload) => ({ serviceId: service.id, workload })));
    const checkedAt = this.options.now().toISOString();
    const observations = await mapConcurrent(requests, this.options.concurrency, async ({ serviceId, workload }): Promise<SourceObservation> => {
      const payload = await this.options.client.getJson(workloadUrl(this.options.apiUrl, workload), {
        headers: { Authorization: `Bearer ${this.options.bearerToken}`, Accept: "application/json" }
      });
      const parsed = workload.kind === "Deployment" ? parseDeployment(payload) : parsePod(payload);
      return {
        serviceId,
        workloadKey: `${workload.kind}:${workload.namespace}:${workload.name}`,
        state: parsed.state,
        checkedAt,
        version: parsed.version,
        ready: parsed.ready,
        desired: parsed.desired
      };
    });
    return { source: this.source, toolUrl: this.toolUrl, observedAt: requests.length === 0 ? null : checkedAt, observations };
  }
}
