import {
  ArrowUpRightIcon,
  CheckCircleIcon,
  CloudIcon,
  CodeIcon,
  DatabaseIcon,
  EnvelopeSimpleIcon,
  GaugeIcon,
  GitBranchIcon,
  GlobeHemisphereWestIcon,
  HardDrivesIcon,
  IdentificationCardIcon,
  ShieldCheckIcon,
  StackIcon,
  TrendUpIcon,
  UsersThreeIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Link, useParams } from "react-router-dom";

import type { PerformanceMetric, PerformanceMetricId } from "../../../shared/performance";
import { StateGallery } from "../components/StateGallery";
import { StatusBadge } from "../components/StatusBadge";
import type { MonitoringProvider, OverviewSnapshot, PerformanceSnapshot, TimeRange } from "../data/types";

interface SnapshotPageProps {
  readonly snapshot: OverviewSnapshot;
}

interface PageHeaderProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly action?: React.ReactNode;
}

function PageHeader({ eyebrow, title, description, action }: PageHeaderProps): React.JSX.Element {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}

function PanelHeader({ title, meta }: { readonly title: string; readonly meta: string }): React.JSX.Element {
  return (
    <div className="panel-header">
      <div>
        <h2>{title}</h2>
        <span>{meta}</span>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
  tone = "neutral",
  icon: Icon
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly tone?: "neutral" | "positive" | "warning" | "danger";
  readonly icon: React.ComponentType<{ readonly size?: number; readonly "aria-hidden"?: boolean }>;
}): React.JSX.Element {
  return (
    <article className={`metric-card metric-${tone}`}>
      <div className="metric-card-top">
        <span>{label}</span>
        <Icon aria-hidden={true} size={18} />
      </div>
      <strong>{value}</strong>
      <p>{note}</p>
    </article>
  );
}

type ServiceRow = OverviewSnapshot["services"][number];

function formattedTimestamp(value: string | null): string {
  if (value === null) return "No observation";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "Invalid source timestamp" : timestamp.toLocaleString();
}

