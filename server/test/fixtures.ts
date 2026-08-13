import type { CatalogDefinition } from "../src/catalog";

export const catalogFixture: CatalogDefinition = {
  catalogVersion: 1,
  services: [
    {
      id: "cpq-demo",
      displayName: "CPQ Demo",
      kind: "application",
      environment: "demo",
      owner: "Development Lab",
      criticality: "critical",
      probes: [
        {
          id: "cpq-demo-ready-internal",
          displayName: "CPQ Demo readiness (internal)",
          group: "cpq-demo",
          url: "http://cpq.example.test/ready",
          vantagePoints: ["internal"],
          intervalSeconds: 30,
          timeoutSeconds: 5,
          expectedStatus: 200
        },
        {
          id: "cpq-demo-ready-external",
          displayName: "CPQ Demo readiness (external)",
          group: "cpq-demo",
          url: "https://cpq.example.test/ready",
          vantagePoints: ["external"],
          intervalSeconds: 60,
          timeoutSeconds: 10,
          expectedStatus: 200
        }
      ],
      workloads: [
        { kind: "Deployment", namespace: "default", name: "application" }
      ]
    },
    {
      id: "mailpit",
      displayName: "Mailpit",
      kind: "mail",
      environment: "shared",
      owner: "Development Lab",
      criticality: "medium",
      probes: [
        {
          id: "mailpit-api-internal",
          displayName: "Mailpit API",
          group: "mailpit",
          url: "http://mailpit.example.test/api/v1/info",
          vantagePoints: ["internal"],
          intervalSeconds: 60,
          timeoutSeconds: 5,
          expectedStatus: 200
        }
      ],
      workloads: []
    }
  ]
};

export function gatusEndpoint(
  name: string,
  group: string,
  success: boolean,
  timestamp: string,
  duration = 2_500_000
): object {
  return {
    name,
    group,
    key: `${group}_${name}`,
    results: [{ status: success ? 200 : 503, duration, success, timestamp, conditionResults: [] }]
  };
}
