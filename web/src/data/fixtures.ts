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
  fixtureService("erpnet", "ERPNext", "erp", "demo", "healthy", "https://erp.example.test/", "v15.72.3")
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
