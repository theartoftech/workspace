import { describe, expect, it } from "vitest";

import type { LogQuery } from "../../shared/logs";
import type { CatalogDefinition } from "../src/catalog";
import type { JsonHttpClient, TextHttpClient } from "../src/http";
import { UpstreamError } from "../src/http";
import { KubernetesLogReader, LogRequestError, UnavailableLogReader } from "../src/logs";

const catalog: CatalogDefinition = {
  catalogVersion: 1,
  services: [
    {
      id: "cpq-demo", displayName: "CPQ Demo", kind: "application", environment: "demo", owner: "Lab", criticality: "critical",
      probes: [{ id: "ready", displayName: "Ready", group: "cpq", url: "https://cpq.test/ready", vantagePoints: ["internal"], intervalSeconds: 30, timeoutSeconds: 5, expectedStatus: 200 }],
      workloads: [{ kind: "Deployment", namespace: "default", name: "application" }]
    },
    {
      id: "oauth", displayName: "OAuth", kind: "identity", environment: "shared", owner: "Lab", criticality: "high",
      probes: [{ id: "ready", displayName: "Ready", group: "oauth", url: "https://oauth.test/ready", vantagePoints: ["internal"], intervalSeconds: 30, timeoutSeconds: 5, expectedStatus: 200 }],
      workloads: [{ kind: "Pod", namespace: "default", name: "keycloak" }]
    },
    {
      id: "erpnet", displayName: "ERPNet", kind: "erp", environment: "demo", owner: "Lab", criticality: "medium",
      probes: [{ id: "ready", displayName: "Ready", group: "erp", url: "https://erp.test/ready", vantagePoints: ["internal"], intervalSeconds: 30, timeoutSeconds: 5, expectedStatus: 200 }],
      workloads: []
    }
  ]
};

const query: LogQuery = {
  environment: "demo", serviceId: "cpq-demo", range: "1h", pod: null, severity: "all", query: "", correlationId: ""
};

const deployment = {
  metadata: { name: "application", namespace: "default" },
  spec: { selector: { matchLabels: { app: "cpq" } } }
};
const podList = {
  metadata: {},
  items: [
    { metadata: { name: "application-a", namespace: "default", labels: { app: "cpq" } }, spec: { containers: [{ name: "web" }, { name: "sidecar" }] }, status: { containerStatuses: [{ name: "web", restartCount: 1 }, { name: "sidecar", restartCount: 0 }] } },
    { metadata: { name: "unrelated", namespace: "default", labels: { app: "other" } }, spec: { containers: [{ name: "other" }] }, status: { containerStatuses: [] } }
  ]
};
const eventList = {
  metadata: {},
  items: [
    { metadata: { uid: "event-1", namespace: "default" }, involvedObject: { kind: "Pod", name: "application-a" }, type: "Warning", reason: "BackOff", message: "password=event-secret restart back-off", lastTimestamp: "2026-08-14T16:55:00.000Z" },
    { metadata: { uid: "old", namespace: "default" }, involvedObject: { kind: "Deployment", name: "application" }, type: "Normal", reason: "Scaling", message: "Old", lastTimestamp: "2026-08-14T12:00:00.000Z" }
  ]
};

function clients(failSidecar = false): { readonly json: JsonHttpClient; readonly text: TextHttpClient; readonly urls: string[]; readonly textHeaders: Readonly<Record<string, string>>[] } {
  const urls: string[] = [];
  const textHeaders: Readonly<Record<string, string>>[] = [];
  return {
    urls,
    textHeaders,
    json: {
      async getJson(url): Promise<unknown> {
        urls.push(url);
        if (url.includes("/deployments/")) return deployment;
        if (url.includes("/pods?")) return podList;
        if (url.includes("/events?")) return eventList;
        throw new Error(`Unexpected JSON URL: ${url}`);
      }
    },
    text: {
      async getText(url, options): Promise<string> {
        urls.push(url);
        textHeaders.push(options.headers ?? {});
        if (failSidecar && url.includes("container=sidecar")) throw new UpstreamError("unauthorized", "Bearer must-not-leak");
        if (url.includes("previous=true")) return "2026-08-14T16:45:00.000Z previous ERROR correlation_id=req-42 token=log-secret";
        if (url.includes("container=sidecar")) return "2026-08-14T16:56:00.000Z sidecar healthy";
        return [
          "2026-08-14T16:57:00.000Z INFO request completed correlationId=req-41",
          "2026-08-14T16:58:00.000Z {\"level\":\"error\",\"correlationId\":\"req-42\",\"password\":\"json-secret\"}"
        ].join("\n");
      }
    }
  };
}

