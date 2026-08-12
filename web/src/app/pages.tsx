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
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

import { StateGallery } from "../components/StateGallery";
import { StatusBadge } from "../components/StatusBadge";
import type { OverviewSnapshot, ServiceHealth } from "../data/types";

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
      <button className="icon-button subtle-button" type="button" aria-label={`Open ${title} detail`}>
        <ArrowUpRightIcon aria-hidden="true" size={18} />
      </button>
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

function ServiceTable({ services }: { readonly services: readonly ServiceHealth[] }): React.JSX.Element {
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
            <th scope="col">Latency</th>
            <th scope="col">Uptime</th>
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
                    <strong>{service.name}</strong>
                    <span>{service.lastChecked}</span>
                  </div>
                </div>
              </td>
              <td><StatusBadge status={service.status} /></td>
              <td><span className="environment-chip">{service.environment}</span></td>
              <td>{service.latencyMs} ms</td>
              <td>{service.uptime.toFixed(2)}%</td>
              <td><code>{service.version}</code></td>
              <td>{service.owner}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OverviewPage({ snapshot }: SnapshotPageProps): React.JSX.Element {
  const affected = snapshot.summary.degradedServices + snapshot.summary.criticalServices;
  return (
    <>
      <PageHeader
        eyebrow="Operations / Overview"
        title="Fleet overview"
        description="Deployment health, availability, and capacity across the development lab."
        action={<button className="secondary-button" type="button">Create view</button>}
      />

      <section className="metrics-grid" aria-label="Fleet summary">
        <MetricCard label="Services online" value={`${snapshot.summary.healthyServices}/${snapshot.summary.totalServices}`} note={`${affected} require attention`} tone={affected > 0 ? "warning" : "positive"} icon={CheckCircleIcon} />
        <MetricCard label="Fleet uptime" value={`${snapshot.summary.uptime.toFixed(2)}%`} note="Target 99.90% · trailing 30d" tone="positive" icon={TrendUpIcon} />
        <MetricCard label="Active incidents" value={String(snapshot.summary.activeIncidents)} note="1 critical · 1 monitoring" tone="danger" icon={WarningCircleIcon} />
        <MetricCard label="Request volume" value="7.4M" note="+8.2% over prior period" icon={GaugeIcon} />
      </section>

      <section className="overview-grid">
        <article className="panel traffic-panel">
          <PanelHeader title="Traffic & latency" meta="All monitored services · last 60 minutes" />
          <div className="chart-legend" aria-hidden="true">
            <span><i className="legend-cobalt" />Requests/min</span>
            <span><i className="legend-amber" />p95 latency</span>
          </div>
          <div className="chart-frame" role="img" aria-label="Fixture traffic and p95 latency chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={snapshot.traffic} margin={{ top: 12, right: 8, left: -22, bottom: 0 }}>
                <defs>
                  <linearGradient id="trafficFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4f7cff" stopOpacity={0.42} />
                    <stop offset="100%" stopColor="#4f7cff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#25354a" vertical={false} />
                <XAxis dataKey="time" stroke="#75869d" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} />
                <YAxis stroke="#75869d" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ background: "#111e2f", border: "1px solid #31445e", borderRadius: 8 }} />
                <Area type="monotone" dataKey="requests" stroke="#6b8fff" strokeWidth={2} fill="url(#trafficFill)" />
                <Line type="monotone" dataKey="latency" stroke="#f2a65a" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="panel health-panel">
          <PanelHeader title="Health by environment" meta="Current fixture snapshot" />
          <div className="environment-health-list">
            {[
              ["Demo", "2 services", "healthy"],
              ["Test", "1 service", "degraded"],
              ["Shared", "2 services", "critical"]
            ].map(([name, count, status]) => (
              <div className="environment-health-row" key={name}>
                <div><strong>{name}</strong><span>{count}</span></div>
                <StatusBadge status={status as "healthy" | "degraded" | "critical"} />
              </div>
            ))}
          </div>
          <div className="slo-callout">
            <ShieldCheckIcon aria-hidden="true" size={22} />
            <div><strong>4 of 5 SLOs met</strong><span>OAuth burn rate is 3.7× budget.</span></div>
          </div>
        </article>
      </section>

      <section className="lower-grid">
        <article className="panel services-panel">
          <PanelHeader title="Service inventory" meta={`${snapshot.services.length} services in current scope`} />
          <ServiceTable services={snapshot.services} />
        </article>
        <article className="panel incidents-panel">
          <PanelHeader title="Active incidents" meta="Dependency-aware triage" />
          <div className="incident-list">
            {snapshot.incidents.map((incident) => (
              <button className="incident-row" type="button" key={incident.id}>
                <span className={`severity severity-${incident.severity.toLowerCase()}`}>{incident.severity}</span>
                <span className="incident-copy"><strong>{incident.title}</strong><span>{incident.service} · {incident.startedAt}</span></span>
                <ArrowUpRightIcon aria-hidden="true" size={16} />
              </button>
            ))}
          </div>
          <button className="text-button" type="button">View incident command <ArrowUpRightIcon aria-hidden="true" size={15} /></button>
        </article>
      </section>
    </>
  );
}

