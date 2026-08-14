import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "../src/config";

describe("inventory runtime configuration", () => {
  it("uses bounded defaults and same-origin source links", () => {
    const config = parseRuntimeConfig({});

    expect(config.port).toBe(3001);
    expect(config.requestTimeoutMs).toBe(3000);
    expect(config.gatusInternal.toolUrl).toBe("/tools/gatus-internal/api/v1/endpoints/statuses");
    expect(config.prometheus.apiUrl).toBe("http://prometheus:9090");
    expect(config.prometheus.concurrency).toBe(4);
    expect(config.kubernetes.tokenFile).toBe("/run/secrets/kubernetes_inventory_token");
    expect(config.kubernetes.toolUrl).toMatch(/^#/u);
  });

  it("accepts explicit overrides without accepting bearer tokens in environment variables", () => {
    const config = parseRuntimeConfig({
      INVENTORY_PORT: "4100",
      UPSTREAM_TIMEOUT_MS: "2500",
      KUBERNETES_API_URL: "https://kubernetes.example.test:6443",
      KUBERNETES_TOKEN_FILE: "/run/secrets/read_only_token",
      KUBERNETES_BEARER_TOKEN: "must-not-be-consumed",
      PROMETHEUS_API_URL: "https://prometheus.example.test",
      PROMETHEUS_CONCURRENCY: "6"
    });

    expect(config.port).toBe(4100);
    expect(config.kubernetes.apiUrl).toBe("https://kubernetes.example.test:6443");
    expect(config.kubernetes.tokenFile).toBe("/run/secrets/read_only_token");
    expect(config.prometheus).toEqual({ apiUrl: "https://prometheus.example.test", concurrency: 6 });
    expect(config).not.toHaveProperty("kubernetes.bearerToken");
  });

  it("rejects invalid numeric and upstream URL settings explicitly", () => {
    expect(() => parseRuntimeConfig({ INVENTORY_PORT: "0" })).toThrow("INVENTORY_PORT");
    expect(() => parseRuntimeConfig({ UPSTREAM_TIMEOUT_MS: "not-a-number" })).toThrow("UPSTREAM_TIMEOUT_MS");
    expect(() => parseRuntimeConfig({ GATUS_INTERNAL_API_URL: "file:///etc/passwd" })).toThrow("GATUS_INTERNAL_API_URL");
    expect(() => parseRuntimeConfig({ PROMETHEUS_CONCURRENCY: "9" })).toThrow("PROMETHEUS_CONCURRENCY");
  });
});
