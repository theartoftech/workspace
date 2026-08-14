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
  readonly operatorId: string;
  readonly evaluationIntervalSeconds: number;
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

export function parseRuntimeConfig(environment: Environment): RuntimeConfig {
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
      operatorId: printable(environment, "INCIDENT_OPERATOR_ID", "lab-operator", 100),
      evaluationIntervalSeconds: integer(environment, "INCIDENT_EVALUATION_INTERVAL_SECONDS", 30, 15, 300)
    },
    kubernetes: {
      apiUrl: httpUrl(environment, "KUBERNETES_API_URL", "https://host.docker.internal:6443"),
      tokenFile: nonempty(environment, "KUBERNETES_TOKEN_FILE", "/run/secrets/kubernetes_inventory_token"),
      toolUrl: nonempty(environment, "KUBERNETES_TOOL_URL", "#kubernetes-api-no-browser-link"),
      concurrency: integer(environment, "KUBERNETES_CONCURRENCY", 4, 1, 16)
    }
  };
}
