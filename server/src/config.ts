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

export interface RuntimeConfig {
  readonly port: number;
  readonly catalogPath: string;
  readonly requestTimeoutMs: number;
  readonly staleAfterSeconds: number;
  readonly gatusInternal: GatusRuntimeConfig;
  readonly gatusPublicPath: GatusRuntimeConfig;
  readonly kubernetes: KubernetesRuntimeConfig;
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
    kubernetes: {
      apiUrl: httpUrl(environment, "KUBERNETES_API_URL", "https://host.docker.internal:6443"),
      tokenFile: nonempty(environment, "KUBERNETES_TOKEN_FILE", "/run/secrets/kubernetes_inventory_token"),
      toolUrl: nonempty(environment, "KUBERNETES_TOOL_URL", "#kubernetes-api-no-browser-link"),
      concurrency: integer(environment, "KUBERNETES_CONCURRENCY", 4, 1, 16)
    }
  };
}
