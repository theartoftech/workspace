import { describe, expect, it } from "vitest";

import { handleInventoryRequest, type InventoryReader } from "../src/api";
import { DisabledSyntheticJourneyService, type SyntheticJourneyReader } from "../src/synthetic";

const inventory: InventoryReader = {
  getInventory: async () => ({
    apiVersion: 1,
    mode: "live",
    assembledAt: "2026-08-17T14:00:00.000Z",
    lastObservedAt: null,
    environment: "all",
    summary: { total: 0, healthy: 0, degraded: 0, failing: 0, unknown: 0, paused: 0, stale: 0 },
    services: [],
    sources: []
  })
};

describe("synthetic journey evidence API", () => {
  it("serves only bounded read-only evidence with GET and HEAD", async () => {
    const reader = new DisabledSyntheticJourneyService();
    const response = await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/journeys"), inventory, undefined, undefined, undefined, undefined, reader);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ apiVersion: 1, runner: { state: "disabled" } });

    const head = await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/journeys", { method: "HEAD" }), inventory, undefined, undefined, undefined, undefined, reader);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("rejects parameters and writes and reports missing capability explicitly", async () => {
    const reader = new DisabledSyntheticJourneyService();
    const parameter = await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/journeys?environment=test"), inventory, undefined, undefined, undefined, undefined, reader);
    expect(parameter.status).toBe(400);
    expect(await parameter.json()).toMatchObject({ error: { code: "invalid_parameter" } });

    const write = await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/journeys", { method: "POST" }), inventory, undefined, undefined, undefined, undefined, reader);
    expect(write.status).toBe(405);

    const unavailable = await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/journeys"), inventory);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: { code: "synthetic_journeys_unavailable" } });
  });

  it("does not expose unexpected reader failures", async () => {
    const reader: SyntheticJourneyReader = { getSyntheticJourneys: async () => { throw new Error("token=private-value"); } };
    const response = await handleInventoryRequest(new Request("http://inventory-api.local/api/v1/journeys"), inventory, undefined, undefined, undefined, undefined, reader);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-value");
  });
});
