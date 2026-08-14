import { describe, expect, it } from "vitest";

import type { JsonHttpClient } from "../src/http";
import { KubernetesTopologyReader, UnavailableTopologyReader } from "../src/topology";
import { catalogFixture } from "./fixtures";

function list(items: readonly unknown[], continuation = ""): object { return { metadata: { continue: continuation }, items }; }

describe("Kubernetes topology reader", () => {
  it("queries only catalog namespaces and explains pressure, crash loops, failed mounts, and storage", async () => {
    const urls: string[] = [];
    const client: JsonHttpClient = { async getJson(url): Promise<unknown> {
      urls.push(url);
      if (url.includes("/nodes")) return list([{ metadata: { name: "lab-node" }, status: { conditions: [{ type: "MemoryPressure", status: "True" }], capacity: { cpu: "8", memory: "32Gi" } } }]);
      if (url.includes("/namespaces/default/events")) return list([{ type: "Warning", reason: "FailedMount", message: "volume secret missing", involvedObject: { kind: "Pod", name: "application-mount" }, lastTimestamp: "2026-08-14T10:00:00Z" }]);
      if (url.includes("/pods")) return list([
        { metadata: { name: "application-abc", namespace: "default" }, spec: { nodeName: "lab-node" }, status: { phase: "Running", containerStatuses: [{ ready: false, restartCount: 8, state: { waiting: { reason: "CrashLoopBackOff" } } }] } },
        { metadata: { name: "application-mount", namespace: "default" }, spec: {}, status: { phase: "Pending", containerStatuses: [] } }
      ]);
      if (url.includes("/persistentvolumeclaims")) return list([{ metadata: { name: "data", namespace: "default" }, spec: { resources: { requests: { storage: "20Gi" } } }, status: { phase: "Pending" } }]);
      if (url.includes("/deployments")) return list([{ metadata: { name: "application", namespace: "default" }, spec: { replicas: 1 }, status: { readyReplicas: 0 } }]);
      if (url.endsWith("/namespaces/default")) return { metadata: { name: "default" }, status: { phase: "Active" } };
      return list([]);
    } };
    const reader = new KubernetesTopologyReader({ apiUrl: "https://kube.test", bearerToken: "token", toolUrl: "/tools/kubernetes/", catalog: catalogFixture, client, now: () => new Date("2026-08-14T10:01:00Z") });

    const snapshot = await reader.getTopology("demo");

    expect(snapshot.namespaces).toEqual(["default"]);
    expect(urls.every((url) => !url.includes("cpq-test"))).toBe(true);
    expect(snapshot.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "Node", name: "lab-node", issueCode: "node-pressure", state: "degraded" }),
      expect.objectContaining({ kind: "Pod", name: "application-abc", issueCode: "crash-loop", restarts: 8 }),
      expect.objectContaining({ kind: "PersistentVolumeClaim", name: "data", issueCode: "storage-capacity", capacity: "20Gi" })
    ]));
    expect(snapshot.resources.find((resource) => resource.name === "application-mount")).toMatchObject({ issueCode: "failed-mount", events: [expect.objectContaining({ reason: "FailedMount" })] });
    expect(snapshot.edges).toContainEqual({ from: "service:cpq-demo", to: "Deployment:default:application", relation: "runs-as" });
  });

  it("caps large inventories and rejects unsupported environments", async () => {
    const client: JsonHttpClient = { async getJson(url): Promise<unknown> {
      if (url.includes("/pods")) return list(Array.from({ length: 6 }, (_, index) => ({ metadata: { name: `pod-${index}`, namespace: "default" }, spec: {}, status: { phase: "Pending" } })), "next-page-token");
      if (url.endsWith("/namespaces/default")) return { metadata: { name: "default" }, status: { phase: "Active" } };
      return list([]);
    } };
    const reader = new KubernetesTopologyReader({ apiUrl: "https://kube.test", bearerToken: "token", toolUrl: "/tools/kubernetes/", catalog: catalogFixture, client, maxResources: 5 });
    expect((await reader.getTopology("demo")).truncated).toBe(true);
    await expect(reader.getTopology("production")).rejects.toThrow("Unsupported environment");
  });

  it("normalizes every supported resource kind and common workload states", async () => {
    const client: JsonHttpClient = { async getJson(url): Promise<unknown> {
      if (url.includes("/nodes")) return list([{ metadata: { name: "ready-node" }, status: { conditions: [{ type: "Ready", status: "True" }], capacity: { cpu: "4", memory: "8Gi" } } }]);
      if (url.endsWith("/namespaces/default")) return { metadata: { name: "default" }, status: { phase: "Terminating" } };
      if (url.includes("/deployments")) return list([
        { metadata: { name: "application", namespace: "default" }, spec: { replicas: 2 }, status: { readyReplicas: 1 } },
        { metadata: { name: "ready", namespace: "default" }, spec: { replicas: 1 }, status: { readyReplicas: 1 } }
      ]);
      if (url.includes("/statefulsets")) return list([{ metadata: { name: "database", namespace: "default" }, spec: {}, status: {} }]);
      if (url.includes("/pods")) return list([
        { metadata: { name: "restarted", namespace: "default" }, spec: { nodeName: "ready-node" }, status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 2 }] } },
        { metadata: { name: "failed", namespace: "default" }, spec: {}, status: { phase: "Failed", containerStatuses: [] } },
        { metadata: { name: "unknown", namespace: "default" }, spec: {}, status: {} }
      ]);
      if (url.includes("/services")) return list([{ metadata: { name: "api", namespace: "default" }, spec: { type: "LoadBalancer", clusterIP: "10.0.0.2" } }, { metadata: { name: "headless", namespace: "default" }, spec: {} }]);
      if (url.includes("/persistentvolumeclaims")) return list([{ metadata: { name: "bound-data", namespace: "default" }, spec: {}, status: { phase: "Bound", capacity: { storage: "40Gi" } } }]);
      if (url.includes("/ingresses")) return list([{ metadata: { name: "public", namespace: "default" }, spec: { rules: [{ host: "example.test" }] } }, { metadata: { name: "empty", namespace: "default" }, spec: {} }]);
      if (url.includes("/events")) return list([{ type: "Normal", reason: "Scheduled", message: "assigned", involvedObject: { kind: "Pod", name: "restarted" }, eventTime: "2026-08-14T11:00:00Z" }, { type: "Odd", involvedObject: {} }]);
      return list([]);
    } };
    const reader = new KubernetesTopologyReader({ apiUrl: "https://kube.test/", bearerToken: "token", toolUrl: "/tools/kubernetes", catalog: catalogFixture, client });
    const result = await reader.getTopology("all");
    expect(result.resources.map((resource) => resource.kind)).toEqual(expect.arrayContaining(["Node", "Namespace", "Deployment", "StatefulSet", "Pod", "Service", "PersistentVolumeClaim", "Ingress"]));
    expect(result.resources.find((resource) => resource.name === "ready-node")).toMatchObject({ state: "healthy", summary: expect.stringContaining("4 CPU") });
    expect(result.resources.find((resource) => resource.name === "application")).toMatchObject({ state: "degraded", serviceIds: ["cpq-demo"] });
    expect(result.resources.find((resource) => resource.name === "database")).toMatchObject({ state: "unknown" });
    expect(result.resources.find((resource) => resource.name === "restarted")).toMatchObject({ state: "healthy", issueCode: "restarts", restarts: 2, events: [expect.objectContaining({ reason: "Scheduled" })] });
    expect(result.resources.find((resource) => resource.name === "failed")?.state).toBe("failing");
    expect(result.resources.find((resource) => resource.name === "bound-data")).toMatchObject({ state: "healthy", capacity: "40Gi" });
    expect(result.resources.find((resource) => resource.name === "public")?.summary).toBe("example.test");
    expect(result.edges).toContainEqual({ from: "service:cpq-demo", to: "service:mailpit", relation: "depends-on" });
  });

  it("validates reader limits, malformed lists, and explicit unavailable mode", async () => {
    const client: JsonHttpClient = { async getJson(): Promise<unknown> { return {}; } };
    const options = { apiUrl: "https://kube.test", bearerToken: "token", toolUrl: "/", catalog: catalogFixture, client };
    expect(() => new KubernetesTopologyReader({ ...options, apiUrl: "" })).toThrow("required");
    expect(() => new KubernetesTopologyReader({ ...options, bearerToken: "" })).toThrow("required");
    expect(() => new KubernetesTopologyReader({ ...options, maxResources: 0 })).toThrow("1..2000");
    expect(() => new KubernetesTopologyReader({ ...options, maxResources: 2001 })).toThrow("1..2000");
    expect(() => new KubernetesTopologyReader({ ...options, concurrency: 0 })).toThrow("1..16");
    expect(() => new KubernetesTopologyReader({ ...options, concurrency: 17 })).toThrow("1..16");
    await expect(new KubernetesTopologyReader(options).getTopology("demo")).rejects.toThrow("NodeList.items");

    const unavailable = new UnavailableTopologyReader("credential missing", () => new Date("2026-08-14T12:00:00Z"));
    expect(await unavailable.getTopology("all")).toMatchObject({ mode: "partial", source: { availability: "unavailable", message: "credential missing" } });
    await expect(unavailable.getTopology("production")).rejects.toThrow("Unsupported environment");
  });
});
