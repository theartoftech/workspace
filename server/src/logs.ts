import type {
  CorrelatedKubernetesEvent,
  LogCorrelationSnapshot,
  LogEntry,
  LogOmission,
  LogPod,
  LogQuery,
  LogSeverity,
  LogSourceAvailability,
  LogSourceStatus
} from "../../shared/logs";
import type { InventoryEnvironment } from "../../shared/inventory";
import type { PerformanceRange } from "../../shared/performance";
import type { CatalogDefinition, CatalogServiceDefinition } from "./catalog";
import type { JsonHttpClient, TextHttpClient } from "./http";
import { redactDiagnostic, UpstreamError } from "./http";

export interface LogReader {
  getLogs(query: LogQuery): Promise<LogCorrelationSnapshot>;
}

export interface KubernetesLogReaderOptions {
  readonly apiUrl: string;
  readonly bearerToken: string;
  readonly catalog: CatalogDefinition;
  readonly jsonClient: JsonHttpClient;
  readonly textClient: TextHttpClient;
  readonly maxPods?: number;
  readonly maxStreams?: number;
  readonly maxEntries?: number;
  readonly maxEvents?: number;
  readonly concurrency?: number;
  readonly now?: () => Date;
}

export class LogRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogRequestError";
  }
}

interface KubernetesList {
  readonly items: readonly Record<string, unknown>[];
  readonly truncated: boolean;
}

interface DiscoveredPod extends LogPod {
  readonly labels: Readonly<Record<string, string>>;
  readonly restartedContainers: ReadonlySet<string>;
}

interface LogStream {
  readonly pod: DiscoveredPod;
  readonly container: string;
  readonly previous: boolean;
}

interface ReaderLimits {
  readonly maxPods: number;
  readonly maxStreams: number;
  readonly maxEntries: number;
  readonly maxEventsPerObject: 5;
  readonly maxEvents: number;
}

const environments = new Set<InventoryEnvironment>(["all", "demo", "test", "portfolio"]);
const ranges = new Set<PerformanceRange>(["15m", "1h", "6h", "24h"]);
const severities = new Set(["all", "error", "warning", "info", "debug", "unknown"]);
const rangeMilliseconds: Readonly<Record<PerformanceRange, number>> = { "15m": 900_000, "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000 };
const podNamePattern = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/u;
const correlationKeys = ["correlationId", "correlation_id", "traceId", "trace_id", "requestId", "request_id", "x-correlation-id"] as const;
const MAX_EVENTS_PER_OBJECT = 5;
const REDACTION_DESCRIPTION = "Credential-bearing URLs, headers, key/value pairs, bearer tokens, and common JSON secret fields are replaced before response assembly.";

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UpstreamError("malformed", `Kubernetes returned malformed ${context}`);
  return value as Record<string, unknown>;
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key];
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {};
}

