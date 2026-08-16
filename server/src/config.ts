export interface GatusRuntimeConfig {
  readonly apiUrl: string;
  readonly toolUrl: string;
}

export interface KubernetesRuntimeConfig {
  readonly apiUrl: string;
  readonly tokenFile: string;
  readonly toolUrl: string;
  readonly concurrency: number;
}

export interface PrometheusRuntimeConfig {
  readonly apiUrl: string;
  readonly concurrency: number;
}

export interface IncidentRuntimeConfig {
  readonly databasePath: string;
  readonly evaluationIntervalSeconds: number;
}

export interface AuthenticationRuntimeConfig {
  readonly publicOrigin: string;
  readonly redirectUri: string;
  readonly postLogoutRedirectUri: string;
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecretFile: string;
  readonly sessionDatabasePath: string;
  readonly sessionKeyringFile: string;
  readonly scopes: readonly string[];
  readonly roleClaim: string;
  readonly displayNameClaim: string;
  readonly groups: {
    readonly viewer: string;
    readonly operator: string;
    readonly administrator: string;
  };
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
  readonly transactionSeconds: number;
  readonly auditRetentionDays: number;
  readonly auditMaxRecords: number;
  readonly clockToleranceSeconds: number;
  readonly timeoutSeconds: number;
}

export interface RuntimeConfig {
  readonly port: number;
  readonly catalogPath: string;
  readonly requestTimeoutMs: number;
  readonly staleAfterSeconds: number;
  readonly gatusInternal: GatusRuntimeConfig;
  readonly gatusPublicPath: GatusRuntimeConfig;
  readonly kubernetes: KubernetesRuntimeConfig;
  readonly prometheus: PrometheusRuntimeConfig;
  readonly incidents: IncidentRuntimeConfig;
  readonly authentication: AuthenticationRuntimeConfig;
}

type Environment = Readonly<Record<string, string | undefined>>;

