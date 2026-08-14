import { describe, expect, it } from "vitest";

import type { SourceCollection, SourceCollector } from "../src/inventory";
import { InventoryAggregator } from "../src/inventory";
import { UpstreamError } from "../src/http";
import { catalogFixture } from "./fixtures";

function collector(collection: SourceCollection): SourceCollector {
  return { source: collection.source, toolUrl: collection.toolUrl, async collect(): Promise<SourceCollection> { return collection; } };
}

describe("inventory aggregation", () => {
  it("keeps internal/external disagreement visible instead of averaging it", async () => {
    const aggregator = new InventoryAggregator(catalogFixture, [
      collector({ source: "gatus-internal", toolUrl: "/tools/internal/", observedAt: "2026-08-13T00:30:00Z", observations: [{ serviceId: "cpq-demo", probeId: "cpq-demo-ready-internal", state: "healthy", checkedAt: "2026-08-13T00:30:00Z", latencyMs: 2, statusCode: 200 }] }),
      collector({ source: "gatus-public-path", toolUrl: "/tools/public/", observedAt: "2026-08-13T00:30:10Z", observations: [{ serviceId: "cpq-demo", probeId: "cpq-demo-ready-external", state: "failing", checkedAt: "2026-08-13T00:30:10Z", latencyMs: 20, statusCode: 503 }] })
    ], () => new Date("2026-08-13T00:31:00Z"));

    const snapshot = await aggregator.getInventory("all");
    const service = snapshot.services.find((item) => item.id === "cpq-demo");

    expect(service?.state).toBe("failing");
    expect(service?.reachability).toEqual({ internal: "healthy", external: "failing", comparison: "disagreement" });
    expect(service?.lastCheckedAt).toBe("2026-08-13T00:30:10.000Z");
  });

  it("retains good data and marks affected services when one source fails", async () => {
    const failing: SourceCollector = {
      source: "kubernetes",
      toolUrl: "/tools/kubernetes/",
      async collect(): Promise<SourceCollection> { throw new UpstreamError("unavailable", "Kubernetes token=super-secret unavailable"); }
    };
    const aggregator = new InventoryAggregator(catalogFixture, [
      collector({ source: "gatus-internal", toolUrl: "/tools/internal/", observedAt: "2026-08-13T00:30:00Z", observations: [{ serviceId: "cpq-demo", probeId: "cpq-demo-ready-internal", state: "healthy", checkedAt: "2026-08-13T00:30:00Z", latencyMs: 2, statusCode: 200 }] }),
      failing
    ], () => new Date("2026-08-13T00:31:00Z"));

    const snapshot = await aggregator.getInventory("demo");

    expect(snapshot.mode).toBe("partial");
    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.services[0]?.state).toBe("degraded");
    expect(snapshot.sources.find((source) => source.source === "kubernetes")?.message).not.toContain("super-secret");
  });

  it("does not allow stale observations to produce a healthy service", async () => {
    const aggregator = new InventoryAggregator(catalogFixture, [
      collector({ source: "gatus-internal", toolUrl: "/tools/internal/", observedAt: "2026-08-13T00:20:00Z", observations: [{ serviceId: "mailpit", probeId: "mailpit-api-internal", state: "stale", checkedAt: "2026-08-13T00:20:00Z", latencyMs: 2, statusCode: 200 }] })
    ], () => new Date("2026-08-13T00:31:00Z"));

    const snapshot = await aggregator.getInventory("shared");

    expect(snapshot.services[0]?.state).toBe("stale");
    expect(snapshot.summary.healthy).toBe(0);
  });

  it("rejects unsupported environment filters", async () => {
    const aggregator = new InventoryAggregator(catalogFixture, [], () => new Date());
    await expect(aggregator.getInventory("production")).rejects.toThrow("Unsupported environment");
  });

  it("filters Portfolio into its standalone environment", async () => {
    const catalog = {
      ...catalogFixture,
      services: [{ ...catalogFixture.services[0]!, id: "portfolio", displayName: "Portfolio", environment: "portfolio" as const }]
    };
    const aggregator = new InventoryAggregator(catalog, [], () => new Date("2026-08-14T10:00:00Z"));
    const snapshot = await aggregator.getInventory("portfolio");
    expect(snapshot.services.map((service) => service.id)).toEqual(["portfolio"]);
  });
});