function records(value: unknown, context: string): KubernetesList {
  const raw = record(value, context);
  if (!Array.isArray(raw.items)) throw new UpstreamError("malformed", `Kubernetes returned malformed ${context}.items`);
  const metadata = nested(raw, "metadata");
  return {
    items: raw.items.map((item, index) => record(item, `${context}.items[${index}]`)),
    truncated: typeof metadata.continue === "string" && metadata.continue !== ""
  };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function validateQuery(catalog: CatalogDefinition, query: LogQuery): CatalogServiceDefinition {
  if (!environments.has(query.environment)) throw new LogRequestError(`Unsupported environment: ${query.environment}`);
  if (!ranges.has(query.range)) throw new LogRequestError(`Unsupported log range: ${query.range}`);
  if (!severities.has(query.severity)) throw new LogRequestError(`Unsupported log severity: ${query.severity}`);
  if (query.serviceId.trim() === "" || query.serviceId.length > 100 || hasControlCharacter(query.serviceId)) throw new LogRequestError("A valid service id is required");
  if (query.pod !== null && !podNamePattern.test(query.pod)) throw new LogRequestError("Pod filter must be a valid Kubernetes pod name");
  if (query.query.length > 100 || hasControlCharacter(query.query)) throw new LogRequestError("Log search must contain at most 100 printable characters");
  if (query.correlationId.length > 128 || hasControlCharacter(query.correlationId)) throw new LogRequestError("Correlation id must contain at most 128 printable characters");
  const service = catalog.services.find((item) => item.id === query.serviceId);
  if (service === undefined) throw new LogRequestError(`Unsupported service: ${query.serviceId}`);
  if (query.environment !== "all" && service.environment !== query.environment) throw new LogRequestError(`Service ${query.serviceId} is not in environment ${query.environment}`);
  return service;
}

function parsePod(value: Record<string, unknown>, fallbackNamespace: string): DiscoveredPod {
  const metadata = nested(value, "metadata");
  const spec = nested(value, "spec");
  const status = nested(value, "status");
  if (typeof metadata.name !== "string" || metadata.name === "" || !Array.isArray(spec.containers) || spec.containers.length === 0) {
    throw new UpstreamError("malformed", "Kubernetes returned malformed Pod identity or containers");
  }
  const namespace = typeof metadata.namespace === "string" ? metadata.namespace : fallbackNamespace;
  const containers = spec.containers.map((item, index) => {
    const parsed = record(item, `Pod containers[${index}]`);
    if (typeof parsed.name !== "string" || parsed.name === "") throw new UpstreamError("malformed", "Kubernetes returned malformed Pod container name");
    return parsed.name;
  });
  const statuses = Array.isArray(status.containerStatuses) ? status.containerStatuses.map((item, index) => record(item, `Pod containerStatuses[${index}]`)) : [];
  const restartedContainers = new Set(statuses.filter((item) => typeof item.name === "string" && typeof item.restartCount === "number" && Number.isInteger(item.restartCount) && item.restartCount > 0).map((item) => item.name as string));
  const restartCount = statuses.reduce((sum, item) => sum + (typeof item.restartCount === "number" && Number.isInteger(item.restartCount) && item.restartCount >= 0 ? item.restartCount : 0), 0);
  const rawLabels = nested(metadata, "labels");
  const labels = Object.fromEntries(Object.entries(rawLabels).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return { namespace, name: metadata.name, containers, restartCount, labels, restartedContainers };
}

function selector(value: unknown): Readonly<Record<string, string>> {
  const raw = record(value, "Deployment");
  const labels = nested(nested(raw, "spec"), "selector").matchLabels;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) throw new UpstreamError("malformed", "Kubernetes Deployment selector.matchLabels is missing");
  const parsed = Object.fromEntries(Object.entries(labels as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (Object.keys(parsed).length === 0) throw new UpstreamError("malformed", "Kubernetes Deployment selector.matchLabels is empty");
  return parsed;
}

function matchesSelector(pod: DiscoveredPod, labels: Readonly<Record<string, string>>): boolean {
  return Object.entries(labels).every(([key, value]) => pod.labels[key] === value);
}

async function mapConcurrent<Input, Output>(items: readonly Input[], concurrency: number, mapper: (item: Input) => Promise<Output>): Promise<readonly Output[]> {
  const output = new Array<Output>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) output[index] = await mapper(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

function normalizedTimestamp(value: string): string | null {
  const normalized = value.replace(/\.(\d{3})\d+(?=Z$)/u, ".$1");
  const time = Date.parse(normalized);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function severity(message: string): LogSeverity {
  try {
    const json = JSON.parse(message) as unknown;
    if (typeof json === "object" && json !== null && !Array.isArray(json)) {
      const level = (json as Record<string, unknown>).level;
      if (typeof level === "string") return severity(level);
    }
  } catch { /* plain text log */ }
  if (/\b(?:fatal|error|err)\b/iu.test(message)) return "error";
  if (/\b(?:warn|warning)\b/iu.test(message)) return "warning";
  if (/\b(?:debug|trace)\b/iu.test(message)) return "debug";
  if (/\binfo\b/iu.test(message)) return "info";
  return "unknown";
}

function correlationId(message: string): string | null {
  try {
    const json = JSON.parse(message) as unknown;
    if (typeof json === "object" && json !== null && !Array.isArray(json)) {
      const raw = json as Record<string, unknown>;
      for (const key of correlationKeys) {
        const value = raw[key];
        if (typeof value === "string" && /^[A-Za-z0-9._:-]{3,128}$/u.test(value)) return value;
      }
    }
  } catch { /* plain text log */ }
  const match = /\b(?:correlation[_-]?id|trace[_-]?id|request[_-]?id|x-correlation-id)["']?\s*[:=]\s*["']?([A-Za-z0-9._:-]{3,128})/iu.exec(message);
  return match?.[1] ?? null;
}

function parseLogLines(stream: LogStream, payload: string): readonly LogEntry[] {
  return payload.split(/\r?\n/u).filter((line) => line !== "").map((line, index) => {
    const split = /^(\S+)\s(.*)$/u.exec(line);
    const timestamp = split === null ? null : normalizedTimestamp(split[1] ?? "");
    const rawMessage = timestamp === null ? line : split?.[2] ?? line;
    const safeMessage = redactDiagnostic(rawMessage).slice(0, 8192);
    return {
      id: `${stream.pod.namespace}/${stream.pod.name}/${stream.container}/${stream.previous ? "previous" : "current"}/${index}`,
      timestamp,
      namespace: stream.pod.namespace,
      pod: stream.pod.name,
      container: stream.container,
      previous: stream.previous,
      severity: severity(rawMessage),
      message: safeMessage,
      correlationId: correlationId(rawMessage)
    };
  });
}

function genericReason(cause: unknown): string {
  if (cause instanceof UpstreamError) {
    if (cause.code === "unauthorized") return "Read-only Kubernetes access was denied.";
    if (cause.code === "timeout") return "The bounded Kubernetes request timed out.";
    if (cause.code === "malformed") return "Kubernetes returned malformed or oversized evidence.";
  }
  return "Kubernetes evidence could not be retrieved.";
}

function source(name: LogSourceStatus["name"], availability: LogSourceAvailability, message: string | null): LogSourceStatus {
  return { name, availability, message };
}

function appliedFilters(query: LogQuery): LogCorrelationSnapshot["filters"] {
  return {
    environment: query.environment, serviceId: query.serviceId, range: query.range, pod: query.pod, severity: query.severity,
    queryApplied: query.query !== "", correlationIdApplied: query.correlationId !== ""
  };
}

function emptySnapshot(service: CatalogServiceDefinition, query: LogQuery, now: Date, limits: ReaderLimits, message: string): LogCorrelationSnapshot {
  const end = now.toISOString();
  const start = new Date(now.getTime() - rangeMilliseconds[query.range]).toISOString();
  return {
    apiVersion: 1, mode: "partial", assembledAt: end,
    service: { id: service.id, name: service.displayName, environment: service.environment },
    window: { range: query.range, start, end }, filters: appliedFilters(query), limits, truncated: false, pods: [], entries: [], events: [],
    sources: [source("kubernetes-pod-logs", "unavailable", message), source("kubernetes-events", "unavailable", message)],
    omissions: [{ source: "workload-discovery", scope: service.id, reason: message }],
    redaction: { applied: true, replacement: "[REDACTED]", description: REDACTION_DESCRIPTION }
  };
}

export class KubernetesLogReader implements LogReader {
  private readonly options: Required<Omit<KubernetesLogReaderOptions, "maxPods" | "maxStreams" | "maxEntries" | "maxEvents" | "concurrency" | "now">> & ReaderLimits & { readonly concurrency: number; readonly now: () => Date };

  constructor(options: KubernetesLogReaderOptions) {
    if (options.apiUrl.trim() === "" || options.bearerToken.trim() === "") throw new Error("Kubernetes apiUrl and bearerToken are required");
    const maxPods = options.maxPods ?? 8;
    const maxStreams = options.maxStreams ?? 16;
    const maxEntries = options.maxEntries ?? 500;
    const maxEvents = options.maxEvents ?? 50;
    const concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(maxPods) || maxPods < 1 || maxPods > 20) throw new Error("Log maxPods must be 1..20");
    if (!Number.isInteger(maxStreams) || maxStreams < 1 || maxStreams > 40) throw new Error("Log maxStreams must be 1..40");
    if (!Number.isInteger(maxEntries) || maxEntries < 10 || maxEntries > 1000) throw new Error("Log maxEntries must be 10..1000");
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 100) throw new Error("Log maxEvents must be 1..100");
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Log concurrency must be 1..8");
    this.options = { ...options, maxPods, maxStreams, maxEntries, maxEventsPerObject: MAX_EVENTS_PER_OBJECT, maxEvents, concurrency, now: options.now ?? (() => new Date()) };
  }

  async getLogs(query: LogQuery): Promise<LogCorrelationSnapshot> {
    const service = validateQuery(this.options.catalog, query);
    const now = this.options.now();
    const limits: ReaderLimits = { maxPods: this.options.maxPods, maxStreams: this.options.maxStreams, maxEntries: this.options.maxEntries, maxEventsPerObject: MAX_EVENTS_PER_OBJECT, maxEvents: this.options.maxEvents };
    if (service.workloads.length === 0) return emptySnapshot(service, query, now, limits, "No Kubernetes workload mapping exists for this service.");

    const end = now.toISOString();
    const start = new Date(now.getTime() - rangeMilliseconds[query.range]).toISOString();
    const root = this.options.apiUrl.replace(/\/$/u, "");
    const headers = { Authorization: `Bearer ${this.options.bearerToken}`, Accept: "application/json" };
    const omissions: LogOmission[] = [];
    let upstreamTruncated = false;
    let podsTruncated = false;
    let discovered: readonly DiscoveredPod[] = [];
    let discoveryFailure: string | null = null;

    try {
      const namespaces = [...new Set(service.workloads.map((workload) => workload.namespace))].sort();
      const lists = await mapConcurrent(namespaces, this.options.concurrency, async (namespace) => {
        const payload = await this.options.jsonClient.getJson(`${root}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?limit=200`, { headers });
        const list = records(payload, "PodList");
        return { namespace, pods: list.items.map((item) => parsePod(item, namespace)), truncated: list.truncated };
      });
      upstreamTruncated = lists.some((item) => item.truncated);
      const byNamespace = new Map(lists.map((item) => [item.namespace, item.pods] as const));
      const matches = await mapConcurrent(service.workloads, this.options.concurrency, async (workload): Promise<readonly DiscoveredPod[]> => {
        const pods = byNamespace.get(workload.namespace) ?? [];
        if (workload.kind === "Pod") return pods.filter((pod) => pod.name === workload.name);
        const payload = await this.options.jsonClient.getJson(`${root}/apis/apps/v1/namespaces/${encodeURIComponent(workload.namespace)}/deployments/${encodeURIComponent(workload.name)}`, { headers });
        const labels = selector(payload);
        return pods.filter((pod) => matchesSelector(pod, labels));
      });
      const unique = new Map(matches.flat().map((pod) => [`${pod.namespace}/${pod.name}`, pod] as const));
      let selected = [...unique.values()].sort((left, right) => `${left.namespace}/${left.name}`.localeCompare(`${right.namespace}/${right.name}`));
      if (query.pod !== null) {
        selected = selected.filter((pod) => pod.name === query.pod);
        if (selected.length === 0) throw new LogRequestError(`Pod ${query.pod} is not mapped to service ${service.id}`);
      }
      if (selected.length > this.options.maxPods) {
        podsTruncated = true;
        omissions.push({ source: "workload-discovery", scope: service.id, reason: `Pod results were capped at ${this.options.maxPods}.` });
        selected = selected.slice(0, this.options.maxPods);
      }
      discovered = selected;
      if (selected.length === 0) omissions.push({ source: "workload-discovery", scope: service.id, reason: "No currently listed pod matches the catalog workload mapping." });
    } catch (cause: unknown) {
      if (cause instanceof LogRequestError) throw cause;
      discoveryFailure = genericReason(cause);
      omissions.push({ source: "workload-discovery", scope: service.id, reason: discoveryFailure });
    }

    const currentStreams: LogStream[] = discovered.flatMap((pod) => pod.containers.map((container) => ({ pod, container, previous: false })));
    const previousStreams: LogStream[] = discovered.flatMap((pod) => pod.containers.filter((container) => pod.restartedContainers.has(container)).map((container) => ({ pod, container, previous: true })));
    const candidates = [...currentStreams, ...previousStreams];
    const streams = candidates.slice(0, this.options.maxStreams);
    if (candidates.length > streams.length) omissions.push({ source: "kubernetes-pod-logs", scope: service.id, reason: `Log streams were capped at ${this.options.maxStreams}.` });

    const streamResults = await mapConcurrent(streams, this.options.concurrency, async (stream) => {
      const parameters = new URLSearchParams({ container: stream.container, timestamps: "true", sinceTime: start, tailLines: "200", limitBytes: "65536" });
      if (stream.previous) parameters.set("previous", "true");
      const url = `${root}/api/v1/namespaces/${encodeURIComponent(stream.pod.namespace)}/pods/${encodeURIComponent(stream.pod.name)}/log?${parameters.toString()}`;
      try {
        const payload = await this.options.textClient.getText(url, { headers: { ...headers, Accept: "text/plain" }, maxBytes: 65_536 });
        return { stream, entries: parseLogLines(stream, payload), error: null } as const;
      } catch (cause: unknown) {
        return { stream, entries: [] as readonly LogEntry[], error: genericReason(cause) } as const;
      }
    });
    for (const failed of streamResults.filter((result) => result.error !== null)) {
      omissions.push({ source: "kubernetes-pod-logs", scope: `${failed.stream.pod.namespace}/${failed.stream.pod.name}/${failed.stream.container}${failed.stream.previous ? " (previous)" : ""}`, reason: failed.error });
    }
    const text = query.query.trim().toLowerCase();
    const correlation = query.correlationId.trim().toLowerCase();
    let entries = streamResults.flatMap((result) => result.entries).filter((entry) =>
      (query.severity === "all" || entry.severity === query.severity)
      && (text === "" || entry.message.toLowerCase().includes(text))
      && (correlation === "" || entry.correlationId?.toLowerCase() === correlation)
    ).sort((left, right) => (right.timestamp ?? "").localeCompare(left.timestamp ?? ""));
    const entriesTruncated = entries.length > this.options.maxEntries;
    entries = entries.slice(0, this.options.maxEntries);

    const eventTargets = new Set<string>([
      ...service.workloads.map((workload) => `${workload.namespace}/${workload.kind}/${workload.name}`),
      ...discovered.map((pod) => `${pod.namespace}/Pod/${pod.name}`)
    ]);
    const eventNamespaces = [...new Set(service.workloads.map((workload) => workload.namespace))].sort();
    const eventResults = await mapConcurrent(eventNamespaces, this.options.concurrency, async (namespace) => {
      try {
        const payload = await this.options.jsonClient.getJson(`${root}/api/v1/namespaces/${encodeURIComponent(namespace)}/events?limit=100`, { headers });
        const list = records(payload, "EventList");
        return { namespace, list, error: null } as const;
      } catch (cause: unknown) {
        return { namespace, list: { items: [], truncated: false }, error: genericReason(cause) } as const;
      }
    });
    const eventFailures = eventResults.filter((result) => result.error !== null);
    for (const failed of eventFailures) omissions.push({ source: "kubernetes-events", scope: failed.namespace, reason: failed.error });
    upstreamTruncated ||= eventResults.some((result) => result.list.truncated);
    const correlatedEvents: CorrelatedKubernetesEvent[] = eventResults.flatMap(({ namespace, list }) => list.items.flatMap((item, index) => {
      const metadata = nested(item, "metadata");
      const involved = nested(item, "involvedObject");
      if (typeof involved.kind !== "string" || typeof involved.name !== "string") return [];
      const eventNamespace = typeof metadata.namespace === "string" ? metadata.namespace : namespace;
      if (!eventTargets.has(`${eventNamespace}/${involved.kind}/${involved.name}`)) return [];
      const rawTimestamp = typeof item.eventTime === "string" ? item.eventTime : typeof item.lastTimestamp === "string" ? item.lastTimestamp : typeof item.firstTimestamp === "string" ? item.firstTimestamp : "";
      const timestamp = normalizedTimestamp(rawTimestamp);
      if (timestamp === null || timestamp < start || timestamp > end) return [];
      return [{
        id: typeof metadata.uid === "string" ? metadata.uid : `${eventNamespace}/${involved.kind}/${involved.name}/${index}`,
        timestamp, namespace: eventNamespace, targetKind: involved.kind, targetName: involved.name,
        type: item.type === "Normal" || item.type === "Warning" ? item.type : "Unknown",
        reason: redactDiagnostic(typeof item.reason === "string" ? item.reason : "Unknown"),
        message: redactDiagnostic(typeof item.message === "string" ? item.message : "No event message")
      } satisfies CorrelatedKubernetesEvent];
    })).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    const eventCountByObject = new Map<string, number>();
    const cappedEventObjects = new Set<string>();
    const perObjectBoundedEvents = correlatedEvents.filter((event) => {
      const key = `${event.namespace}/${event.targetKind}/${event.targetName}`;
      const count = eventCountByObject.get(key) ?? 0;
      if (count >= MAX_EVENTS_PER_OBJECT) {
        cappedEventObjects.add(key);
        return false;
      }
      eventCountByObject.set(key, count + 1);
      return true;
    });
    for (const key of [...cappedEventObjects].sort()) {
      omissions.push({ source: "kubernetes-events", scope: key, reason: `Recent events were capped at ${MAX_EVENTS_PER_OBJECT} for this object.` });
    }
    const eventsTruncated = perObjectBoundedEvents.length < correlatedEvents.length || perObjectBoundedEvents.length > this.options.maxEvents;
    const events = perObjectBoundedEvents.slice(0, this.options.maxEvents);

    const streamFailures = streamResults.filter((result) => result.error !== null).length;
    const successes = streamResults.length - streamFailures;
    const logsAvailability: LogSourceAvailability = discoveryFailure !== null || successes === 0 ? "unavailable" : streamFailures > 0 ? "partial" : "available";
    const eventsAvailability: LogSourceAvailability = eventFailures.length === 0 ? "available" : eventFailures.length < eventResults.length ? "partial" : "unavailable";
    const truncated = upstreamTruncated || podsTruncated || candidates.length > streams.length || entriesTruncated || eventsTruncated;
    const logMessage = discoveryFailure ?? (discovered.length === 0 ? "No currently listed pod matches the catalog workload mapping." : streamFailures > 0 ? `${streamFailures} bounded log stream request${streamFailures === 1 ? "" : "s"} failed.` : null);
    const sources: readonly LogSourceStatus[] = [
      source("kubernetes-pod-logs", logsAvailability, logMessage),
      source("kubernetes-events", eventsAvailability, eventFailures.length > 0 ? `${eventFailures.length} namespace event request${eventFailures.length === 1 ? "" : "s"} failed.` : null)
    ];
    const mode = sources.every((item) => item.availability === "available") && omissions.length === 0 && !truncated ? "live" : "partial";
    return {
      apiVersion: 1, mode, assembledAt: end,
      service: { id: service.id, name: service.displayName, environment: service.environment },
      window: { range: query.range, start, end }, filters: appliedFilters(query), limits, truncated,
      pods: discovered.map(({ namespace, name, containers, restartCount }) => ({ namespace, name, containers, restartCount })),
      entries, events, sources, omissions,
      redaction: { applied: true, replacement: "[REDACTED]", description: REDACTION_DESCRIPTION }
    };
  }
}

export class UnavailableLogReader implements LogReader {
  constructor(private readonly catalog: CatalogDefinition, private readonly message: string, private readonly now: () => Date = () => new Date()) {}

  getLogs(query: LogQuery): Promise<LogCorrelationSnapshot> {
    const service = validateQuery(this.catalog, query);
    return Promise.resolve(emptySnapshot(service, query, this.now(), { maxPods: 8, maxStreams: 16, maxEntries: 500, maxEventsPerObject: MAX_EVENTS_PER_OBJECT, maxEvents: 50 }, redactDiagnostic(this.message)));
  }
}
