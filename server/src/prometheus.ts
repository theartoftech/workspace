import type { InventoryEnvironment } from "../../shared/inventory";
import type {
  PerformanceMetric,
  PerformanceMetricId,
  PerformanceRange,
  PerformanceSnapshot,
  PerformanceUnit,
  PerformanceWindow
} from "../../shared/performance";
import type { CatalogDefinition, CatalogServiceDefinition } from "./catalog";
import type { JsonHttpClient } from "./http";
import { redactDiagnostic, UpstreamError } from "./http";

interface PrometheusPerformanceReaderOptions {
  readonly apiUrl: string;
  readonly catalog: CatalogDefinition;
  readonly client: JsonHttpClient;
  readonly now?: () => Date;
  readonly concurrency?: number;
}

interface MetricTemplate {
  readonly id: PerformanceMetricId;
  readonly label: string;
  readonly unit: PerformanceUnit;
  readonly threshold: number | null;
  readonly query: string;
}

interface RangeDefinition {
  readonly seconds: number;
  readonly stepSeconds: number;
  readonly rateWindow: string;
}

const rangeDefinitions: Readonly<Record<PerformanceRange, RangeDefinition>> = {
  "15m": { seconds: 900, stepSeconds: 15, rateWindow: "1m" },
  "1h": { seconds: 3_600, stepSeconds: 60, rateWindow: "5m" },
  "6h": { seconds: 21_600, stepSeconds: 300, rateWindow: "5m" },
  "24h": { seconds: 86_400, stepSeconds: 900, rateWindow: "15m" }
};
const environments = new Set<InventoryEnvironment>(["all", "demo", "test", "portfolio", "shared"]);

export class PerformanceRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerformanceRequestError";
  }
}

