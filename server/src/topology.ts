import type { HealthState, InventoryEnvironment } from "../../shared/inventory";
import type { TopologyEdge, TopologyEvent, TopologyIssueCode, TopologyResource, TopologyResourceKind, TopologySnapshot } from "../../shared/topology";
import type { CatalogDefinition } from "./catalog";
import type { JsonHttpClient } from "./http";
import { UpstreamError } from "./http";

export interface TopologyReader {
  getTopology(environment: string): Promise<TopologySnapshot>;
}

export interface KubernetesTopologyReaderOptions {
  readonly apiUrl: string;
  readonly bearerToken: string;
  readonly toolUrl: string;
  readonly catalog: CatalogDefinition;
  readonly client: JsonHttpClient;
  readonly maxResources?: number;
  readonly concurrency?: number;
  readonly now?: () => Date;
}

interface KubernetesList { readonly items: readonly Record<string, unknown>[]; readonly truncated: boolean; }

const environments = new Set<InventoryEnvironment>(["all", "demo", "test", "portfolio", "shared"]);

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UpstreamError("malformed", `Kubernetes returned malformed ${context}`);
  return value as Record<string, unknown>;
}

function records(value: unknown, context: string): KubernetesList {
  const raw = record(value, context);
  if (!Array.isArray(raw.items)) throw new UpstreamError("malformed", `Kubernetes returned malformed ${context}.items`);
  const metadata = nested(raw, "metadata");
  return { items: raw.items.map((item, index) => record(item, `${context}.items[${index}]`)), truncated: typeof metadata.continue === "string" && metadata.continue !== "" };
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key];
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {};
}

function nameAndNamespace(value: Record<string, unknown>, fallbackNamespace: string | null): { readonly name: string; readonly namespace: string | null } {
  const metadata = nested(value, "metadata");
  if (typeof metadata.name !== "string" || metadata.name.trim() === "") throw new UpstreamError("malformed", "Kubernetes resource metadata.name is missing");
  return { name: metadata.name, namespace: typeof metadata.namespace === "string" ? metadata.namespace : fallbackNamespace };
}

