import { readFile } from "node:fs/promises";

import { createInventoryHttpServer } from "./api";
import { loadCatalog } from "./catalog";
import { parseRuntimeConfig } from "./config";
import { GatusAdapter } from "./gatus";
import { FetchJsonHttpClient } from "./http";
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
  const server = createInventoryHttpServer(
    new InventoryAggregator(catalog, collectors),
    new PrometheusPerformanceReader({
      apiUrl: config.prometheus.apiUrl,
      catalog,
      client,
      concurrency: config.prometheus.concurrency
    }),
    await topologyReader(config, catalog, client)
  );
  server.listen(config.port, "0.0.0.0", () => {
    process.stdout.write(`Workspace Monitor inventory API listening on port ${config.port}\n`);
  });
  const shutdown = (): void => {
    server.close((error) => {
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
