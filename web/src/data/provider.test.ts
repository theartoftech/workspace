import { describe, expect, it } from "vitest";

import { createFixtureMonitoringProvider } from "./provider";

describe("fixture monitoring provider", () => {
  it("returns an explicitly labeled fixture snapshot", async () => {
    const provider = createFixtureMonitoringProvider();
    const snapshot = await provider.getOverview("all", "1h");

    expect(snapshot.mode).toBe("fixture");
    expect(snapshot.services).toHaveLength(5);
    expect(snapshot.summary.totalServices).toBe(5);
    expect(snapshot.generatedAt).toMatch(/^2026-/);
  });

  it("filters service rows by environment", async () => {
    const provider = createFixtureMonitoringProvider();
    const snapshot = await provider.getOverview("demo", "1h");

    expect(snapshot.services.every((service) => service.environment === "demo")).toBe(true);
    expect(snapshot.summary.totalServices).toBe(2);
  });

  it("throws an explicit error for an unsupported environment", async () => {
    const provider = createFixtureMonitoringProvider();

    await expect(provider.getOverview("production" as never, "1h")).rejects.toThrow(
      "Unsupported environment"
    );
  });
});