function resourceId(kind: TopologyResourceKind, namespace: string | null, name: string): string {
  return `${kind}:${namespace ?? ""}:${name}`;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function scalar(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}

function conditions(value: Record<string, unknown>): readonly Record<string, unknown>[] {
  const raw = nested(value, "status").conditions;
  return Array.isArray(raw) ? raw.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

function sourceUrl(toolUrl: string, kind: TopologyResourceKind, namespace: string | null, name: string): string {
  const root = toolUrl.endsWith("/") ? toolUrl : `${toolUrl}/`;
  const scope = namespace === null ? "cluster" : `namespaces/${encodeURIComponent(namespace)}`;
  return `${root}${scope}/${kind.toLowerCase()}/${encodeURIComponent(name)}`;
}

function baseResource(kind: TopologyResourceKind, value: Record<string, unknown>, namespace: string | null, toolUrl: string): TopologyResource {
  const identity = nameAndNamespace(value, namespace);
  return {
    id: resourceId(kind, identity.namespace, identity.name), kind, namespace: identity.namespace, name: identity.name,
    state: "healthy", summary: "Observed", issueCode: null, serviceIds: [], nodeName: null, restarts: null, capacity: null,
    sourceLabel: "Kubernetes", sourceToolUrl: sourceUrl(toolUrl, kind, identity.namespace, identity.name), events: []
  };
}

function parseNode(value: Record<string, unknown>, toolUrl: string): TopologyResource {
  const base = baseResource("Node", value, null, toolUrl);
  const pressure = conditions(value).find((condition) => condition.status === "True" && typeof condition.type === "string" && condition.type.endsWith("Pressure"));
  const ready = conditions(value).find((condition) => condition.type === "Ready");
  const status = nested(value, "status");
  const capacity = nested(status, "capacity");
  const state: HealthState = pressure !== undefined || ready?.status === "False" ? "degraded" : ready === undefined || ready.status === "Unknown" ? "unknown" : "healthy";
  return { ...base, state, issueCode: pressure === undefined ? null : "node-pressure", summary: pressure === undefined ? `Ready · ${scalar(capacity.cpu, "?")} CPU · ${scalar(capacity.memory, "? memory")}` : `${scalar(pressure.type, "Unknown pressure")} reported` };
}

function parseNamespace(value: Record<string, unknown>, toolUrl: string): TopologyResource {
  const base = baseResource("Namespace", value, null, toolUrl);
  const phase = nested(value, "status").phase;
  return { ...base, namespace: base.name, id: resourceId("Namespace", null, base.name), state: phase === "Active" ? "healthy" : "degraded", summary: typeof phase === "string" ? phase : "Phase unavailable" };
}

function parseController(kind: "Deployment" | "StatefulSet", value: Record<string, unknown>, namespace: string, toolUrl: string): TopologyResource {
  const base = baseResource(kind, value, namespace, toolUrl);
  const desired = integer(nested(value, "spec").replicas);
  const ready = integer(nested(value, "status").readyReplicas) ?? 0;
  const state: HealthState = desired === null ? "unknown" : desired > 0 && ready >= desired ? "healthy" : ready === 0 ? "failing" : "degraded";
  return { ...base, state, summary: `${ready}/${desired ?? "?"} replicas ready` };
}

function parsePod(value: Record<string, unknown>, namespace: string, toolUrl: string): TopologyResource {
  const base = baseResource("Pod", value, namespace, toolUrl);
  const spec = nested(value, "spec");
  const status = nested(value, "status");
  const statuses = Array.isArray(status.containerStatuses) ? status.containerStatuses.map((item) => record(item, "Pod container status")) : [];
  const restarts = statuses.reduce((sum, item) => sum + (integer(item.restartCount) ?? 0), 0);
  const crashLoop = statuses.some((item) => nested(nested(item, "state"), "waiting").reason === "CrashLoopBackOff");
  const ready = statuses.length > 0 && statuses.every((item) => item.ready === true);
  const phase = typeof status.phase === "string" ? status.phase : "Unknown";
  let state: HealthState = phase === "Running" && ready ? "healthy" : phase === "Failed" ? "failing" : phase === "Pending" ? "degraded" : "unknown";
  let issueCode: TopologyIssueCode | null = phase === "Pending" ? "pending" : restarts > 0 ? "restarts" : null;
  let summary = phase;
  if (crashLoop) { state = "failing"; issueCode = "crash-loop"; summary = `CrashLoopBackOff · ${restarts} restarts`; }
  else if (restarts > 0) summary = `${phase} · ${restarts} restarts`;
  return { ...base, state, summary, issueCode, nodeName: typeof spec.nodeName === "string" ? spec.nodeName : null, restarts };
}

function parseService(value: Record<string, unknown>, namespace: string, toolUrl: string): TopologyResource {
  const base = baseResource("Service", value, namespace, toolUrl);
  const spec = nested(value, "spec");
  return { ...base, summary: `${scalar(spec.type, "ClusterIP")} · ${scalar(spec.clusterIP, "no cluster IP")}` };
}

function parsePvc(value: Record<string, unknown>, namespace: string, toolUrl: string): TopologyResource {
  const base = baseResource("PersistentVolumeClaim", value, namespace, toolUrl);
  const requested = nested(nested(nested(value, "spec"), "resources"), "requests").storage;
  const actual = nested(nested(value, "status"), "capacity").storage;
  const capacity = typeof actual === "string" ? actual : typeof requested === "string" ? requested : null;
  const phase = nested(value, "status").phase;
  const healthy = phase === "Bound";
  return { ...base, state: healthy ? "healthy" : "degraded", summary: `${scalar(phase, "Unknown")} · ${capacity ?? "capacity unavailable"}`, issueCode: healthy ? null : "storage-capacity", capacity };
}

function parseIngress(value: Record<string, unknown>, namespace: string, toolUrl: string): TopologyResource {
  const base = baseResource("Ingress", value, namespace, toolUrl);
  const rules = nested(value, "spec").rules;
  const hosts = Array.isArray(rules) ? rules.map((item) => record(item, "Ingress rule").host).filter((item): item is string => typeof item === "string") : [];
  return { ...base, summary: hosts.length > 0 ? hosts.join(", ") : "No host rules" };
}

function parseEvent(value: Record<string, unknown>): { readonly targetKind: string; readonly targetName: string; readonly event: TopologyEvent } | null {
  const target = nested(value, "involvedObject");
  if (typeof target.kind !== "string" || typeof target.name !== "string") return null;
  return { targetKind: target.kind, targetName: target.name, event: {
    type: value.type === "Normal" || value.type === "Warning" ? value.type : "Unknown",
    reason: typeof value.reason === "string" ? value.reason : "Unknown",
    message: typeof value.message === "string" ? value.message : "No event message",
    observedAt: typeof value.eventTime === "string" ? value.eventTime : typeof value.lastTimestamp === "string" ? value.lastTimestamp : null
  } };
}

async function mapConcurrent<Input, Output>(items: readonly Input[], concurrency: number, mapper: (item: Input) => Promise<Output>): Promise<readonly Output[]> {
  const results = new Array<Output>(items.length); let next = 0;
  async function worker(): Promise<void> { while (next < items.length) { const index = next++; const item = items[index]; if (item !== undefined) results[index] = await mapper(item); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker)); return results;
}

export class KubernetesTopologyReader implements TopologyReader {
  private readonly options: Required<Omit<KubernetesTopologyReaderOptions, "maxResources" | "concurrency" | "now">> & { readonly maxResources: number; readonly concurrency: number; readonly now: () => Date };

  constructor(options: KubernetesTopologyReaderOptions) {
    if (options.apiUrl.trim() === "" || options.bearerToken.trim() === "") throw new Error("Kubernetes apiUrl and bearerToken are required");
    const maxResources = options.maxResources ?? 500; const concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(maxResources) || maxResources < 1 || maxResources > 2000) throw new Error("Topology maxResources must be 1..2000");
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("Topology concurrency must be 1..16");
    this.options = { ...options, maxResources, concurrency, now: options.now ?? (() => new Date()) };
  }

  async getTopology(environment: string): Promise<TopologySnapshot> {
    if (!environments.has(environment as InventoryEnvironment)) throw new Error(`Unsupported environment: ${environment}`);
    const selected = this.options.catalog.services.filter((service) => environment === "all" || service.environment === environment);
    const namespaces = [...new Set(selected.flatMap((service) => service.workloads.map((workload) => workload.namespace)))].sort();
    const root = this.options.apiUrl.replace(/\/$/u, "");
    const headers = { Authorization: `Bearer ${this.options.bearerToken}`, Accept: "application/json" };
    const nodePayload = await this.options.client.getJson(`${root}/api/v1/nodes?limit=200`, { headers });
    const namespacePayloads = await mapConcurrent(namespaces, this.options.concurrency, async (namespace) => {
      const encoded = encodeURIComponent(namespace);
      const urls = [
        `${root}/api/v1/namespaces/${encoded}`,
        `${root}/apis/apps/v1/namespaces/${encoded}/deployments?limit=200`,
        `${root}/apis/apps/v1/namespaces/${encoded}/statefulsets?limit=200`,
        `${root}/api/v1/namespaces/${encoded}/pods?limit=200`,
        `${root}/api/v1/namespaces/${encoded}/services?limit=200`,
        `${root}/api/v1/namespaces/${encoded}/persistentvolumeclaims?limit=200`,
        `${root}/apis/networking.k8s.io/v1/namespaces/${encoded}/ingresses?limit=200`,
        `${root}/api/v1/namespaces/${encoded}/events?limit=100`
      ];
      const values = await Promise.all(urls.map((url) => this.options.client.getJson(url, { headers })));
      return { namespace, values };
    });
    const nodeList = records(nodePayload, "NodeList");
    let upstreamTruncated = nodeList.truncated;
    let resources: TopologyResource[] = nodeList.items.map((item) => parseNode(item, this.options.toolUrl));
    for (const { namespace, values } of namespacePayloads) {
      const [namespaceValue, deployments, statefulsets, pods, services, pvcs, ingresses, eventList] = values;
      if (namespaceValue === undefined || deployments === undefined || statefulsets === undefined || pods === undefined || services === undefined || pvcs === undefined || ingresses === undefined || eventList === undefined) throw new UpstreamError("malformed", "Kubernetes topology response is incomplete");
      const deploymentList = records(deployments, "DeploymentList");
      const statefulSetList = records(statefulsets, "StatefulSetList");
      const podList = records(pods, "PodList");
      const serviceList = records(services, "ServiceList");
      const pvcList = records(pvcs, "PersistentVolumeClaimList");
      const ingressList = records(ingresses, "IngressList");
      const eventsList = records(eventList, "EventList");
      upstreamTruncated ||= [deploymentList, statefulSetList, podList, serviceList, pvcList, ingressList, eventsList].some((list) => list.truncated);
      const scoped = [
        parseNamespace(record(namespaceValue, "Namespace"), this.options.toolUrl),
        ...deploymentList.items.map((item) => parseController("Deployment", item, namespace, this.options.toolUrl)),
        ...statefulSetList.items.map((item) => parseController("StatefulSet", item, namespace, this.options.toolUrl)),
        ...podList.items.map((item) => parsePod(item, namespace, this.options.toolUrl)),
        ...serviceList.items.map((item) => parseService(item, namespace, this.options.toolUrl)),
        ...pvcList.items.map((item) => parsePvc(item, namespace, this.options.toolUrl)),
        ...ingressList.items.map((item) => parseIngress(item, namespace, this.options.toolUrl))
      ];
      const events = eventsList.items.map(parseEvent).filter((item): item is NonNullable<ReturnType<typeof parseEvent>> => item !== null);
      resources.push(...scoped.map((resource) => {
        const matches = events.filter((item) => item.targetKind === resource.kind && item.targetName === resource.name).map((item) => item.event).slice(0, 5);
        const failedMount = matches.find((event) => event.reason === "FailedMount");
        return failedMount === undefined ? { ...resource, events: matches } : { ...resource, state: "failing" as const, issueCode: "failed-mount" as const, summary: failedMount.message, events: matches };
      }));
    }
    resources = resources.map((resource) => {
      const serviceIds = selected.filter((service) => service.workloads.some((workload) => workload.kind === resource.kind && workload.namespace === resource.namespace && workload.name === resource.name)).map((service) => service.id);
      return serviceIds.length === 0 ? resource : { ...resource, serviceIds };
    });
    const workloadEdges: TopologyEdge[] = selected.flatMap((service) => service.workloads.map((workload) => ({ from: `service:${service.id}`, to: resourceId(workload.kind, workload.namespace, workload.name), relation: "runs-as" })));
    const schedulingEdges: TopologyEdge[] = resources.filter((resource) => resource.kind === "Pod" && resource.nodeName !== null).map((resource) => ({ from: resource.id, to: resourceId("Node", null, resource.nodeName as string), relation: "scheduled-on" }));
    const edges: TopologyEdge[] = [...workloadEdges, ...schedulingEdges, ...dependencyEdges(selected.map((service) => service.id))];
    const truncated = upstreamTruncated || resources.length > this.options.maxResources;
    return { apiVersion: 1, mode: "live", assembledAt: this.options.now().toISOString(), environment: environment as InventoryEnvironment, namespaces, truncated, resources: resources.slice(0, this.options.maxResources), edges, source: { name: "kubernetes", availability: "available", message: truncated ? `Inventory capped at ${this.options.maxResources} resources` : null } };
  }
}

function dependencyEdges(serviceIds: readonly string[]): TopologyEdge[] {
  const available = new Set(serviceIds); const edges: TopologyEdge[] = [];
  for (const cpq of ["cpq-demo", "cpq-test"]) {
    if (!available.has(cpq)) continue;
    for (const dependency of ["oauth", "mailpit", "erpnet"]) if (available.has(dependency)) edges.push({ from: `service:${cpq}`, to: `service:${dependency}`, relation: "depends-on" });
  }
  for (const id of serviceIds) edges.push({ from: "platform:prometheus", to: `service:${id}`, relation: "observes" });
  edges.push({ from: "probe:gatus-internal", to: "platform:prometheus", relation: "observes" });
  edges.push({ from: "probe:gatus-public-path", to: "platform:prometheus", relation: "observes" });
  return edges;
}

export class UnavailableTopologyReader implements TopologyReader {
  constructor(private readonly message: string, private readonly now: () => Date = () => new Date()) {}
  getTopology(environment: string): Promise<TopologySnapshot> {
    if (!environments.has(environment as InventoryEnvironment)) return Promise.reject(new Error(`Unsupported environment: ${environment}`));
    return Promise.resolve({ apiVersion: 1, mode: "partial", assembledAt: this.now().toISOString(), environment: environment as InventoryEnvironment, namespaces: [], truncated: false, resources: [], edges: [], source: { name: "kubernetes", availability: "unavailable", message: this.message } });
  }
}
