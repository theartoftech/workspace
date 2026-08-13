import { describe, expect, it } from "vitest";

import { GatusAdapter } from "../src/gatus";
import type { JsonHttpClient } from "../src/http";
import { UpstreamError } from "../src/http";
import { catalogFixture, gatusEndpoint } from "./fixtures";

describe("Gatus health adapter", () => {
  it("preserves the latest source timestamp and normalizes status", async () => {
    const client: JsonHttpClient = {
      async getJson(): Promise<unknown> {
        return [gatusEndpoint("cpq-demo-ready-internal", "cpq-demo", true, "2026-08-13T00:30:00Z")];
      }
    };
    const adapter = new GatusAdapter("gatus-internal", "http://gatus/api/v1/endpoints/statuses", "/tools/gatus-internal/", client, 180);

    const result = await adapter.collect(catalogFixture, new Date("2026-08-13T00:31:00Z"));

    expect(result.observations).toContainEqual(expect.objectContaining({
      probeId: "cpq-demo-ready-internal",
      state: "healthy",
      checkedAt: "2026-08-13T00:30:00.000Z",
      latencyMs: 2.5
    }));
    expect(result.observedAt).toBe("2026-08-13T00:30:00.000Z");
  });

  it("never reports stale, paused, or missing results as healthy", async () => {
    const client: JsonHttpClient = {
      async getJson(): Promise<unknown> {
        return [
          gatusEndpoint("cpq-demo-ready-internal", "cpq-demo", true, "2026-08-13T00:20:00Z"),
          { name: "mailpit-api-internal", group: "mailpit", enabled: false, results: [] }
        ];
      }
    };
    const adapter = new GatusAdapter("gatus-internal", "http://gatus/api", "/tools/gatus-internal/", client, 180);

    const result = await adapter.collect(catalogFixture, new Date("2026-08-13T00:31:00Z"));

    expect(result.observations.find((item) => item.probeId === "cpq-demo-ready-internal")?.state).toBe("stale");
    expect(result.observations.find((item) => item.probeId === "mailpit-api-internal")?.state).toBe("paused");
  });

  it("maps malformed payloads and timeouts to explicit redacted errors", async () => {
    const malformed: JsonHttpClient = { async getJson(): Promise<unknown> { return { not: "an array" }; } };
    const timedOut: JsonHttpClient = {
      async getJson(): Promise<unknown> {
        throw new UpstreamError("timeout", "request timed out; Authorization: Bearer super-secret");
      }
    };

    await expect(new GatusAdapter("gatus-internal", "http://gatus/api", "/tools/gatus-internal/", malformed, 180).collect(catalogFixture, new Date())).rejects.toThrow("malformed");
    await expect(new GatusAdapter("gatus-internal", "http://gatus/api", "/tools/gatus-internal/", timedOut, 180).collect(catalogFixture, new Date())).rejects.toThrow("[REDACTED]");
  });

  it("uses the newest public-path result and retains a failing observation", async () => {
    const client: JsonHttpClient = { async getJson(): Promise<unknown> {
      const endpoint = gatusEndpoint("cpq-demo-ready-external", "cpq-demo", false, "2026-08-13T00:30:00Z") as { results: object[] };
      endpoint.results.push({ status: 200, duration: 1_000_000, success: true, timestamp: "2026-08-13T00:20:00Z" });
      return [endpoint];
    } };
    const adapter = new GatusAdapter("gatus-public-path", "http://gatus/api", "/tools/gatus-public-path/", client, 180);

    const result = await adapter.collect(catalogFixture, new Date("2026-08-13T00:31:00Z"));

    expect(result.source).toBe("gatus-public-path");
    expect(result.observations[0]).toMatchObject({ state: "failing", statusCode: 503 });
  });

  it("reports enabled endpoints without results as unknown and rejects invalid stale thresholds", async () => {
    const client: JsonHttpClient = { async getJson(): Promise<unknown> {
      return [{ name: "mailpit-api-internal", group: "mailpit", enabled: true, results: [] }];
    } };
    const adapter = new GatusAdapter("gatus-internal", "http://gatus/api", "/tools/gatus-internal/", client, 180);
    const result = await adapter.collect(catalogFixture, new Date());
    expect(result.observations.every((observation) => observation.state === "unknown")).toBe(true);
    expect(() => new GatusAdapter("gatus-internal", "http://gatus/api", "/", client, 0)).toThrow("positive");
  });

  it.each([
    [null, "endpoint"],
    [{ name: 3, group: "bad", results: [] }, "endpoint"],
    [{ name: "probe", group: "bad", results: [null] }, "result"],
    [{ name: "probe", group: "bad", results: [{ status: 200, duration: 1, success: true, timestamp: 3 }] }, "result"],
    [{ name: "probe", group: "bad", results: [{ status: 200, duration: 1, success: true, timestamp: "not-a-date" }] }, "timestamp"]
  ])("rejects malformed Gatus endpoint payload %#", async (endpoint, message) => {
    const client: JsonHttpClient = { async getJson(): Promise<unknown> { return [endpoint]; } };
    await expect(new GatusAdapter("gatus-internal", "http://gatus/api", "/", client, 180).collect(catalogFixture)).rejects.toThrow(message);
  });
});
