import type { IncidentSummary, ServiceHealth, TrafficPoint } from "./types";

export const serviceFixtures: readonly ServiceHealth[] = [
  {
    id: "cpq-demo",
    name: "CPQ Demo",
    kind: "application",
    environment: "demo",
    status: "healthy",
    uptime: 99.98,
    latencyMs: 184,
    requestRate: 42.8,
    version: "v4.12.1",
    owner: "Platform Engineering",
    lastChecked: "18 sec ago"
  },
  {
    id: "cpq-test",
    name: "CPQ Test",
    kind: "application",
    environment: "test",
    status: "degraded",
    uptime: 99.82,
    latencyMs: 426,
    requestRate: 11.4,
    version: "v4.13.0-rc2",
    owner: "CPQ Enablement",
    lastChecked: "24 sec ago"
  },
  {
    id: "oauth",
    name: "OAuth / Keycloak",
    kind: "identity",
    environment: "shared",
    status: "critical",
    uptime: 98.91,
    latencyMs: 812,
    requestRate: 17.2,
    version: "26.3.2",
    owner: "Identity Services",
    lastChecked: "12 sec ago"
  },
  {
    id: "mailpit",
    name: "Mailpit",
    kind: "mail",
    environment: "shared",
    status: "healthy",
    uptime: 100,
    latencyMs: 38,
    requestRate: 2.8,
    version: "v1.27.4",
    owner: "Developer Experience",
    lastChecked: "41 sec ago"
  },
  {
    id: "erpnet",
    name: "ERPNext",
    kind: "erp",
    environment: "demo",
    status: "healthy",
    uptime: 99.96,
    latencyMs: 246,
    requestRate: 8.7,
    version: "v15.72.3",
    owner: "Business Systems",
    lastChecked: "31 sec ago"
  }
];

export const incidentFixtures: readonly IncidentSummary[] = [
  {
    id: "INC-2048",
    title: "OIDC token exchange latency above SLO",
    service: "OAuth / Keycloak",
    severity: "P1",
    status: "investigating",
    startedAt: "32 min ago",
    assignee: "J. Haynes"
  },
  {
    id: "INC-2047",
    title: "CPQ test readiness intermittently failing",
    service: "CPQ Test",
    severity: "P2",
    status: "monitoring",
    startedAt: "1 hr 18 min ago",
    assignee: "Platform On-call"
  }
];

export const trafficFixtures: readonly TrafficPoint[] = [
  { time: "10:00", requests: 64, errors: 1, latency: 172 },
  { time: "10:05", requests: 78, errors: 1, latency: 184 },
  { time: "10:10", requests: 70, errors: 2, latency: 201 },
  { time: "10:15", requests: 92, errors: 2, latency: 196 },
  { time: "10:20", requests: 84, errors: 3, latency: 214 },
  { time: "10:25", requests: 104, errors: 2, latency: 238 },
  { time: "10:30", requests: 96, errors: 4, latency: 244 },
  { time: "10:35", requests: 116, errors: 6, latency: 286 },
  { time: "10:40", requests: 108, errors: 5, latency: 274 },
  { time: "10:45", requests: 126, errors: 7, latency: 312 },
  { time: "10:50", requests: 118, errors: 4, latency: 268 },
  { time: "10:55", requests: 132, errors: 3, latency: 242 }
];
