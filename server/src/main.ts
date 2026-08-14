import { readFile } from "node:fs/promises";

import { createInventoryHttpServer } from "./api";
import { loadCatalog } from "./catalog";
import { parseRuntimeConfig } from "./config";
import { GatusAdapter } from "./gatus";
import { FetchJsonHttpClient } from "./http";
import { IncidentOperationsService, SqliteIncidentRepository } from "./incidents";
import { InventoryAggregator } from "./inventory";
import { KubernetesAdapter } from "./kubernetes";
import { PrometheusPerformanceReader } from "./prometheus";
import { UnavailableSourceCollector, type SourceCollector } from "./source";
import { KubernetesTopologyReader, UnavailableTopologyReader, type TopologyReader } from "./topology";
import runtimePackage from "../package.json";

if (runtimePackage.type !== "commonjs") throw new Error("Inventory API runtime must use CommonJS modules");

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
  const incidentRepository = new SqliteIncidentRepository({
    databasePath: config.incidents.databasePath,
    catalog,
    operatorId: config.incidents.operatorId
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
    inventory,
    new PrometheusPerformanceReader({
      apiUrl: config.prometheus.apiUrl,
      catalog,
      client,
      concurrency: config.prometheus.concurrency
    }),
    await topologyReader(config, catalog, client),
    incidentService
  );
  server.listen(config.port, "0.0.0.0", () => {
    process.stdout.write(`Workspace Monitor inventory API listening on port ${config.port}\n`);
  });
  const shutdown = (): void => {
    clearInterval(evaluationTimer);
    server.close((error) => {
      try {
        incidentRepository.close();
      } catch (cause: unknown) {
        process.stderr.write(`Incident database shutdown failed: ${cause instanceof Error ? cause.message : "unknown error"}\n`);
        process.exitCode = 1;
      }
      if (error) {
        process.stderr.write(`Inventory API shutdown failed: ${error.message}\n`);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void run().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Unknown startup error";
  process.stderr.write(`Inventory API failed to start: ${message}\n`);
  process.exitCode = 1;
});
