import { readFile, stat } from "node:fs/promises";

import { createInventoryHttpServer } from "./api";
import { AccessAuthenticationService, parseAccessRoleMappingJson } from "./auth";
import { loadCatalog } from "./catalog";
import { parseRuntimeConfig } from "./config";
import { GatusAdapter } from "./gatus";
import { FetchJsonHttpClient } from "./http";
import { IncidentOperationsService, SqliteIncidentRepository } from "./incidents";
import { InventoryAggregator } from "./inventory";
import { KubernetesAdapter } from "./kubernetes";
import { KubernetesLogReader, UnavailableLogReader, type LogReader } from "./logs";
import { PrometheusPerformanceReader } from "./prometheus";
import { CloudflareAccessJwtVerifier } from "./cloudflare-access";
import { UnavailableSourceCollector, type SourceCollector } from "./source";
import { KubernetesTopologyReader, UnavailableTopologyReader, type TopologyReader } from "./topology";
import { DisabledSyntheticJourneyService } from "./synthetic";
import runtimePackage from "../package.json";

if (runtimePackage.type !== "commonjs") throw new Error("Inventory API runtime must use CommonJS modules");

async function readLockedRuntimeFile(path: string, label: string): Promise<string> {
  let metadata: Awaited<ReturnType<typeof stat>>;
  let value: string;
  try {
    [metadata, value] = await Promise.all([stat(path), readFile(path, "utf8")]);
  } catch {
    throw new Error(`${label} file is unavailable`);
  }
  const runtimeUid = process.getuid?.();
  if ((metadata.mode & 0o777) !== 0o400 || (runtimeUid !== undefined && metadata.uid !== runtimeUid)) {
    throw new Error(`${label} file must be owned by the runtime user with mode 0400`);
  }
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${label} file is empty`);
  return normalized;
}

async function kubernetesCollector(
  config: ReturnType<typeof parseRuntimeConfig>,
  client: FetchJsonHttpClient
): Promise<SourceCollector> {
  let token: string;
  try {
    token = (await readFile(config.kubernetes.tokenFile, "utf8")).trim();
  } catch {
    return new UnavailableSourceCollector(
      "kubernetes",
      config.kubernetes.toolUrl,
      "Kubernetes read-only credential file is unavailable"
    );
  }
  if (token === "") {
    return new UnavailableSourceCollector(
      "kubernetes",
      config.kubernetes.toolUrl,
      "Kubernetes read-only credential file is empty"
    );
  }
  return new KubernetesAdapter({
    ...config.kubernetes,
    bearerToken: token,
    staleAfterSeconds: config.staleAfterSeconds,
    client
  });
}

async function topologyReader(
  config: ReturnType<typeof parseRuntimeConfig>,
  catalog: Awaited<ReturnType<typeof loadCatalog>>,
  client: FetchJsonHttpClient
): Promise<TopologyReader> {
  let token: string;
  try {
    token = (await readFile(config.kubernetes.tokenFile, "utf8")).trim();
  } catch {
    return new UnavailableTopologyReader("Kubernetes read-only credential file is unavailable");
  }
  if (token === "") return new UnavailableTopologyReader("Kubernetes read-only credential file is empty");
  return new KubernetesTopologyReader({ ...config.kubernetes, bearerToken: token, catalog, client });
}

async function logReader(
  config: ReturnType<typeof parseRuntimeConfig>,
  catalog: Awaited<ReturnType<typeof loadCatalog>>,
  client: FetchJsonHttpClient
): Promise<LogReader> {
  let token: string;
  try {
    token = (await readFile(config.kubernetes.tokenFile, "utf8")).trim();
  } catch {
    return new UnavailableLogReader(catalog, "Kubernetes read-only credential file is unavailable");
  }
  if (token === "") return new UnavailableLogReader(catalog, "Kubernetes read-only credential file is empty");
  return new KubernetesLogReader({
    apiUrl: config.kubernetes.apiUrl,
    bearerToken: token,
    catalog,
    jsonClient: client,
    textClient: client,
    concurrency: Math.min(config.kubernetes.concurrency, 8)
  });
}

async function run(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const catalog = await loadCatalog(config.catalogPath);
  const client = new FetchJsonHttpClient({ timeoutMs: config.requestTimeoutMs });
  const collectors: SourceCollector[] = [
    new GatusAdapter("gatus-internal", config.gatusInternal.apiUrl, config.gatusInternal.toolUrl, client, config.staleAfterSeconds),
    new GatusAdapter("gatus-public-path", config.gatusPublicPath.apiUrl, config.gatusPublicPath.toolUrl, client, config.staleAfterSeconds),
    await kubernetesCollector(config, client)
  ];
  const inventory = new InventoryAggregator(catalog, collectors);
  const roleMapping = parseAccessRoleMappingJson(await readLockedRuntimeFile(config.authentication.roleMappingFile, "Cloudflare Access role mapping"));
  const authentication = new AccessAuthenticationService({
    config: {
      publicOrigin: config.authentication.publicOrigin,
      teamDomain: config.authentication.teamDomain,
      auditRetentionDays: config.authentication.auditRetentionDays,
      auditMaxRecords: config.authentication.auditMaxRecords
    },
    databasePath: config.authentication.auditDatabasePath,
    roleMapping,
    verifier: new CloudflareAccessJwtVerifier({
      teamDomain: config.authentication.teamDomain,
      audience: config.authentication.audience,
      clockToleranceSeconds: config.authentication.clockToleranceSeconds,
      maxTokenLifetimeSeconds: config.authentication.maxTokenLifetimeSeconds,
      timeoutSeconds: config.authentication.timeoutSeconds
    })
  });
  const incidentRepository = new SqliteIncidentRepository({
    databasePath: config.incidents.databasePath,
    catalog
  });
  const incidentService = new IncidentOperationsService({ repository: incidentRepository, inventoryReader: inventory });
  let evaluationActive = false;
  const evaluateIncidents = async (): Promise<void> => {
    if (evaluationActive) return;
    evaluationActive = true;
    try {
      await incidentService.evaluate();
    } finally {
      evaluationActive = false;
    }
  };
  await evaluateIncidents();
  const evaluationTimer = setInterval(() => { void evaluateIncidents(); }, config.incidents.evaluationIntervalSeconds * 1000);
  const server = createInventoryHttpServer(
    authentication,
    inventory,
    new PrometheusPerformanceReader({
      apiUrl: config.prometheus.apiUrl,
      catalog,
      client,
      concurrency: config.prometheus.concurrency
    }),
    await topologyReader(config, catalog, client),
    incidentService,
    await logReader(config, catalog, client),
    new DisabledSyntheticJourneyService()
  );
  server.listen(config.port, "0.0.0.0", () => {
    process.stdout.write(`Workspace Monitor operations API listening on port ${config.port}\n`);
  });
  const shutdown = (): void => {
    clearInterval(evaluationTimer);
    server.close((error) => {
      try {
        incidentRepository.close();
        authentication.close();
      } catch (cause: unknown) {
        process.stderr.write(`Incident database shutdown failed: ${cause instanceof Error ? cause.message : "unknown error"}\n`);
        process.exitCode = 1;
      }
      if (error) {
        process.stderr.write(`Operations API shutdown failed: ${error.message}\n`);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void run().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Unknown startup error";
  process.stderr.write(`Operations API failed to start: ${message}\n`);
  process.exitCode = 1;
});