function integer(environment: Environment, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function httpUrl(environment: Environment, name: string, fallback: string): string {
  const raw = environment[name] ?? fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must be an absolute HTTP(S) URL`);
  if (url.username !== "" || url.password !== "") throw new Error(`${name} must not contain credentials`);
  return url.toString().replace(/\/$/u, "");
}

function nonempty(environment: Environment, name: string, fallback: string): string {
  const value = environment[name] ?? fallback;
  if (value.trim() === "") throw new Error(`${name} must not be empty`);
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function printable(environment: Environment, name: string, fallback: string, maximum: number): string {
  const value = nonempty(environment, name, fallback).trim();
  if (value.length > maximum || hasControlCharacter(value)) throw new Error(`${name} must contain at most ${maximum} printable characters`);
  return value;
}

function databasePath(environment: Environment): string {
  const value = printable(environment, "INCIDENT_DATABASE_PATH", "deploy/compose/lab-observability/data/incidents.sqlite", 1024);
  if (value === ":memory:" || value.startsWith("file::memory:")) throw new Error("INCIDENT_DATABASE_PATH must use persistent filesystem storage");
  return value;
}

function persistentPath(environment: Environment, name: string, maximum = 1024): string {
  const value = printable(environment, name, "", maximum);
  if (value === ":memory:" || value.startsWith("file::memory:")) throw new Error(`${name} must use persistent filesystem storage`);
  return value;
}

function httpsUrl(environment: Environment, name: string): string {
  const raw = printable(environment, name, "", 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url.toString().replace(/\/$/u, "");
}

function httpsOrigin(environment: Environment): string {
  const raw = httpsUrl(environment, "AUTH_PUBLIC_ORIGIN");
  const url = new URL(raw);
  if (url.origin !== raw || url.pathname !== "/") throw new Error("AUTH_PUBLIC_ORIGIN must be an HTTPS origin without a path");
  return raw;
}

function claimPath(environment: Environment, name: string, fallback: string): string {
  const value = printable(environment, name, fallback, 256);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/u.test(value)) throw new Error(`${name} must be a dot-separated claim path`);
  return value;
}

function scopes(environment: Environment): readonly string[] {
  const raw = printable(environment, "OIDC_SCOPES", "", 512);
  const values = raw.split(/\s+/u);
  if (!values.includes("openid") || new Set(values).size !== values.length || values.some((value) => !/^[A-Za-z0-9._:-]{1,64}$/u.test(value))) {
    throw new Error("OIDC_SCOPES must contain unique safe scope names including openid");
  }
  return values;
}

export function parseRuntimeConfig(environment: Environment): RuntimeConfig {
  const publicOrigin = httpsOrigin(environment);
  const idleSeconds = integer(environment, "AUTH_SESSION_IDLE_SECONDS", 3600, 60, 86_400);
  const absoluteSeconds = integer(environment, "AUTH_SESSION_ABSOLUTE_SECONDS", 43_200, 300, 604_800);
  if (idleSeconds >= absoluteSeconds) throw new Error("AUTH_SESSION_IDLE_SECONDS must be shorter than AUTH_SESSION_ABSOLUTE_SECONDS");
  return {
    port: integer(environment, "INVENTORY_PORT", 3001, 1, 65_535),
    catalogPath: nonempty(environment, "CATALOG_PATH", "catalog/services.json"),
    requestTimeoutMs: integer(environment, "UPSTREAM_TIMEOUT_MS", 3000, 100, 30_000),
    staleAfterSeconds: integer(environment, "SOURCE_STALE_AFTER_SECONDS", 180, 1, 86_400),
    gatusInternal: {
      apiUrl: httpUrl(environment, "GATUS_INTERNAL_API_URL", "http://gatus-internal:8080/api/v1/endpoints/statuses"),
      toolUrl: nonempty(environment, "GATUS_INTERNAL_TOOL_URL", "/tools/gatus-internal/api/v1/endpoints/statuses")
    },
    gatusPublicPath: {
      apiUrl: httpUrl(environment, "GATUS_PUBLIC_PATH_API_URL", "http://gatus-public-path:8080/api/v1/endpoints/statuses"),
      toolUrl: nonempty(environment, "GATUS_PUBLIC_PATH_TOOL_URL", "/tools/gatus-public-path/api/v1/endpoints/statuses")
    },
    prometheus: {
      apiUrl: httpUrl(environment, "PROMETHEUS_API_URL", "http://prometheus:9090"),
      concurrency: integer(environment, "PROMETHEUS_CONCURRENCY", 4, 1, 8)
    },
    incidents: {
      databasePath: databasePath(environment),
      evaluationIntervalSeconds: integer(environment, "INCIDENT_EVALUATION_INTERVAL_SECONDS", 30, 15, 300)
    },
    authentication: {
      publicOrigin,
      redirectUri: `${publicOrigin}/auth/callback`,
      postLogoutRedirectUri: `${publicOrigin}/`,
      issuerUrl: httpsUrl(environment, "OIDC_ISSUER_URL"),
      clientId: printable(environment, "OIDC_CLIENT_ID", "", 256),
      clientSecretFile: persistentPath(environment, "OIDC_CLIENT_SECRET_FILE"),
      sessionDatabasePath: persistentPath(environment, "AUTH_SESSION_DATABASE_PATH"),
      sessionKeyringFile: persistentPath(environment, "AUTH_SESSION_KEYRING_FILE"),
      scopes: scopes(environment),
      roleClaim: claimPath(environment, "OIDC_ROLE_CLAIM", ""),
      displayNameClaim: claimPath(environment, "OIDC_DISPLAY_NAME_CLAIM", ""),
      groups: {
        viewer: printable(environment, "OIDC_VIEWER_GROUP", "", 256),
        operator: printable(environment, "OIDC_OPERATOR_GROUP", "", 256),
        administrator: printable(environment, "OIDC_ADMINISTRATOR_GROUP", "", 256)
      },
      idleSeconds,
      absoluteSeconds,
      transactionSeconds: integer(environment, "AUTH_TRANSACTION_SECONDS", 600, 60, 1800),
      auditRetentionDays: integer(environment, "AUTH_AUDIT_RETENTION_DAYS", 180, 1, 3650),
      auditMaxRecords: integer(environment, "AUTH_AUDIT_MAX_RECORDS", 100_000, 100, 1_000_000),
      clockToleranceSeconds: integer(environment, "OIDC_CLOCK_TOLERANCE_SECONDS", 60, 0, 120),
      timeoutSeconds: integer(environment, "OIDC_TIMEOUT_SECONDS", 5, 1, 30)
    },
    kubernetes: {
      apiUrl: httpUrl(environment, "KUBERNETES_API_URL", "https://host.docker.internal:6443"),
      tokenFile: nonempty(environment, "KUBERNETES_TOKEN_FILE", "/run/secrets/kubernetes_inventory_token"),
      toolUrl: nonempty(environment, "KUBERNETES_TOOL_URL", "#kubernetes-api-no-browser-link"),
      concurrency: integer(environment, "KUBERNETES_CONCURRENCY", 4, 1, 16)
    }
  };
}
