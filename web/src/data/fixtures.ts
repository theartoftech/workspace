import type { HealthState, ServiceInventory } from "../../../shared/inventory";
import type { IncidentSummary, TrafficPoint } from "./types";

function fixtureService(
  id: string,
  name: string,
  kind: ServiceInventory["kind"],
  environment: ServiceInventory["environment"],
  state: HealthState,
  endpoint: string,
  version: string
): ServiceInventory {
  return {
    id,
    name,
    kind,
    environment,
    state,
    endpoint,
    version,
    owner: "Development Lab",
    criticality: state === "failing" ? "critical" : "medium",
    lastCheckedAt: "2026-08-12T15:14:42Z",
    reachability: { internal: state, external: null, comparison: "not-configured" },
    probes: [],
    workloads: [],
    sourceLinks: []
  };
}

export const serviceFixtures: readonly ServiceInventory[] = [
  fixtureService("cpq-demo", "CPQ Demo", "application", "demo", "healthy", "https://demo.example.test/ready", "v4.12.1"),
  fixtureService("cpq-test", "CPQ Test", "application", "test", "degraded", "https://test.example.test/ready", "v4.13.0-rc2"),
  fixtureService("oauth", "OAuth / Keycloak", "identity", "shared", "failing", "https://oauth.example.test/", "26.3.2"),
  fixtureService("mailpit", "Mailpit", "mail", "shared", "healthy", "https://mail.example.test/", "v1.27.4"),
  fixtureService("erpnet", "ERPNext", "erp", "demo", "healthy", "https://erp.example.test/", "v15.72.3"),
  fixtureService("portfolio", "Portfolio", "application", "portfolio", "healthy", "https://jefferyhaynes.net/", "v1")
];

export const incidentFixtures: readonly IncidentSummary[] = [
  {
    id: "INC-002048",
    version: 1,
    title: "OIDC token exchange latency above SLO",
    description: "Authentication requests are exceeding the 400 ms p95 threshold. CPQ Demo and CPQ Test are in the current blast radius.",
    serviceId: "oauth",
    serviceName: "OAuth / Keycloak",
    environment: "shared",
    severity: "P1",
    status: "active",
    startedAt: "2026-08-12T14:43:00Z",
    lastObservedAt: "2026-08-12T15:15:00Z",
    updatedAt: "2026-08-12T15:15:00Z",
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    declaredAt: null,
    declaredBy: null,
    assignee: "Unassigned",
    owner: "Identity Services",
    alertActive: true,
    recoveredAt: null,
    runbook: { id: "oauth-incident-response", title: "OAuth / Keycloak incident response", steps: ["Confirm internal and public-path discovery probes.", "Inspect Keycloak latency and container saturation.", "Validate CPQ token exchange recovery before resolving."] },
    evidence: [{ source: "gatus-internal", state: "failing", firstObservedAt: "2026-08-12T14:43:00Z", lastObservedAt: "2026-08-12T15:15:00Z", occurrences: 4, message: "OIDC latency is above the reviewed threshold.", active: true }],
    silence: null
  },
  {
    id: "INC-002047",
    version: 1,
    title: "CPQ test readiness intermittently failing",
    description: "CPQ Test readiness remained healthy during intermittent monitoring gaps; live Kubernetes workload evidence is now restored.",
    serviceId: "cpq-test",
    serviceName: "CPQ Test",
    environment: "test",
    severity: "P2",
    status: "active",
    startedAt: "2026-08-12T13:57:00Z",
    lastObservedAt: "2026-08-12T15:15:00Z",
    updatedAt: "2026-08-12T15:15:00Z",
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    declaredAt: null,
    declaredBy: null,
    assignee: "Platform On-call",
    owner: "Platform Engineering",
    alertActive: false,
    recoveredAt: "2026-08-12T15:14:42Z",
    runbook: { id: "cpq-test-incident-response", title: "CPQ Test incident response", steps: ["Confirm the CPQ Test readiness endpoint returns HTTP 200.", "Inspect the cpq-test application deployment and recent events.", "Confirm current Kubernetes inventory evidence remains available."] },
    evidence: [{ source: "kubernetes", state: "healthy", firstObservedAt: "2026-08-12T13:57:00Z", lastObservedAt: "2026-08-12T15:14:42Z", occurrences: 3, message: "Workload evidence recovered.", active: false }],
    silence: null
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
