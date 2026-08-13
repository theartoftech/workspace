import { describe, expect, it, vi } from "vitest";

import { createFixtureMonitoringProvider, createLiveMonitoringProvider } from "./provider";

describe("fixture monitoring provider", () => {
  it("returns an explicitly labeled fixture snapshot", async () => {
    const provider = createFixtureMonitoringProvider();
    const snapshot = await provider.getOverview("all", "1h");

    expect(snapshot.mode).toBe("fixture");
    expect(snapshot.services).toHaveLength(5);
    expect(snapshot.summary.total).toBe(5);
    expect(snapshot.generatedAt).toMatch(/^2026-/);
  });

  it("filters service rows by environment", async () => {
    const provider = createFixtureMonitoringProvider();
    const snapshot = await provider.getOverview("demo", "1h");

    expect(snapshot.services.every((service) => service.environment === "demo")).toBe(true);
    expect(snapshot.summary.total).toBe(2);
  });

  it("throws an explicit error for an unsupported environment", async () => {
    const provider = createFixtureMonitoringProvider();

    await expect(provider.getOverview("production" as never, "1h")).rejects.toThrow(
      "Unsupported environment"
    );
  });

  it("loads live inventory from the same-origin read-only API", async () => {
    const fetchImpl = vi.fn((): Promise<Response> => Promise.resolve(new Response(JSON.stringify({
      apiVersion: 1,
      mode: "partial",
      assembledAt: "2026-08-13T01:00:00Z",
      lastObservedAt: "2026-08-13T00:59:55Z",
      environment: "demo",
      summary: { total: 1, healthy: 0, degraded: 1, failing: 0, unknown: 0, paused: 0, stale: 0 },
      services: [{
        id: "cpq-demo", name: "CPQ Demo", kind: "application", environment: "demo", owner: "Development Lab",
        criticality: "critical", state: "degraded", lastCheckedAt: "2026-08-13T00:59:55Z", version: "4.14.0",
        endpoint: "https://demo.example.test/ready", reachability: { internal: "healthy", external: "failing", comparison: "disagreement" },
        probes: [], workloads: [], sourceLinks: []
      }],
      sources: [{ source: "kubernetes", availability: "unavailable", observedAt: null, toolUrl: null, message: "Credential unavailable" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const provider = createLiveMonitoringProvider({ fetchImpl, timeoutMs: 1000 });

    const snapshot = await provider.getOverview("demo", "1h");

    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/inventory?environment=demo", expect.objectContaining({ method: "GET" }));
    expect(snapshot.mode).toBe("partial");
    expect(snapshot.services[0]?.reachability.comparison).toBe("disagreement");
  });

  it("fails explicitly on malformed or unavailable live inventory without fixture fallback", async () => {
    const malformed = createLiveMonitoringProvider({
      fetchImpl: (): Promise<Response> => Promise.resolve(new Response(JSON.stringify({ mode: "live" }), { status: 200 })),
      timeoutMs: 1000
    });
    const unavailable = createLiveMonitoringProvider({
      fetchImpl: (): Promise<Response> => Promise.resolve(new Response("upstream down", { status: 503 })),
      timeoutMs: 1000
    });

    await expect(malformed.getOverview("all", "1h")).rejects.toThrow("malformed");
    await expect(unavailable.getOverview("all", "1h")).rejects.toThrow("HTTP 503");
  });
});
