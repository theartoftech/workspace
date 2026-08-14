import { readFile } from "node:fs/promises";

import type { ServiceEnvironment, VantagePoint } from "../../shared/inventory";

export interface CatalogProbeDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly group: string;
  readonly url: string;
  readonly vantagePoints: readonly VantagePoint[];
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly expectedStatus: number;
  readonly bodyCondition?: string;
  readonly certificateMinimumHours?: number;
}

export interface CatalogWorkloadDefinition {
  readonly kind: "Deployment" | "Pod";
  readonly namespace: string;
  readonly name: string;
}

export interface CatalogServiceDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "application" | "identity" | "mail" | "erp";
  readonly environment: ServiceEnvironment;
  readonly owner: string;
  readonly criticality: "critical" | "high" | "medium";
  readonly probes: readonly CatalogProbeDefinition[];
  readonly workloads: readonly CatalogWorkloadDefinition[];
}

export interface CatalogDefinition {
  readonly catalogVersion: 1;
  readonly services: readonly CatalogServiceDefinition[];
}

export class CatalogAdapterError extends Error {
  constructor(message: string) {
    super(`Catalog is malformed: ${message}`);
    this.name = "CatalogAdapterError";
  }
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogAdapterError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new CatalogAdapterError(`${context} must be an array`);
  return value;
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new CatalogAdapterError(`${context} must be a non-empty string`);
  return value.trim();
}

function integer(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new CatalogAdapterError(`${context} must be an integer`);
  return value;
}

function oneOf<const Value extends string>(value: unknown, values: readonly Value[], context: string): Value {
  const parsed = text(value, context);
  if (!values.includes(parsed as Value)) throw new CatalogAdapterError(`${context} has unsupported value '${parsed}'`);
  return parsed as Value;
}

function parseUrl(value: unknown, context: string): string {
  const parsed = new URL(text(value, context));
  if (!(["http:", "https:"] as const).includes(parsed.protocol as "http:" | "https:")) {
    throw new CatalogAdapterError(`${context} must be HTTP(S)`);
  }
  if (parsed.username !== "" || parsed.password !== "") throw new CatalogAdapterError(`${context} must not contain credentials`);
  for (const key of parsed.searchParams.keys()) {
    if (["access_token", "api_key", "apikey", "password", "secret", "token"].includes(key.toLowerCase())) {
      throw new CatalogAdapterError(`${context} must not contain sensitive query values`);
    }
  }
  return parsed.toString();
}

function parseProbe(value: unknown, serviceIndex: number, probeIndex: number): CatalogProbeDefinition {
  const context = `services[${serviceIndex}].probes[${probeIndex}]`;
  const raw = record(value, context);
  const vantagePoints = array(raw.vantagePoints, `${context}.vantagePoints`).map((item) => oneOf(item, ["internal", "external"] as const, `${context}.vantagePoints`));
  if (vantagePoints.length === 0) throw new CatalogAdapterError(`${context}.vantagePoints cannot be empty`);
  const optionalBody = raw.bodyCondition === undefined ? {} : { bodyCondition: text(raw.bodyCondition, `${context}.bodyCondition`) };
  const optionalCertificate = raw.certificateMinimumHours === undefined ? {} : { certificateMinimumHours: integer(raw.certificateMinimumHours, `${context}.certificateMinimumHours`) };
  return {
    id: text(raw.id, `${context}.id`),
    displayName: text(raw.displayName, `${context}.displayName`),
    group: text(raw.group, `${context}.group`),
    url: parseUrl(raw.url, `${context}.url`),
    vantagePoints,
    intervalSeconds: integer(raw.intervalSeconds, `${context}.intervalSeconds`),
    timeoutSeconds: integer(raw.timeoutSeconds, `${context}.timeoutSeconds`),
    expectedStatus: integer(raw.expectedStatus, `${context}.expectedStatus`),
    ...optionalBody,
    ...optionalCertificate
  };
}

function parseWorkload(value: unknown, serviceIndex: number, workloadIndex: number): CatalogWorkloadDefinition {
  const context = `services[${serviceIndex}].workloads[${workloadIndex}]`;
  const raw = record(value, context);
  return {
    kind: oneOf(raw.kind, ["Deployment", "Pod"] as const, `${context}.kind`),
    namespace: text(raw.namespace, `${context}.namespace`),
    name: text(raw.name, `${context}.name`)
  };
}

function parseService(value: unknown, index: number): CatalogServiceDefinition {
  const context = `services[${index}]`;
  const raw = record(value, context);
  const probes = array(raw.probes, `${context}.probes`).map((probe, probeIndex) => parseProbe(probe, index, probeIndex));
  if (probes.length === 0) throw new CatalogAdapterError(`${context}.probes cannot be empty`);
  const workloads = raw.workloads === undefined
    ? []
    : array(raw.workloads, `${context}.workloads`).map((workload, workloadIndex) => parseWorkload(workload, index, workloadIndex));
  return {
    id: text(raw.id, `${context}.id`),
    displayName: text(raw.displayName, `${context}.displayName`),
    kind: oneOf(raw.kind, ["application", "identity", "mail", "erp"] as const, `${context}.kind`),
    environment: oneOf(raw.environment, ["demo", "test", "portfolio", "shared"] as const, `${context}.environment`),
    owner: text(raw.owner, `${context}.owner`),
    criticality: oneOf(raw.criticality, ["critical", "high", "medium"] as const, `${context}.criticality`),
    probes,
    workloads
  };
}

export function parseCatalog(value: unknown): CatalogDefinition {
  const raw = record(value, "catalog");
  if (raw.catalogVersion !== 1) throw new CatalogAdapterError("catalogVersion must be 1");
  const services = array(raw.services, "services").map(parseService);
  if (services.length === 0) throw new CatalogAdapterError("services cannot be empty");
  if (new Set(services.map((service) => service.id)).size !== services.length) throw new CatalogAdapterError("service ids must be unique");
  return { catalogVersion: 1, services };
}

export async function loadCatalog(path: string): Promise<CatalogDefinition> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause: unknown) {
    throw new CatalogAdapterError(`cannot read ${path}: ${cause instanceof Error ? cause.message : "unknown error"}`);
  }
  try {
    return parseCatalog(JSON.parse(source) as unknown);
  } catch (cause: unknown) {
    if (cause instanceof CatalogAdapterError) throw cause;
    throw new CatalogAdapterError(`invalid JSON in ${path}`);
  }
}