export function DeploymentsPage({ snapshot }: SnapshotPageProps): React.JSX.Element {
  return (
    <>
      <PageHeader eyebrow="Operations / Deployments" title="Deployments" description="Release posture, ownership, and runtime status across every lab environment." action={<button className="secondary-button" type="button">Compare releases</button>} />
      <section className="metrics-grid compact-metrics" aria-label="Deployment summary">
        <MetricCard label="Running workloads" value="18" note="17 ready · 1 pending" tone="warning" icon={StackIcon} />
        <MetricCard label="Clusters" value="1" note="cpqserver · k3s" tone="positive" icon={HardDrivesIcon} />
        <MetricCard label="Last deployment" value="42m" note="CPQ Demo · v4.12.1" icon={GitBranchIcon} />
        <MetricCard label="Change failure rate" value="3.2%" note="Trailing 30 days" tone="positive" icon={TrendUpIcon} />
      </section>
      <article className="panel">
        <PanelHeader title="Release inventory" meta="Fixture deployment metadata" />
        <ServiceTable services={snapshot.services} />
      </article>
      <article className="panel dependency-chain-panel">
        <PanelHeader title="Selected dependency chain" meta="CPQ Demo · demo environment" />
        <div className="dependency-chain" aria-label="CPQ Demo dependency chain">
          {["Cloudflare edge", "CPQ Demo", "OAuth / Keycloak", "PostgreSQL", "ERPNext"].map((node, index) => (
            <div className="dependency-node" key={node}>
              <span>{index + 1}</span><strong>{node}</strong><small>{index === 2 ? "Degraded path" : "Healthy"}</small>
            </div>
          ))}
        </div>
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

export function PerformancePage({ snapshot }: SnapshotPageProps): React.JSX.Element {
  return (
    <>
      <PageHeader eyebrow="Observability / Performance" title="Performance & capacity" description="Golden signals and resource trends across the selected environment." action={<button className="secondary-button" type="button">Export snapshot</button>} />
      <section className="performance-grid">
        <article className="panel performance-panel">
          <PanelHeader title="Request throughput" meta="Requests per minute" />
          <div className="small-chart" role="img" aria-label="Fixture request throughput chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={snapshot.traffic}><CartesianGrid stroke="#25354a" vertical={false} /><XAxis dataKey="time" hide /><YAxis hide /><Tooltip contentStyle={{ background: "#111e2f", border: "1px solid #31445e" }} /><Bar dataKey="requests" fill="#4f7cff" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>
        </article>
        <article className="panel performance-panel">
          <PanelHeader title="p95 latency" meta="Milliseconds" />
          <div className="small-chart" role="img" aria-label="Fixture p95 latency chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={snapshot.traffic}><CartesianGrid stroke="#25354a" vertical={false} /><XAxis dataKey="time" hide /><YAxis hide /><Tooltip contentStyle={{ background: "#111e2f", border: "1px solid #31445e" }} /><Line type="monotone" dataKey="latency" stroke="#f2a65a" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div>
        </article>
        <article className="panel performance-panel">
          <PanelHeader title="Error volume" meta="Errors per interval" />
          <div className="small-chart" role="img" aria-label="Fixture error volume chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={snapshot.traffic}><CartesianGrid stroke="#25354a" vertical={false} /><XAxis dataKey="time" hide /><YAxis hide /><Tooltip contentStyle={{ background: "#111e2f", border: "1px solid #31445e" }} /><Area type="monotone" dataKey="errors" stroke="#ef6f6c" fill="#ef6f6c" fillOpacity={0.18} /></AreaChart></ResponsiveContainer></div>
        </article>
        <article className="panel performance-panel capacity-summary-panel">
          <PanelHeader title="Capacity forecast" meta="Next threshold breach" />
          <div className="forecast-value"><strong>11 days</strong><span>Memory pressure · cpqserver</span></div>
          <div className="forecast-note"><WarningCircleIcon aria-hidden="true" size={18} /><span>Projected to reach 80% on Aug 23 if current growth continues.</span></div>
        </article>
      </section>
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