function ServiceTable({ services }: { readonly services: readonly ServiceRow[] }): React.JSX.Element {
  const serviceIcons = {
    application: CloudIcon,
    identity: IdentificationCardIcon,
    mail: EnvelopeSimpleIcon,
    erp: DatabaseIcon
  } as const;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Status</th>
            <th scope="col">Environment</th>
            <th scope="col">Reachability</th>
            <th scope="col">Endpoint</th>
            <th scope="col">Version</th>
            <th scope="col">Owner</th>
          </tr>
        </thead>
        <tbody>
          {services.map((service) => {
            const ServiceIcon = serviceIcons[service.kind];
            return <tr key={service.id}>
              <td>
                <div className="service-name-cell">
                  <span className={`service-icon service-icon-${service.kind}`}><ServiceIcon aria-hidden="true" size={17} /></span>
                  <div>
                    <Link to={`/services/${service.id}`}><strong>{service.name}</strong></Link>
                    <span>{formattedTimestamp(service.lastCheckedAt)}</span>
                  </div>
                </div>
              </td>
              <td><StatusBadge status={service.state} /></td>
              <td><span className="environment-chip">{service.environment}</span></td>
              <td><span className={`comparison comparison-${service.reachability.comparison}`}>{service.reachability.comparison.replace("-", " ")}</span></td>
              <td><a className="endpoint-link" href={service.endpoint} target="_blank" rel="noreferrer">{service.endpoint}</a></td>
              <td><code>{service.version ?? "Unavailable"}</code></td>
              <td>{service.owner}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OverviewPage({ snapshot }: SnapshotPageProps): React.JSX.Element {
  const affected = snapshot.summary.degraded + snapshot.summary.failing + snapshot.summary.unknown + snapshot.summary.stale;
  const availableSources = snapshot.sources.filter((source) => source.availability === "available").length;
  const disagreements = snapshot.services.filter((service) => service.reachability.comparison === "disagreement");
  return (
    <>
      <PageHeader
        eyebrow="Operations / Overview"
        title="Fleet overview"
        description="Live catalog, reachability, and workload state across the development lab."
      />

      <section className="metrics-grid" aria-label="Fleet summary">
        <MetricCard label="Services healthy" value={`${snapshot.summary.healthy}/${snapshot.summary.total}`} note={`${affected} require attention`} tone={affected > 0 ? "warning" : "positive"} icon={CheckCircleIcon} />
        <MetricCard label="Failing" value={String(snapshot.summary.failing)} note={`${snapshot.summary.degraded} degraded · ${snapshot.summary.stale} stale`} tone={snapshot.summary.failing > 0 ? "danger" : "positive"} icon={WarningCircleIcon} />
        <MetricCard label="Sources available" value={`${availableSources}/${snapshot.sources.length}`} note={snapshot.mode === "partial" ? "Partial evidence retained" : "All collectors current"} tone={snapshot.mode === "partial" ? "warning" : "positive"} icon={DatabaseIcon} />
        <MetricCard label="Reachability conflicts" value={String(disagreements.length)} note="Internal vs public path" tone={disagreements.length > 0 ? "warning" : "positive"} icon={GlobeHemisphereWestIcon} />
      </section>

      <section className="overview-grid">
        <article className="panel source-panel">
          <PanelHeader title="Source freshness" meta={`Assembled ${formattedTimestamp(snapshot.generatedAt)}`} />
          <div className="source-list">
            {snapshot.sources.map((source) => (
              <div className="source-row" key={source.source}>
                <div><strong>{source.source.replaceAll("-", " ")}</strong><span>{formattedTimestamp(source.observedAt)}</span></div>
                <span className={`source-availability source-${source.availability}`}>{source.availability}</span>
                {source.message && <p>{source.message}</p>}
                {source.toolUrl && !source.toolUrl.startsWith("#") && <a href={source.toolUrl} target="_blank" rel="noreferrer">Open source <ArrowUpRightIcon aria-hidden="true" size={14} /></a>}
              </div>
            ))}
          </div>
        </article>

        <article className="panel reachability-panel">
          <PanelHeader title="Reachability comparison" meta="Internal vs public-path probes" />
          <div className="reachability-list">
            {snapshot.services.filter((service) => service.reachability.comparison !== "not-configured").map((service) => (
              <div className={`reachability-row comparison-${service.reachability.comparison}`} key={service.id}>
                <Link to={`/services/${service.id}`}><strong>{service.name}</strong></Link>
                <div><span>Internal</span>{service.reachability.internal ? <StatusBadge status={service.reachability.internal} /> : <em>Not observed</em>}</div>
                <div><span>Public path</span>{service.reachability.external ? <StatusBadge status={service.reachability.external} /> : <em>Not observed</em>}</div>
                <small>{service.reachability.comparison.replace("-", " ")}</small>
              </div>
            ))}
            {snapshot.services.every((service) => service.reachability.comparison === "not-configured") && <p className="empty-panel-copy">No paired internal/public-path probes in this scope.</p>}
          </div>
        </article>
      </section>

      <section>
        <article className="panel services-panel inventory-panel">
          <PanelHeader title="Service inventory" meta={`${snapshot.services.length} services in current scope`} />
          <ServiceTable services={snapshot.services} />
        </article>
      </section>
    </>
  );
}

export function ServiceDetailPage({ snapshot }: SnapshotPageProps): React.JSX.Element {
  const { serviceId } = useParams<{ readonly serviceId: string }>();
  const service = snapshot.services.find((item) => item.id === serviceId);
  if (service === undefined) {
    return <section className="error-shell" role="alert"><WarningCircleIcon aria-hidden="true" size={28} /><h1>Service not found</h1><p>The requested service is not in the current catalog scope.</p></section>;
  }
  return (
    <>
      <PageHeader
        eyebrow={`Inventory / ${service.environment}`}
        title={service.name}
        description="Read-only service detail assembled from catalog, reachability probes, and mapped workloads."
        action={<Link className="secondary-button" to="/">Back to inventory</Link>}
      />
      <section className="metrics-grid compact-metrics" aria-label="Service summary">
        <MetricCard label="Current state" value={service.state} note={`Criticality: ${service.criticality}`} tone={service.state === "healthy" ? "positive" : service.state === "failing" ? "danger" : "warning"} icon={CheckCircleIcon} />
        <MetricCard label="Last check" value={formattedTimestamp(service.lastCheckedAt)} note="Preserved source timestamp" icon={GaugeIcon} />
        <MetricCard label="Version" value={service.version ?? "Unavailable"} note="Kubernetes image tag or digest" icon={GitBranchIcon} />
        <MetricCard label="Owner" value={service.owner} note={service.environment} icon={UsersThreeIcon} />
      </section>
      <section className="overview-grid detail-grid">
        <article className="panel">
          <PanelHeader title="Reachability evidence" meta={service.endpoint} />
          <div className="evidence-list">
            {service.probes.map((probe) => (
              <div className="evidence-row" key={`${probe.id}-${probe.vantagePoint}`}>
                <div><strong>{probe.name}</strong><span>{probe.vantagePoint} · {formattedTimestamp(probe.checkedAt)}</span></div>
                <StatusBadge status={probe.state} />
                <span>{probe.latencyMs === null ? "No latency" : `${probe.latencyMs.toFixed(1)} ms`} · {probe.statusCode ?? "No HTTP status"}</span>
                <a href={probe.sourceToolUrl} target="_blank" rel="noreferrer">Open source <ArrowUpRightIcon aria-hidden="true" size={14} /></a>
              </div>
            ))}
            {service.probes.length === 0 && <p className="empty-panel-copy">No probe observations are available from the attempted sources.</p>}
          </div>
        </article>
        <article className="panel">
          <PanelHeader title="Workload evidence" meta={`${service.workloads.length} mapped observations`} />
          <div className="evidence-list">
            {service.workloads.map((workload) => (
              <div className="evidence-row" key={`${workload.kind}:${workload.namespace}:${workload.name}`}>
                <div><strong>{workload.name}</strong><span>{workload.kind} · {workload.namespace}</span></div>
                <StatusBadge status={workload.state} />
                <span>{workload.ready ?? "?"}/{workload.desired ?? "?"} ready · {workload.version ?? "version unavailable"}</span>
                {!workload.sourceToolUrl.startsWith("#") && <a href={workload.sourceToolUrl} target="_blank" rel="noreferrer">Open source <ArrowUpRightIcon aria-hidden="true" size={14} /></a>}
              </div>
            ))}
            {service.workloads.length === 0 && <p className="empty-panel-copy">No workload observation is mapped or Kubernetes is unavailable.</p>}
          </div>
        </article>
      </section>
      <article className="panel source-links-panel">
        <PanelHeader title="Source tools" meta="Direct evidence links" />
        <div className="source-links">
          {service.sourceLinks.map((link) => <a href={link.url} target="_blank" rel="noreferrer" key={link.url}>{link.label}<ArrowUpRightIcon aria-hidden="true" size={15} /></a>)}
          {service.sourceLinks.length === 0 && <p className="empty-panel-copy">No source tool link is available for this service.</p>}
        </div>
      </article>
    </>
  );
}

export function DeploymentsPage({ snapshot }: SnapshotPageProps): React.JSX.Element {
  const workloads = snapshot.services.flatMap((service) => service.workloads);
  const ready = workloads.filter((workload) => workload.state === "healthy").length;
  const versions = new Set(snapshot.services.map((service) => service.version).filter((version): version is string => version !== null));
  return (
    <>
      <PageHeader eyebrow="Operations / Deployments" title="Deployments" description="Release posture, ownership, and runtime status across every lab environment." action={<button className="secondary-button" type="button">Compare releases</button>} />
      <section className="metrics-grid compact-metrics" aria-label="Deployment summary">
        <MetricCard label="Mapped workloads" value={String(workloads.length)} note={`${ready} healthy · ${workloads.length - ready} attention/unknown`} tone={ready === workloads.length ? "positive" : "warning"} icon={StackIcon} />
        <MetricCard label="Services" value={String(snapshot.summary.total)} note={`${snapshot.summary.healthy} healthy`} tone={snapshot.summary.failing > 0 ? "danger" : "positive"} icon={HardDrivesIcon} />
        <MetricCard label="Versions observed" value={String(versions.size)} note="From live workload images" icon={GitBranchIcon} />
        <MetricCard label="Inventory freshness" value={snapshot.lastObservedAt ? formattedTimestamp(snapshot.lastObservedAt) : "Unavailable"} note="Source timestamp" tone={snapshot.lastObservedAt ? "positive" : "warning"} icon={TrendUpIcon} />
      </section>
      <article className="panel">
        <PanelHeader title="Release inventory" meta="Catalog and Kubernetes workload evidence" />
        <ServiceTable services={snapshot.services} />
      </article>
    </>
  );
}

export function InfrastructurePage(): React.JSX.Element {
  const resources = [
    { label: "cpqserver", meta: "Ubuntu · 8 vCPU · 32 GB", icon: HardDrivesIcon, status: "healthy" as const },
    { label: "k3s cluster", meta: "1 node · 18 workloads", icon: StackIcon, status: "degraded" as const },
    { label: "Docker runtime", meta: "16 containers · 0 exited", icon: CodeIcon, status: "healthy" as const },
    { label: "Persistent data", meta: "46% used · 181 GB free", icon: DatabaseIcon, status: "healthy" as const }
  ];
  return (
    <>
      <PageHeader eyebrow="Operations / Infrastructure" title="Infrastructure" description="Host, cluster, runtime, and dependency posture for the development lab." action={<button className="secondary-button" type="button">Open topology</button>} />
      <section className="resource-grid" aria-label="Infrastructure resources">
        {resources.map((resource) => {
          const Icon = resource.icon;
          return (
            <article className="resource-card" key={resource.label}>
              <div className="resource-icon"><Icon aria-hidden="true" size={22} /></div>
              <div><strong>{resource.label}</strong><span>{resource.meta}</span></div>
              <StatusBadge status={resource.status} compact />
            </article>
          );
        })}
      </section>
      <section className="overview-grid infrastructure-layout">
        <article className="panel topology-panel">
          <PanelHeader title="Dependency topology" meta="Logical lab relationships" />
          <div className="topology-lanes">
            <div className="topology-column"><span>EDGE</span><div className="topology-card"><GlobeHemisphereWestIcon size={20} aria-hidden="true" /><strong>Cloudflare</strong><small>Tunnel healthy</small></div></div>
            <div className="topology-column"><span>APPLICATIONS</span><div className="topology-card"><CloudIcon size={20} aria-hidden="true" /><strong>CPQ</strong><small>Demo + test</small></div><div className="topology-card"><CodeIcon size={20} aria-hidden="true" /><strong>ERPNext</strong><small>Demo</small></div></div>
            <div className="topology-column"><span>PLATFORM</span><div className="topology-card topology-warning"><IdentificationCardIcon size={20} aria-hidden="true" /><strong>Keycloak</strong><small>Latency elevated</small></div><div className="topology-card"><DatabaseIcon size={20} aria-hidden="true" /><strong>Data stores</strong><small>Healthy</small></div></div>
          </div>
        </article>
        <article className="panel capacity-panel">
          <PanelHeader title="Host capacity" meta="cpqserver fixture utilization" />
          {[ ["CPU", 38], ["Memory", 62], ["Disk", 54], ["Container quota", 71] ].map(([label, value]) => (
            <div className="capacity-row" key={label}>
              <div><span>{label}</span><strong>{value}%</strong></div>
              <progress max="100" value={value} aria-label={`${label} utilization ${value}%`} />
            </div>
          ))}
        </article>
      </section>
    </>
  );
}

interface PerformancePageProps extends SnapshotPageProps {
  readonly provider: MonitoringProvider;
  readonly timeRange: TimeRange;
  readonly refreshKey: number;
}

const metricColors = ["#6f93ff", "#ef6f6c", "#f2a65a", "#46d6a0", "#ba8cff"] as const;

function metric(snapshot: PerformanceSnapshot, id: PerformanceMetricId): PerformanceMetric | undefined {
  return snapshot.metrics.find((item) => item.id === id);
}

function formattedMetric(item: PerformanceMetric | undefined): string {
  if (item?.latest === null || item?.latest === undefined) return "No telemetry";
  if (item.unit === "requests/s") return `${item.latest.toFixed(2)} requests/s`;
  if (item.unit === "percent") return `${item.latest.toFixed(1)}%`;
  if (item.unit === "milliseconds") return `${item.latest.toFixed(1)} ms`;
  if (item.unit === "requests") return `${Math.round(item.latest).toLocaleString()} requests`;
  return `${Math.round(item.latest)} restarts`;
}

function mergePerformancePoints(metrics: readonly PerformanceMetric[]): readonly Record<string, string | number>[] {
  const rows = new Map<string, Record<string, string | number>>();
  for (const item of metrics) {
    if (item.status !== "ok") continue;
    for (const point of item.points) {
      const row = rows.get(point.timestamp) ?? { timestamp: point.timestamp };
      row[item.id] = point.value;
      rows.set(point.timestamp, row);
    }
  }
  return [...rows.values()].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
}

function PerformanceChartPanel({ title, metrics, meta }: { readonly title: string; readonly metrics: readonly PerformanceMetric[]; readonly meta: string }): React.JSX.Element {
  const available = metrics.filter((item) => item.status === "ok");
  const data = mergePerformancePoints(available);
  const threshold = available.find((item) => item.threshold !== null)?.threshold ?? null;
  return (
    <article className="panel performance-panel">
      <PanelHeader title={title} meta={meta} />
      {available.length > 0 && data.length > 0 ? (
        <div className="small-chart" role="img" aria-label={`${title} time series from Prometheus`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="#25354a" vertical={false} />
              <XAxis dataKey="timestamp" tickFormatter={(value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} minTickGap={28} tick={{ fill: "#7790ad", fontSize: 9 }} />
              <YAxis tick={{ fill: "#7790ad", fontSize: 9 }} width={42} />
              <Tooltip labelFormatter={(value: React.ReactNode) => typeof value === "string" || typeof value === "number" ? new Date(value).toLocaleString() : "Unknown timestamp"} contentStyle={{ background: "#111e2f", border: "1px solid #31445e" }} />
              <Legend />
              {threshold !== null && <ReferenceLine y={threshold} stroke="#ef6f6c" strokeDasharray="4 4" label={{ value: `Threshold ${threshold}`, fill: "#ef9a98", fontSize: 9 }} />}
              {available.map((item, index) => <Line key={item.id} type="monotone" dataKey={item.id} name={`${item.label} (${item.unit})`} stroke={metricColors[index % metricColors.length]} strokeWidth={2} dot={false} connectNulls={false} />)}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : <div className="telemetry-empty"><WarningCircleIcon aria-hidden="true" size={22} /><strong>No chart data</strong><span>{metrics[0]?.message ?? "Prometheus returned no samples for this selection."}</span></div>}
      {available.length > 0 && metrics.some((item) => item.status !== "ok") && <div className="metric-diagnostics">{metrics.filter((item) => item.status !== "ok").map((item) => <p key={item.id}><strong>{item.label}:</strong> {item.message ?? "No telemetry"}</p>)}</div>}
    </article>
  );
}

export function PerformancePage({ snapshot, provider, timeRange, refreshKey }: PerformancePageProps): React.JSX.Element {
  const serviceOptions = snapshot.services;
  const [serviceId, setServiceId] = useState("all");
  const [performance, setPerformance] = useState<PerformanceSnapshot | null>(null);
  const [performanceError, setPerformanceError] = useState<string | null>(null);

  useEffect(() => {
    if (serviceId !== "all" && !serviceOptions.some((service) => service.id === serviceId)) setServiceId("all");
  }, [serviceId, serviceOptions]);

  useEffect(() => {
    let active = true;
    setPerformance(null);
    setPerformanceError(null);
    provider.getPerformance(snapshot.environment, serviceId, timeRange)
      .then((next) => { if (active) setPerformance(next); })
      .catch((cause: unknown) => { if (active) setPerformanceError(cause instanceof Error ? cause.message : "Unknown performance provider error"); });
    return () => { active = false; };
  }, [provider, refreshKey, serviceId, snapshot.environment, timeRange]);

  const selectedInventory = useMemo(
    () => snapshot.services.find((service) => service.id === (serviceId === "all" ? "cpq-demo" : serviceId)),
    [serviceId, snapshot.services]
  );
  const action = (
    <label className="performance-service-control">
      <span>Service</span>
      <select aria-label="Performance service" value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
        <option value="all">All monitored services</option>
        {serviceOptions.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
      </select>
    </label>
  );

  return (
    <>
      <PageHeader eyebrow="Observability / Performance" title="Performance & capacity" description="Live, bounded Prometheus traffic and resource telemetry across the selected scope." action={action} />
      {performanceError !== null && <section className="performance-source performance-source-error" role="alert"><WarningCircleIcon aria-hidden="true" size={20} /><div><strong>Prometheus telemetry unavailable</strong><span>{performanceError}</span></div></section>}
      {performance === null && performanceError === null && <section className="performance-source" role="status"><div><strong>Loading Prometheus telemetry</strong><span>Running bounded allow-listed queries…</span></div></section>}
      {performance !== null && (
        <>
          <section className={`performance-source performance-source-${performance.source.availability}`} role="status">
            <DatabaseIcon aria-hidden="true" size={20} />
            <div><strong>{performance.mode === "partial" ? "Partial Prometheus telemetry" : "Prometheus telemetry"}<span className="source-pill">{performance.source.availability}</span></strong><span>Window {formattedTimestamp(performance.window.start)}–{formattedTimestamp(performance.window.end)} · {performance.window.stepSeconds}s resolution · max {performance.window.maxPoints} points</span>{performance.source.message && <small>{performance.source.message}</small>}</div>
          </section>
          <section className="metrics-grid" aria-label="Performance summary">
            <MetricCard label="Request rate" value={formattedMetric(metric(performance, "request-rate"))} note="Health and scrape endpoints excluded" icon={TrendUpIcon} />
            <MetricCard label="Server error rate" value={formattedMetric(metric(performance, "error-rate"))} note="HTTP server errors / request traffic" tone={(metric(performance, "error-rate")?.latest ?? 0) >= 1 ? "danger" : "positive"} icon={WarningCircleIcon} />
            <MetricCard label="p95 latency" value={formattedMetric(metric(performance, "latency-p95"))} note="Synthetic checks across selected services" icon={GaugeIcon} />
            <MetricCard label="Requests in window" value={formattedMetric(metric(performance, "request-total"))} note="Actual portfolio requests served by Nginx" icon={DatabaseIcon} />
          </section>
          <section className="performance-grid">
            <PerformanceChartPanel title="Traffic & server errors" meta="requests/s and percent" metrics={[metric(performance, "request-rate"), metric(performance, "error-rate")].filter((item): item is PerformanceMetric => item !== undefined)} />
            <PerformanceChartPanel title="Synthetic latency percentiles" meta="p50, p95, p99 · milliseconds" metrics={[metric(performance, "latency-p50"), metric(performance, "latency-p95"), metric(performance, "latency-p99")].filter((item): item is PerformanceMetric => item !== undefined)} />
            <PerformanceChartPanel title="JVM & process CPU" meta="process and application-host utilization" metrics={[metric(performance, "process-cpu"), metric(performance, "system-cpu")].filter((item): item is PerformanceMetric => item !== undefined)} />
            <PerformanceChartPanel title="Memory utilization" meta="JVM heap and lab host" metrics={[metric(performance, "jvm-heap"), metric(performance, "host-memory")].filter((item): item is PerformanceMetric => item !== undefined)} />
            <PerformanceChartPanel title="Database saturation" meta="Hikari active / max connections" metrics={[metric(performance, "db-pool-saturation")].filter((item): item is PerformanceMetric => item !== undefined)} />
            <PerformanceChartPanel title="Pod restarts" meta="Increase within each query interval" metrics={[metric(performance, "pod-restarts")].filter((item): item is PerformanceMetric => item !== undefined)} />
          </section>
          <article className="panel performance-correlation">
            <PanelHeader title="CPQ Demo correlation" meta="Prometheus signals beside Sprint 2 workload evidence" />
            {selectedInventory === undefined ? <p className="empty-panel-copy">CPQ Demo is outside the selected environment.</p> : (
              <div className="correlation-grid">
                <div><span>Inventory state</span><StatusBadge status={selectedInventory.state} /></div>
                <div><span>Observed version</span><strong>{selectedInventory.version ?? "Unavailable"}</strong></div>
                <div><span>Workloads</span><strong>{selectedInventory.workloads.length === 0 ? "No evidence" : selectedInventory.workloads.map((workload) => `${workload.ready ?? "?"}/${workload.desired ?? "?"} ${workload.name}`).join(", ")}</strong></div>
                <div><span>Last workload check</span><strong>{formattedTimestamp(selectedInventory.lastCheckedAt)}</strong></div>
              </div>
            )}
          </article>
        </>
      )}
    </>
  );
}

export function IncidentsPage({ snapshot }: SnapshotPageProps): React.JSX.Element {
  return (
    <>
      <PageHeader eyebrow="Operations / Incidents" title="Incidents" description="Dependency-aware incident command with fixture responder and blast-radius data." action={<button className="primary-button" type="button">Declare incident</button>} />
      <section className="incident-command-grid">
        <article className="panel incident-queue">
          <PanelHeader title="Active queue" meta={`${snapshot.incidents.length} incidents`} />
          {snapshot.incidents.map((incident, index) => (
            <button className={`incident-command-row ${index === 0 ? "selected" : ""}`} type="button" key={incident.id}>
              <span className={`severity severity-${incident.severity.toLowerCase()}`}>{incident.severity}</span>
              <span><strong>{incident.title}</strong><small>{incident.id} · {incident.service} · {incident.startedAt}</small></span>
              <span className="assignee">{incident.assignee}</span>
            </button>
          ))}
        </article>
        <article className="panel incident-detail">
          <span className="eyebrow">INC-2048 · Investigating</span>
          <h2>OIDC token exchange latency above SLO</h2>
          <p>Authentication requests are exceeding the 400 ms p95 threshold. CPQ Demo and CPQ Test are in the current blast radius.</p>
          <div className="incident-detail-grid">
            <div><span>Owner</span><strong>Identity Services</strong></div>
            <div><span>Commander</span><strong>J. Haynes</strong></div>
            <div><span>Started</span><strong>32 min ago</strong></div>
            <div><span>Error budget</span><strong>3.7× burn</strong></div>
          </div>
          <div className="incident-actions"><button className="primary-button" type="button">Acknowledge</button><button className="secondary-button" type="button">Open runbook</button></div>
        </article>
      </section>
    </>
  );
}

export function SettingsPage(): React.JSX.Element {
  const integrations = [
    { label: "Data sources", value: "7 collectors configured", icon: DatabaseIcon },
    { label: "Cloud accounts", value: "Lab network · Cloudflare", icon: CloudIcon },
    { label: "SSO / RBAC", value: "Local admin · Access pending", icon: UsersThreeIcon },
    { label: "API & audit", value: "No service tokens issued", icon: ShieldCheckIcon }
  ];
  return (
    <>
      <PageHeader eyebrow="Administration / Settings" title="Settings" description="Fixture-backed integration, governance, and interface-state previews." />
      <section className="settings-grid" aria-label="Integration settings">
        {integrations.map((integration) => {
          const Icon = integration.icon;
          return <article className="integration-card" key={integration.label}><Icon aria-hidden="true" size={22} /><div><strong>{integration.label}</strong><span>{integration.value}</span></div><ArrowUpRightIcon aria-hidden="true" size={17} /></article>;
        })}
      </section>
      <section className="panel state-gallery-panel">
        <PanelHeader title="Interface state gallery" meta="Sprint 1 fixture acceptance states" />
        <StateGallery />
      </section>
    </>
  );
}
