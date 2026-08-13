import { describe, expect, it } from "vitest";

import type { InventorySnapshot } from "../../shared/inventory";
import { createInventoryHttpServer, handleInventoryRequest, safeNodeRequestMethod, type InventoryReader } from "../src/api";
import { InventoryAggregator } from "../src/inventory";
import { catalogFixture } from "./fixtures";

const reader = new InventoryAggregator(catalogFixture, [], () => new Date("2026-08-13T01:00:00Z"));

function request(path: string, method = "GET", inventoryReader: InventoryReader = reader): Promise<Response> {
  return handleInventoryRequest(new Request(`http://inventory-api.local${path}`, { method }), inventoryReader);
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
    const server = createInventoryHttpServer(reader);
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
