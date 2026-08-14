import { describe, expect, it } from "vitest";

import type { InventorySnapshot } from "../../shared/inventory";
import type { PerformanceSnapshot } from "../../shared/performance";
import type { TopologySnapshot } from "../../shared/topology";
import { createInventoryHttpServer, handleInventoryRequest, safeNodeRequestMethod, type InventoryReader, type PerformanceReader } from "../src/api";
import { InventoryAggregator } from "../src/inventory";
import { PerformanceRequestError } from "../src/prometheus";
import type { TopologyReader } from "../src/topology";
import { catalogFixture } from "./fixtures";

const reader = new InventoryAggregator(catalogFixture, [], () => new Date("2026-08-13T01:00:00Z"));

const performanceSnapshot: PerformanceSnapshot = {
  apiVersion: 1,
  mode: "live",
  assembledAt: "2026-08-13T18:00:00.000Z",
  observedAt: "2026-08-13T18:00:00.000Z",
  environment: "demo",
  serviceId: "cpq-demo",
  window: { range: "1h", start: "2026-08-13T17:00:00.000Z", end: "2026-08-13T18:00:00.000Z", stepSeconds: 60, maxPoints: 61 },
  source: { name: "prometheus", availability: "available", message: null },
  metrics: []
};
const performanceReader: PerformanceReader = {
  async getPerformance(environment, serviceId, range): Promise<PerformanceSnapshot> {
    if (serviceId === "missing") throw new PerformanceRequestError("Unsupported service: missing");
    return { ...performanceSnapshot, environment: environment as "demo", serviceId, window: { ...performanceSnapshot.window, range: range as "1h" } };
  }
};
const topologyReader: TopologyReader = {
  async getTopology(environment): Promise<TopologySnapshot> {
    return { apiVersion: 1, mode: "live", assembledAt: "2026-08-14T10:00:00Z", environment: environment as "demo", namespaces: ["default"], truncated: false, resources: [], edges: [], source: { name: "kubernetes", availability: "available", message: null } };
  }
};

function request(path: string, method = "GET", inventoryReader: InventoryReader = reader, metricsReader: PerformanceReader = performanceReader): Promise<Response> {
  return handleInventoryRequest(new Request(`http://inventory-api.local${path}`, { method }), inventoryReader, metricsReader, topologyReader);
}

describe("read-only inventory API", () => {
  it("serves health and filtered inventory with no-store headers", async () => {
    const health = await request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "healthy" });

    const response = await request("/api/v1/inventory?environment=demo");
    const body = await response.json() as InventorySnapshot;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.environment).toBe("demo");
    expect(body.services.map((service) => service.id)).toEqual(["cpq-demo"]);
  });

  it("returns a service detail envelope with source status", async () => {
    const response = await request("/api/v1/services/cpq-demo");
    const body = await response.json() as { readonly service: { readonly id: string }; readonly sources: readonly unknown[] };

    expect(response.status).toBe(200);
    expect(body.service.id).toBe("cpq-demo");
    expect(body.sources.length).toBeGreaterThan(0);
  });

  it("serves performance only through bounded allow-listed filters", async () => {
    const response = await request("/api/v1/performance?environment=demo&service=cpq-demo&range=1h");
    const body = await response.json() as PerformanceSnapshot;

    expect(response.status).toBe(200);
    expect(body.serviceId).toBe("cpq-demo");
    expect(body.window.range).toBe("1h");

    for (const path of [
      "/api/v1/performance?environment=production",
      "/api/v1/performance?range=30d",
      "/api/v1/performance?service=missing",
      "/api/v1/performance?query=up",
      "/api/v1/performance?promql=up"
    ]) {
      const invalid = await request(path);
      expect(invalid.status).toBe(400);
    }
  });

  it("serves topology through an allow-listed environment filter", async () => {
    const response = await request("/api/v1/topology?environment=demo");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ apiVersion: 1, environment: "demo", namespaces: ["default"] });
    expect((await request("/api/v1/topology?environment=production")).status).toBe(400);
    expect((await request("/api/v1/topology?query=pods")).status).toBe(400);
  });

  it("does not leak unexpected Prometheus errors", async () => {
    const failingPerformanceReader: PerformanceReader = {
      async getPerformance(): Promise<PerformanceSnapshot> {
        throw new Error("Prometheus authorization=Bearer super-secret");
      }
    };
    const response = await request("/api/v1/performance", "GET", reader, failingPerformanceReader);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("Performance telemetry could not be assembled");
    expect(body).not.toContain("super-secret");
  });

  it("rejects writes, unsupported filters, and missing services explicitly", async () => {
    const write = await request("/api/v1/inventory", "POST");
    expect(write.status).toBe(405);
    expect(write.headers.get("allow")).toBe("GET, HEAD");

    const invalid = await request("/api/v1/inventory?environment=production");
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("Unsupported environment");

    const missing = await request("/api/v1/services/not-real");
    expect(missing.status).toBe(404);
  });

  it("supports HEAD and does not expose unexpected server errors", async () => {
    const head = await request("/api/v1/inventory", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const failingReader: InventoryReader = {
      async getInventory(): Promise<InventorySnapshot> {
        throw new Error("authorization=Bearer super-secret");
      }
    };
    const response = await request("/api/v1/inventory", "GET", failingReader);
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toContain("Inventory could not be assembled");
    expect(body).not.toContain("super-secret");
  });

  it("constructs the Node server adapter and rejects unknown routes", async () => {
    const server = createInventoryHttpServer(reader, performanceReader, topologyReader);
    expect(server.listening).toBe(false);
    const missing = await request("/api/v2/inventory");
    expect(missing.status).toBe(404);
  });

  it("normalizes forbidden Node HTTP methods to a safe 405 request", () => {
    expect(safeNodeRequestMethod("GET")).toBe("GET");
    expect(safeNodeRequestMethod("HEAD")).toBe("HEAD");
    expect(safeNodeRequestMethod("TRACE")).toBe("POST");
    expect(safeNodeRequestMethod(undefined)).toBe("GET");
  });
});
