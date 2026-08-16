import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "../src/config";

const authenticationEnvironment = {
  AUTH_PUBLIC_ORIGIN: "https://monitor.jefferyhaynes.net",
  AUTH_AUDIT_DATABASE_PATH: "/var/lib/workspace-monitor/auth.sqlite",
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://lab.cloudflareaccess.com",
  CLOUDFLARE_ACCESS_AUDIENCE: "a".repeat(64),
  CLOUDFLARE_ACCESS_ROLE_MAPPING_FILE: "/run/secrets/cloudflare_access_roles"
} as const;

describe("inventory runtime configuration", () => {
  it("uses bounded defaults and same-origin source links", () => {
    const config = parseRuntimeConfig(authenticationEnvironment);

    expect(config.port).toBe(3001);
    expect(config.requestTimeoutMs).toBe(3000);
    expect(config.gatusInternal.toolUrl).toBe("/tools/gatus-internal/api/v1/endpoints/statuses");
    expect(config.prometheus.apiUrl).toBe("http://prometheus:9090");
    expect(config.prometheus.concurrency).toBe(4);
    expect(config.kubernetes.tokenFile).toBe("/run/secrets/kubernetes_inventory_token");
    expect(config.kubernetes.toolUrl).toMatch(/^#/u);
    expect(config.incidents).toEqual({ databasePath: "deploy/compose/lab-observability/data/incidents.sqlite", evaluationIntervalSeconds: 30 });
    expect(config.authentication).toEqual({
      publicOrigin: "https://monitor.jefferyhaynes.net",
      teamDomain: "https://lab.cloudflareaccess.com",
      audience: "a".repeat(64),
      roleMappingFile: "/run/secrets/cloudflare_access_roles",
      auditDatabasePath: "/var/lib/workspace-monitor/auth.sqlite",
      auditRetentionDays: 180,
      auditMaxRecords: 100_000,
      clockToleranceSeconds: 30,
      maxTokenLifetimeSeconds: 86_400,
      timeoutSeconds: 5
    });
  });

  it("accepts explicit overrides without accepting credentials in environment variables", () => {
    const config = parseRuntimeConfig({
      ...authenticationEnvironment,
      INVENTORY_PORT: "4100",
      UPSTREAM_TIMEOUT_MS: "2500",
      KUBERNETES_API_URL: "https://kubernetes.example.test:6443",
      KUBERNETES_TOKEN_FILE: "/run/secrets/read_only_token",
      KUBERNETES_BEARER_TOKEN: "must-not-be-consumed",
      PROMETHEUS_API_URL: "https://prometheus.example.test",
      PROMETHEUS_CONCURRENCY: "6",
      INCIDENT_DATABASE_PATH: "/var/lib/workspace-monitor/incidents.sqlite",
      INCIDENT_EVALUATION_INTERVAL_SECONDS: "60",
      CLOUDFLARE_ACCESS_CLOCK_TOLERANCE_SECONDS: "45",
      CLOUDFLARE_ACCESS_MAX_TOKEN_LIFETIME_SECONDS: "43200",
      CLOUDFLARE_ACCESS_JWKS_TIMEOUT_SECONDS: "7"
    });

    expect(config.port).toBe(4100);
    expect(config.kubernetes.apiUrl).toBe("https://kubernetes.example.test:6443");
    expect(config.kubernetes.tokenFile).toBe("/run/secrets/read_only_token");
    expect(config.prometheus).toEqual({ apiUrl: "https://prometheus.example.test", concurrency: 6 });
    expect(config.incidents).toEqual({ databasePath: "/var/lib/workspace-monitor/incidents.sqlite", evaluationIntervalSeconds: 60 });
    expect(config.authentication).toMatchObject({ clockToleranceSeconds: 45, maxTokenLifetimeSeconds: 43_200, timeoutSeconds: 7 });
    expect(config).not.toHaveProperty("kubernetes.bearerToken");
  });

  it("rejects invalid numeric, upstream URL, and Access trust settings explicitly", () => {
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, INVENTORY_PORT: "0" })).toThrow("INVENTORY_PORT");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, UPSTREAM_TIMEOUT_MS: "not-a-number" })).toThrow("UPSTREAM_TIMEOUT_MS");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, GATUS_INTERNAL_API_URL: "file:///etc/passwd" })).toThrow("GATUS_INTERNAL_API_URL");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, PROMETHEUS_CONCURRENCY: "9" })).toThrow("PROMETHEUS_CONCURRENCY");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, INCIDENT_DATABASE_PATH: ":memory:" })).toThrow("INCIDENT_DATABASE_PATH");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, INCIDENT_EVALUATION_INTERVAL_SECONDS: "10" })).toThrow("INCIDENT_EVALUATION_INTERVAL_SECONDS");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, AUTH_PUBLIC_ORIGIN: "http://monitor.example.test" })).toThrow("AUTH_PUBLIC_ORIGIN");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, AUTH_PUBLIC_ORIGIN: "not-a-url" })).toThrow("AUTH_PUBLIC_ORIGIN");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, CLOUDFLARE_ACCESS_TEAM_DOMAIN: "http://lab.cloudflareaccess.com" })).toThrow("CLOUDFLARE_ACCESS_TEAM_DOMAIN");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://attacker.example" })).toThrow("CLOUDFLARE_ACCESS_TEAM_DOMAIN");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, CLOUDFLARE_ACCESS_AUDIENCE: "bad audience" })).toThrow("CLOUDFLARE_ACCESS_AUDIENCE");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, CLOUDFLARE_ACCESS_MAX_TOKEN_LIFETIME_SECONDS: "59" })).toThrow("CLOUDFLARE_ACCESS_MAX_TOKEN_LIFETIME_SECONDS");
  });

  it("requires explicit Cloudflare Access identity and host-only role mapping configuration", () => {
    expect(() => parseRuntimeConfig({})).toThrow("AUTH_PUBLIC_ORIGIN");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, CLOUDFLARE_ACCESS_AUDIENCE: "" })).toThrow("CLOUDFLARE_ACCESS_AUDIENCE");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, CLOUDFLARE_ACCESS_ROLE_MAPPING_FILE: undefined })).toThrow("CLOUDFLARE_ACCESS_ROLE_MAPPING_FILE");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, CF_ACCESS_CLIENT_SECRET: "must-never-be-read" })).not.toThrow();
    expect(parseRuntimeConfig({ ...authenticationEnvironment, CF_ACCESS_CLIENT_SECRET: "must-never-be-read" }).authentication).not.toHaveProperty("clientSecret");
  });
});