describe("bounded Kubernetes log and event correlation", () => {
  it("discovers deployment pods, includes restarted-container history, bounds time, and redacts output", async () => {
    const fake = clients();
    const reader = new KubernetesLogReader({ apiUrl: "https://kube.test", bearerToken: "token", catalog, jsonClient: fake.json, textClient: fake.text, now: () => new Date("2026-08-14T17:00:00.000Z") });
    const result = await reader.getLogs(query);

    expect(result).toMatchObject({ apiVersion: 1, mode: "live", service: { id: "cpq-demo" }, window: { start: "2026-08-14T16:00:00.000Z" }, truncated: false });
    expect(result.pods).toEqual([{ namespace: "default", name: "application-a", containers: ["web", "sidecar"], restartCount: 1 }]);
    expect(result.entries).toHaveLength(4);
    expect(result.entries.some((entry) => entry.previous)).toBe(true);
    expect(result.entries.find((entry) => entry.correlationId === "req-42")).toMatchObject({ severity: "error" });
    expect(result.events).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/event-secret|log-secret|json-secret|must-not-leak/);
    expect(JSON.stringify(result)).toContain("[REDACTED]");
    expect(fake.urls.find((url) => url.includes("/log?"))).toContain("sinceTime=2026-08-14T16%3A00%3A00.000Z");
    expect(fake.urls.find((url) => url.includes("/log?"))).toContain("tailLines=");
    expect(fake.textHeaders.length).toBeGreaterThan(0);
    expect(fake.textHeaders.every((headers) => headers.Accept === undefined)).toBe(true);
  });

  it("filters by pod, severity, free text, and correlation id without changing upstream bounds", async () => {
    const fake = clients();
    const reader = new KubernetesLogReader({ apiUrl: "https://kube.test", bearerToken: "token", catalog, jsonClient: fake.json, textClient: fake.text, now: () => new Date("2026-08-14T17:00:00.000Z") });
    const result = await reader.getLogs({ ...query, pod: "application-a", severity: "error", query: "password", correlationId: "req-42" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries.every((entry) => entry.severity === "error" && entry.correlationId === "req-42" && entry.message.includes("[REDACTED]"))).toBe(true);
  });

  it("resolves an exact catalog Pod mapping without enumerating a deployment selector", async () => {
    const urls: string[] = [];
    const json: JsonHttpClient = {
      getJson(url): Promise<unknown> {
        urls.push(url);
        if (url.includes("/pods?")) return Promise.resolve({
          metadata: {},
          items: ["keycloak", "keycloak-copy"].map((name) => ({
            metadata: { name, namespace: "default", labels: { app: "keycloak" } },
            spec: { containers: [{ name: "keycloak" }] },
            status: { containerStatuses: [{ name: "keycloak", restartCount: 0 }] }
          }))
        });
        if (url.includes("/events?")) return Promise.resolve({ metadata: {}, items: [] });
        throw new Error(`Unexpected JSON URL: ${url}`);
      }
    };
    const text: TextHttpClient = {
      getText(url): Promise<string> {
        urls.push(url);
        return Promise.resolve("2026-08-14T16:59:00.000Z INFO keycloak ready");
      }
    };
    const reader = new KubernetesLogReader({ apiUrl: "https://kube.test", bearerToken: "token", catalog, jsonClient: json, textClient: text, now: () => new Date("2026-08-14T17:00:00.000Z") });

    const result = await reader.getLogs({ ...query, environment: "all", serviceId: "oauth" });

    expect(result.pods).toEqual([{ namespace: "default", name: "keycloak", containers: ["keycloak"], restartCount: 0 }]);
    expect(result.entries).toHaveLength(1);
    expect(urls.some((url) => url.includes("/deployments/"))).toBe(false);
  });

  it("keeps valid logs and events when one container stream fails", async () => {
    const fake = clients(true);
    const reader = new KubernetesLogReader({ apiUrl: "https://kube.test", bearerToken: "token", catalog, jsonClient: fake.json, textClient: fake.text, now: () => new Date("2026-08-14T17:00:00.000Z") });
    const result = await reader.getLogs(query);
    expect(result.mode).toBe("partial");
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.events).toHaveLength(1);
    expect(result.sources).toContainEqual(expect.objectContaining({ name: "kubernetes-pod-logs", availability: "partial" }));
    expect(result.omissions).toContainEqual(expect.objectContaining({ source: "kubernetes-pod-logs", scope: "default/application-a/sidecar" }));
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("rejects unsupported scopes and filters before contacting Kubernetes", async () => {
    const fake = clients();
    const reader = new KubernetesLogReader({ apiUrl: "https://kube.test", bearerToken: "token", catalog, jsonClient: fake.json, textClient: fake.text });
    const invalid: readonly LogQuery[] = [
      { ...query, environment: "portfolio" },
      { ...query, serviceId: "missing" },
      { ...query, range: "30d" as LogQuery["range"] },
      { ...query, pod: "../../secret" },
      { ...query, query: "x".repeat(101) },
      { ...query, correlationId: "x".repeat(129) }
    ];
    for (const item of invalid) await expect(reader.getLogs(item)).rejects.toBeInstanceOf(LogRequestError);
    expect(fake.urls).toHaveLength(0);
  });

  it("reports services without workload mappings and unavailable credentials honestly", async () => {
    const fake = clients();
    const reader = new KubernetesLogReader({ apiUrl: "https://kube.test", bearerToken: "token", catalog, jsonClient: fake.json, textClient: fake.text, now: () => new Date("2026-08-14T17:00:00.000Z") });
    const noWorkload = await reader.getLogs({ ...query, serviceId: "erpnet" });
    expect(noWorkload).toMatchObject({ mode: "partial", entries: [], events: [], sources: [{ availability: "unavailable" }, { availability: "unavailable" }] });
    expect(noWorkload.omissions[0]?.reason).toContain("No Kubernetes workload mapping");

    const unavailable = new UnavailableLogReader(catalog, "Kubernetes read-only credential file is unavailable; token=secret-value", () => new Date("2026-08-14T17:00:00.000Z"));
    const response = await unavailable.getLogs(query);
    expect(response).toMatchObject({ mode: "partial", entries: [], events: [], sources: [{ availability: "unavailable" }, { availability: "unavailable" }] });
    expect(JSON.stringify(response)).not.toContain("secret-value");
  });

  it("enforces constructor and response caps", async () => {
    const fake = clients();
    const options = { apiUrl: "https://kube.test", bearerToken: "token", catalog, jsonClient: fake.json, textClient: fake.text };
    expect(() => new KubernetesLogReader({ ...options, maxPods: 0 })).toThrow("maxPods");
    expect(() => new KubernetesLogReader({ ...options, maxStreams: 0 })).toThrow("maxStreams");
    expect(() => new KubernetesLogReader({ ...options, maxEntries: 1 })).toThrow("maxEntries");
    expect(() => new KubernetesLogReader({ ...options, maxEvents: 0 })).toThrow("maxEvents");
    expect(() => new KubernetesLogReader({ ...options, concurrency: 0 })).toThrow("concurrency");

    const cappedJson: JsonHttpClient = {
      async getJson(url): Promise<unknown> {
        if (url.includes("/deployments/")) return deployment;
        if (url.includes("/pods?")) return {
          metadata: {},
          items: ["application-a", "application-b"].map((name) => ({
            metadata: { name, namespace: "default", labels: { app: "cpq" } },
            spec: { containers: [{ name: "web" }, { name: "sidecar" }] },
            status: { containerStatuses: [{ name: "web", restartCount: 1 }, { name: "sidecar", restartCount: 0 }] }
          }))
        };
        if (url.includes("/events?")) return {
          metadata: {},
          items: Array.from({ length: 7 }, (_, index) => ({
            metadata: { uid: `event-${index}`, namespace: "default" },
            involvedObject: { kind: "Pod", name: "application-a" },
            type: "Warning",
            reason: "BackOff",
            message: `Restart ${index}`,
            lastTimestamp: `2026-08-14T16:5${index}:00.000Z`
          }))
        };
        throw new Error(`Unexpected JSON URL: ${url}`);
      }
    };
    const cappedText: TextHttpClient = {
      getText(): Promise<string> {
        return Promise.resolve(Array.from({ length: 12 }, (_, index) => `2026-08-14T16:59:${String(index).padStart(2, "0")}.000Z INFO line ${index}`).join("\n"));
      }
    };
    const capped = await new KubernetesLogReader({
      ...options, jsonClient: cappedJson, textClient: cappedText, maxPods: 1, maxStreams: 1, maxEntries: 10, maxEvents: 50,
      now: () => new Date("2026-08-14T17:00:00.000Z")
    }).getLogs(query);
    expect(capped).toMatchObject({ truncated: true, limits: { maxPods: 1, maxStreams: 1, maxEntries: 10, maxEvents: 50 } });
    expect(capped.pods).toHaveLength(1);
    expect(capped.entries).toHaveLength(10);
    expect(capped.events).toHaveLength(5);
    expect(capped.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "workload-discovery", reason: "Pod results were capped at 1." }),
      expect.objectContaining({ source: "kubernetes-pod-logs", reason: "Log streams were capped at 1." }),
      expect.objectContaining({ source: "kubernetes-events", reason: "Recent events were capped at 5 for this object." })
    ]));
  });
});
