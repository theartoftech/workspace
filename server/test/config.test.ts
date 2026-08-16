import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "../src/config";

const authenticationEnvironment = {
  AUTH_PUBLIC_ORIGIN: "https://monitor.jefferyhaynes.net",
  AUTH_SESSION_DATABASE_PATH: "/var/lib/workspace-monitor/auth.sqlite",
  AUTH_SESSION_KEYRING_FILE: "/run/secrets/auth_session_keyring",
  OIDC_ISSUER_URL: "https://identity.example.test/realms/lab",
  OIDC_CLIENT_ID: "workspace-monitor",
  OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc_client_secret",
  OIDC_SCOPES: "openid profile",
  OIDC_ROLE_CLAIM: "groups",
  OIDC_DISPLAY_NAME_CLAIM: "preferred_username",
  OIDC_VIEWER_GROUP: "/workspace-monitor/viewer",
  OIDC_OPERATOR_GROUP: "/workspace-monitor/operator",
  OIDC_ADMINISTRATOR_GROUP: "/workspace-monitor/administrator"
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
    expect(config.authentication).toMatchObject({
      publicOrigin: "https://monitor.jefferyhaynes.net",
      redirectUri: "https://monitor.jefferyhaynes.net/auth/callback",
      postLogoutRedirectUri: "https://monitor.jefferyhaynes.net/",
      issuerUrl: "https://identity.example.test/realms/lab",
      clientId: "workspace-monitor",
      clientSecretFile: "/run/secrets/oidc_client_secret",
      sessionDatabasePath: "/var/lib/workspace-monitor/auth.sqlite",
      sessionKeyringFile: "/run/secrets/auth_session_keyring",
      roleClaim: "groups",
      displayNameClaim: "preferred_username",
      scopes: ["openid", "profile"],
      idleSeconds: 3600,
      absoluteSeconds: 43_200,
      auditRetentionDays: 180
    });
  });

  it("accepts explicit overrides without accepting bearer tokens in environment variables", () => {
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
      AUTH_SESSION_IDLE_SECONDS: "1800",
      AUTH_SESSION_ABSOLUTE_SECONDS: "28800",
      OIDC_SCOPES: "openid profile groups",
      OIDC_ROLE_CLAIM: "realm_access.groups"
    });

    expect(config.port).toBe(4100);
    expect(config.kubernetes.apiUrl).toBe("https://kubernetes.example.test:6443");
    expect(config.kubernetes.tokenFile).toBe("/run/secrets/read_only_token");
    expect(config.prometheus).toEqual({ apiUrl: "https://prometheus.example.test", concurrency: 6 });
    expect(config.incidents).toEqual({ databasePath: "/var/lib/workspace-monitor/incidents.sqlite", evaluationIntervalSeconds: 60 });
    expect(config.authentication).toMatchObject({ idleSeconds: 1800, absoluteSeconds: 28_800, scopes: ["openid", "profile", "groups"], roleClaim: "realm_access.groups" });
    expect(config).not.toHaveProperty("kubernetes.bearerToken");
  });

  it("rejects invalid numeric and upstream URL settings explicitly", () => {
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, INVENTORY_PORT: "0" })).toThrow("INVENTORY_PORT");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, UPSTREAM_TIMEOUT_MS: "not-a-number" })).toThrow("UPSTREAM_TIMEOUT_MS");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, GATUS_INTERNAL_API_URL: "file:///etc/passwd" })).toThrow("GATUS_INTERNAL_API_URL");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, PROMETHEUS_CONCURRENCY: "9" })).toThrow("PROMETHEUS_CONCURRENCY");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, INCIDENT_DATABASE_PATH: ":memory:" })).toThrow("INCIDENT_DATABASE_PATH");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, INCIDENT_EVALUATION_INTERVAL_SECONDS: "10" })).toThrow("INCIDENT_EVALUATION_INTERVAL_SECONDS");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, AUTH_PUBLIC_ORIGIN: "http://monitor.example.test" })).toThrow("AUTH_PUBLIC_ORIGIN");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, OIDC_ISSUER_URL: "http://identity.example.test" })).toThrow("OIDC_ISSUER_URL");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, OIDC_SCOPES: "profile" })).toThrow("OIDC_SCOPES");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, AUTH_SESSION_IDLE_SECONDS: "43200" })).toThrow("shorter");
  });

  it("requires explicit identity-provider and server-side credential file configuration", () => {
    expect(() => parseRuntimeConfig({})).toThrow("AUTH_PUBLIC_ORIGIN");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, OIDC_CLIENT_ID: "" })).toThrow("OIDC_CLIENT_ID");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, OIDC_ROLE_CLAIM: undefined })).toThrow("OIDC_ROLE_CLAIM");
    expect(() => parseRuntimeConfig({ ...authenticationEnvironment, OIDC_CLIENT_SECRET: "must-never-be-read" }))
      .not.toThrow();
    expect(parseRuntimeConfig({ ...authenticationEnvironment, OIDC_CLIENT_SECRET: "must-never-be-read" }).authentication)
      .not.toHaveProperty("clientSecret");
  });
});