function labelRegex(values: readonly string[]): string {
  if (values.length === 0) return "a^";
  return values.map((value) => value.replace(/[\\"|.*+?()[\]{}^$]/gu, "\\$&")).join("|");
}

function templates(services: readonly CatalogServiceDefinition[], rateWindow: string, queryWindow: PerformanceRange): readonly MetricTemplate[] {
  const serviceSelector = labelRegex(services.map((service) => service.id));
  const groupSelector = labelRegex([...new Set(services.flatMap((service) => service.probes.map((probe) => probe.group)))]);
  const namespaceSelector = labelRegex([...new Set(services.flatMap((service) => service.workloads.map((workload) => workload.namespace)))]);
  const workloadSelector = labelRegex([...new Set(services.flatMap((service) => service.workloads.map((workload) => workload.name)))]);
  const httpBase = `http_server_requests_seconds_count{service=~"${serviceSelector}",uri!~"/(actuator|health).*"}`;
  const nginxBase = `nginx_http_requests_total{service=~"${serviceSelector}"}`;
  const errorBase = `http_server_requests_seconds_count{service=~"${serviceSelector}",outcome="SERVER_ERROR",uri!~"/(actuator|health).*"}`;
  const synthetic = `gatus_results_duration_seconds{group=~"${groupSelector}"}`;
  return [
    { id: "request-rate", label: "Request rate", unit: "requests/s", threshold: null, query: `sum(rate({__name__=~"http_server_requests_seconds_count|nginx_http_requests_total",service=~"${serviceSelector}"}[${rateWindow}]))` },
    { id: "request-total", label: "Requests in selected window", unit: "requests", threshold: null, query: `sum(increase(${nginxBase}[${queryWindow}]))` },
    { id: "error-rate", label: "Server error rate", unit: "percent", threshold: 1, query: `100 * (sum(rate(${errorBase}[${rateWindow}])) or vector(0)) / clamp_min(sum(rate(${httpBase}[${rateWindow}])), 0.000001)` },
    { id: "latency-p50", label: "Synthetic latency p50", unit: "milliseconds", threshold: null, query: `quantile(0.50, ${synthetic}) * 1000` },
    { id: "latency-p95", label: "Synthetic latency p95", unit: "milliseconds", threshold: 400, query: `quantile(0.95, ${synthetic}) * 1000` },
    { id: "latency-p99", label: "Synthetic latency p99", unit: "milliseconds", threshold: 800, query: `quantile(0.99, ${synthetic}) * 1000` },
    { id: "process-cpu", label: "Application process CPU", unit: "percent", threshold: 80, query: `avg(process_cpu_usage{service=~"${serviceSelector}"}) * 100` },
    { id: "system-cpu", label: "Application host CPU", unit: "percent", threshold: 85, query: `avg(system_cpu_usage{service=~"${serviceSelector}"}) * 100` },
    { id: "jvm-heap", label: "JVM heap utilization", unit: "percent", threshold: 80, query: `100 * sum(jvm_memory_used_bytes{service=~"${serviceSelector}",area="heap"}) / clamp_min(sum(jvm_memory_max_bytes{service=~"${serviceSelector}",area="heap"}), 1)` },
    { id: "host-memory", label: "Lab host memory utilization", unit: "percent", threshold: 85, query: "100 * (1 - avg(node_memory_MemAvailable_bytes{job=\"node-exporter\"}) / clamp_min(avg(node_memory_MemTotal_bytes{job=\"node-exporter\"}), 1))" },
    { id: "db-pool-saturation", label: "Database pool saturation", unit: "percent", threshold: 80, query: `100 * sum(hikaricp_connections_active{service=~"${serviceSelector}"}) / clamp_min(sum(hikaricp_connections_max{service=~"${serviceSelector}"}), 1)` },
    { id: "pod-restarts", label: "Pod restarts", unit: "restarts", threshold: 1, query: `sum(increase(kube_pod_container_status_restarts_total{namespace=~"${namespaceSelector}",pod=~"${workloadSelector}.*"}[${rateWindow}]))` }
  ];
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UpstreamError("malformed", `Prometheus returned malformed ${context}`);
  return value as Record<string, unknown>;
}

function parsePoints(payload: unknown): readonly { readonly timestamp: string; readonly value: number }[] {
  const root = record(payload, "response");
  if (root.status !== "success") throw new UpstreamError("http", "Prometheus rejected an allow-listed query");
  const data = record(root.data, "data");
  if (data.resultType !== "matrix" || !Array.isArray(data.result)) throw new UpstreamError("malformed", "Prometheus returned a non-matrix range result");
  if (data.result.length === 0) return [];
  if (data.result.length !== 1) throw new UpstreamError("malformed", "Prometheus returned multiple series for an aggregated query");
  const series = record(data.result[0], "series");
  if (!Array.isArray(series.values)) throw new UpstreamError("malformed", "Prometheus returned a series without values");
  return series.values.map((sample, index) => {
    if (!Array.isArray(sample) || sample.length !== 2 || typeof sample[0] !== "number" || typeof sample[1] !== "string") {
      throw new UpstreamError("malformed", `Prometheus returned malformed sample ${index}`);
    }
    const value = Number(sample[1]);
    const timestamp = new Date(sample[0] * 1000);
    if (!Number.isFinite(value) || Number.isNaN(timestamp.getTime())) throw new UpstreamError("malformed", `Prometheus returned invalid sample ${index}`);
    return { timestamp: timestamp.toISOString(), value };
  });
}

async function mapConcurrent<Input, Output>(
  items: readonly Input[],
  concurrency: number,
  operation: (item: Input) => Promise<Output>
): Promise<readonly PromiseSettledResult<Output>[]> {
  const results = Array.from(
    { length: items.length },
    (): PromiseSettledResult<Output> | undefined => undefined
  );
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await operation(items[index] as Input) };
      } catch (reason: unknown) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results as readonly PromiseSettledResult<Output>[];
}

function observedAt(metrics: readonly PerformanceMetric[]): string | null {
  return metrics.flatMap((metric) => metric.points.map((point) => point.timestamp)).reduce<string | null>(
    (latest, timestamp) => latest === null || timestamp > latest ? timestamp : latest,
    null
  );
}

export class PrometheusPerformanceReader {
  private readonly options: Required<Pick<PrometheusPerformanceReaderOptions, "apiUrl" | "catalog" | "client" | "now" | "concurrency">>;

  constructor(options: PrometheusPerformanceReaderOptions) {
    if (!Number.isInteger(options.concurrency ?? 4) || (options.concurrency ?? 4) < 1 || (options.concurrency ?? 4) > 8) {
      throw new Error("Prometheus concurrency must be 1..8");
    }
    this.options = { ...options, now: options.now ?? (() => new Date()), concurrency: options.concurrency ?? 4 };
  }

  async getPerformance(environment: string, serviceId: string, range: string): Promise<PerformanceSnapshot> {
    if (!environments.has(environment as InventoryEnvironment)) throw new PerformanceRequestError(`Unsupported environment: ${environment}`);
    if (!Object.hasOwn(rangeDefinitions, range)) throw new PerformanceRequestError(`Unsupported performance range: ${range}`);
    const definition = rangeDefinitions[range as PerformanceRange];
    const environmentServices = this.options.catalog.services.filter((service) => environment === "all" || service.environment === environment);
    if (serviceId !== "all" && !this.options.catalog.services.some((service) => service.id === serviceId)) {
      throw new PerformanceRequestError(`Unsupported service: ${serviceId}`);
    }
    const selectedServices = serviceId === "all" ? environmentServices : environmentServices.filter((service) => service.id === serviceId);
    if (selectedServices.length === 0) throw new PerformanceRequestError(`Service '${serviceId}' is outside the selected environment`);

    const end = this.options.now();
    const start = new Date(end.getTime() - definition.seconds * 1000);
    const window: PerformanceWindow = {
      range: range as PerformanceRange,
      start: start.toISOString(),
      end: end.toISOString(),
      stepSeconds: definition.stepSeconds,
      maxPoints: Math.floor(definition.seconds / definition.stepSeconds) + 1
    };
    const metricTemplates = templates(selectedServices, definition.rateWindow, range as PerformanceRange);
    const settled = await mapConcurrent(metricTemplates, this.options.concurrency, async (template) => {
      const url = new URL("/api/v1/query_range", `${this.options.apiUrl}/`);
      url.searchParams.set("query", template.query);
      url.searchParams.set("start", String(start.getTime() / 1000));
      url.searchParams.set("end", String(end.getTime() / 1000));
      url.searchParams.set("step", String(definition.stepSeconds));
      return parsePoints(await this.options.client.getJson(url.toString()));
    });
    const metrics = metricTemplates.map((template, index): PerformanceMetric => {
      const metadata = { id: template.id, label: template.label, unit: template.unit, threshold: template.threshold };
      const result = settled[index];
      if (result === undefined || result.status === "rejected") {
        const cause = result?.status === "rejected" ? result.reason as unknown : new Error("Query did not complete");
        return {
          ...metadata,
          status: "error",
          points: [],
          latest: null,
          message: redactDiagnostic(cause instanceof Error ? cause.message : "Unknown Prometheus query error")
        };
      }
      const points = result.value;
      return {
        ...metadata,
        status: points.length === 0 ? "no-data" : "ok",
        points,
        latest: points.at(-1)?.value ?? null,
        message: points.length === 0 ? "Prometheus returned no series for this metric." : null
      };
    });
    const errors = metrics.filter((metric) => metric.status === "error").length;
    return {
      apiVersion: 1,
      mode: errors === 0 ? "live" : "partial",
      assembledAt: end.toISOString(),
      observedAt: observedAt(metrics),
      environment: environment as InventoryEnvironment,
      serviceId,
      window,
      source: {
        name: "prometheus",
        availability: errors === 0 ? "available" : errors === metrics.length ? "unavailable" : "partial",
        message: errors === 0 ? null : `${errors} of ${metrics.length} allow-listed queries failed.`
      },
      metrics
    };
  }
}
