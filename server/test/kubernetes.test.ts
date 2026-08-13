import { describe, expect, it } from "vitest";

import type { CatalogDefinition } from "../src/catalog";
import type { JsonHttpClient } from "../src/http";
import { KubernetesAdapter } from "../src/kubernetes";
import { catalogFixture } from "./fixtures";

describe("Kubernetes health adapter", () => {
  it("normalizes a native deployment response and extracts its image version", async () => {
    const client: JsonHttpClient = {
      async getJson(): Promise<unknown> {
        return {
          kind: "Deployment",
          metadata: { name: "application", namespace: "default" },
          spec: { replicas: 1, paused: false, template: { spec: { containers: [{ name: "spring-boot", image: "cpq-application:4.14.0" }] } } },
          status: { readyReplicas: 1, availableReplicas: 1 }
        };
      }
    };
    const adapter = new KubernetesAdapter({
      apiUrl: "https://kubernetes.example.test",
      bearerToken: "token",
      toolUrl: "/tools/kubernetes/",
      staleAfterSeconds: 180,
      client,
      now: () => new Date("2026-08-13T00:31:00Z")
    });

    const result = await adapter.collect(catalogFixture);

    expect(result.observations).toEqual([expect.objectContaining({
      serviceId: "cpq-demo",
      state: "healthy",
      version: "4.14.0",
      checkedAt: "2026-08-13T00:31:00.000Z"
    })]);
  });

  it("reports paused and malformed workloads explicitly", async () => {
    const paused: JsonHttpClient = {
      async getJson(): Promise<unknown> {
        return {
          kind: "Deployment",
          metadata: { name: "application", namespace: "default" },
          spec: { replicas: 1, paused: true, template: { spec: { containers: [{ name: "app", image: "app:1" }] } } },
          status: { readyReplicas: 0, availableReplicas: 0 }
        };
      }
    };
    const malformed: JsonHttpClient = { async getJson(): Promise<unknown> { return { kind: "Deployment" }; } };
    const options = { apiUrl: "https://kube.test", bearerToken: "token", toolUrl: "/tools/kubernetes/", staleAfterSeconds: 180, now: () => new Date() };

    expect((await new KubernetesAdapter({ ...options, client: paused }).collect(catalogFixture)).observations[0]?.state).toBe("paused");
    await expect(new KubernetesAdapter({ ...options, client: malformed }).collect(catalogFixture)).rejects.toThrow("malformed");
  });

  it("bounds concurrent workload requests", async () => {
    let active = 0;
    let maximum = 0;
    const client: JsonHttpClient = {
      async getJson(): Promise<unknown> {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        active -= 1;
        return {
          kind: "Deployment",
          metadata: { name: "application", namespace: "default" },
          spec: { replicas: 1, template: { spec: { containers: [{ name: "app", image: "app:1" }] } } },
          status: { readyReplicas: 1, availableReplicas: 1 }
        };
      }
    };
    const catalog: CatalogDefinition = {
      ...catalogFixture,
      services: Array.from({ length: 8 }, (_, index) => ({
        ...catalogFixture.services[0]!,
        id: `service-${index}`,
        workloads: [{ kind: "Deployment" as const, namespace: "default", name: `application-${index}` }]
      }))
    };
    const adapter = new KubernetesAdapter({ apiUrl: "https://kube.test", bearerToken: "token", toolUrl: "/tools/kubernetes/", staleAfterSeconds: 180, client, concurrency: 2, now: () => new Date() });

    await adapter.collect(catalog);

    expect(maximum).toBe(2);
  });

  it.each([
    [2, 1, false, "degraded"],
    [2, 0, false, "failing"],
    [undefined, 0, false, "unknown"],
    [1, 0, true, "paused"]
  ] as const)("normalizes deployment replicas %#", async (replicas, readyReplicas, paused, expected) => {
    const client: JsonHttpClient = { async getJson(): Promise<unknown> { return {
      metadata: { name: "application", namespace: "default" },
      spec: { replicas, paused, template: { spec: { containers: [{ image: "registry.example/app@sha256:1234567890abcdef1234567890abcdef" }] } } },
      status: { readyReplicas }
    }; } };
    const adapter = new KubernetesAdapter({ apiUrl: "https://kube.test/", bearerToken: "token", toolUrl: "/", staleAfterSeconds: 180, client });
    const observation = (await adapter.collect(catalogFixture)).observations[0];
    expect(observation?.state).toBe(expected);
    expect(observation?.version).toBe("sha256:1234567890ab");
  });

  it.each([
    ["Running", "healthy"],
    ["Pending", "degraded"],
    ["Failed", "failing"],
    ["Succeeded", "unknown"]
  ] as const)("normalizes Pod phase %s", async (phase, expected) => {
    let requestedUrl = "";
    const client: JsonHttpClient = { async getJson(url): Promise<unknown> {
      requestedUrl = url;
      return { metadata: { name: "keycloak", namespace: "default" }, spec: { containers: [{ image: "keycloak" }] }, status: { phase, containerStatuses: phase === "Running" ? [{ ready: true }] : [] } };
    } };
    const podCatalog: CatalogDefinition = {
      ...catalogFixture,
      services: [{ ...catalogFixture.services[0]!, workloads: [{ kind: "Pod", namespace: "default", name: "keycloak" }] }]
    };
    const result = await new KubernetesAdapter({ apiUrl: "https://kube.test/", bearerToken: "token", toolUrl: "/", staleAfterSeconds: 180, client }).collect(podCatalog);
    expect(result.observations[0]).toMatchObject({ state: expected, version: "keycloak", desired: 1 });
    expect(requestedUrl).toContain("/api/v1/namespaces/default/pods/keycloak");
  });

  it("rejects malformed pod/container data and invalid adapter options", async () => {
    const malformedPayloads: unknown[] = [
      { metadata: {}, spec: {}, status: {} },
      { metadata: { name: "keycloak", namespace: "default" }, spec: { containers: [] }, status: { phase: "Running" } },
      { metadata: { name: "keycloak", namespace: "default" }, spec: { containers: [{}] }, status: { phase: "Running" } }
    ];
    const podCatalog: CatalogDefinition = {
      ...catalogFixture,
      services: [{ ...catalogFixture.services[0]!, workloads: [{ kind: "Pod", namespace: "default", name: "keycloak" }] }]
    };
    for (const payload of malformedPayloads) {
      const client: JsonHttpClient = { async getJson(): Promise<unknown> { return payload; } };
      await expect(new KubernetesAdapter({ apiUrl: "https://kube.test", bearerToken: "token", toolUrl: "/", staleAfterSeconds: 180, client }).collect(podCatalog)).rejects.toThrow("malformed");
    }
    const client: JsonHttpClient = { async getJson(): Promise<unknown> { return {}; } };
    expect(() => new KubernetesAdapter({ apiUrl: "", bearerToken: "token", toolUrl: "/", staleAfterSeconds: 180, client })).toThrow("required");
    expect(() => new KubernetesAdapter({ apiUrl: "https://kube.test", bearerToken: "", toolUrl: "/", staleAfterSeconds: 180, client })).toThrow("required");
    expect(() => new KubernetesAdapter({ apiUrl: "https://kube.test", bearerToken: "token", toolUrl: "/", staleAfterSeconds: 180, client, concurrency: 0 })).toThrow("1..16");
    expect(() => new KubernetesAdapter({ apiUrl: "https://kube.test", bearerToken: "token", toolUrl: "/", staleAfterSeconds: 180, client, concurrency: 17 })).toThrow("1..16");
  });

  it.each([
    [undefined, "unknown"],
    [[{ ready: false }], "degraded"],
    [[{ ready: false, state: { waiting: { reason: "CrashLoopBackOff" } } }], "failing"]
  ] as const)("does not report a Running Pod healthy without ready containers %#", async (containerStatuses, expected) => {
    const client: JsonHttpClient = { async getJson(): Promise<unknown> { return {
      metadata: { name: "keycloak", namespace: "default" },
      spec: { containers: [{ image: "keycloak:26" }] },
      status: { phase: "Running", containerStatuses }
    }; } };
    const podCatalog: CatalogDefinition = {
      ...catalogFixture,
      services: [{ ...catalogFixture.services[0]!, workloads: [{ kind: "Pod", namespace: "default", name: "keycloak" }] }]
    };
    const result = await new KubernetesAdapter({ apiUrl: "https://kube.test", bearerToken: "token", toolUrl: "/", staleAfterSeconds: 180, client }).collect(podCatalog);
    expect(result.observations[0]?.state).toBe(expected);
  });

  it("handles a catalog with no mapped workloads without upstream requests", async () => {
    const client: JsonHttpClient = { async getJson(): Promise<unknown> { throw new Error("must not run"); } };
    const emptyCatalog: CatalogDefinition = { ...catalogFixture, services: [] };
    const result = await new KubernetesAdapter({ apiUrl: "https://kube.test", bearerToken: "token", toolUrl: "/", staleAfterSeconds: 180, client }).collect(emptyCatalog);
    expect(result).toMatchObject({ observedAt: null, observations: [] });
  });
});
