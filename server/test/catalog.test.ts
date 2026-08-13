import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { loadCatalog, parseCatalog } from "../src/catalog";

describe("inventory catalog adapter", () => {
  it("loads all repository services and their workload mappings", async () => {
    const raw = JSON.parse(await readFile(resolve("catalog/services.json"), "utf8")) as unknown;
    const catalog = parseCatalog(raw);

    expect(catalog.services.map((service) => service.id)).toEqual([
      "cpq-demo",
      "cpq-test",
      "oauth",
      "mailpit",
      "erpnet"
    ]);
    expect(catalog.services.find((service) => service.id === "cpq-demo")?.workloads).toContainEqual({
      kind: "Deployment",
      namespace: "default",
      name: "application"
    });
  });

  it("rejects malformed and credential-bearing catalog records", () => {
    expect(() => parseCatalog({ catalogVersion: 1, services: "invalid" })).toThrow("services");
    expect(() => parseCatalog({
      catalogVersion: 1,
      services: [{
        id: "unsafe",
        displayName: "Unsafe",
        kind: "application",
        environment: "demo",
        owner: "Owner",
        criticality: "high",
        probes: [{
          id: "unsafe-probe",
          displayName: "Unsafe probe",
          group: "unsafe",
          url: "https://admin:secret@example.test/health",
          vantagePoints: ["internal"],
          intervalSeconds: 30,
          timeoutSeconds: 5,
          expectedStatus: 200
        }],
        workloads: []
      }]
    })).toThrow("credentials");
  });

  it("covers optional probe/workload fields and strict scalar validation", () => {
    const raw = {
      catalogVersion: 1,
      services: [{
        id: "service", displayName: "Service", kind: "application", environment: "demo", owner: "Owner", criticality: "high",
        probes: [{
          id: "probe", displayName: "Probe", group: "group", url: "https://example.test/health?safe=yes",
          vantagePoints: ["internal"], intervalSeconds: 30, timeoutSeconds: 5, expectedStatus: 200,
          bodyCondition: "[BODY].status == UP", certificateMinimumHours: 168
        }]
      }]
    };
    expect(parseCatalog(raw).services[0]?.workloads).toEqual([]);
    expect(() => parseCatalog(null)).toThrow("object");
    expect(() => parseCatalog({ catalogVersion: 2, services: [] })).toThrow("catalogVersion");
    expect(() => parseCatalog({ catalogVersion: 1, services: [] })).toThrow("empty");
    expect(() => parseCatalog({ catalogVersion: 1, services: [{ ...raw.services[0], displayName: "" }] })).toThrow("non-empty");
    expect(() => parseCatalog({ catalogVersion: 1, services: [{ ...raw.services[0], kind: "database" }] })).toThrow("unsupported");
    expect(() => parseCatalog({ catalogVersion: 1, services: [{ ...raw.services[0], probes: [] }] })).toThrow("probes");
    expect(() => parseCatalog({ catalogVersion: 1, services: [{ ...raw.services[0], probes: [{ ...raw.services[0].probes[0], vantagePoints: [] }] }] })).toThrow("vantagePoints");
    expect(() => parseCatalog({ catalogVersion: 1, services: [{ ...raw.services[0], probes: [{ ...raw.services[0].probes[0], intervalSeconds: 1.5 }] }] })).toThrow("integer");
    expect(() => parseCatalog({ catalogVersion: 1, services: [{ ...raw.services[0], probes: [{ ...raw.services[0].probes[0], url: "ftp://example.test/x" }] }] })).toThrow("HTTP");
    expect(() => parseCatalog({ catalogVersion: 1, services: [{ ...raw.services[0], probes: [{ ...raw.services[0].probes[0], url: "https://example.test/x?api_key=secret" }] }] })).toThrow("sensitive");
    expect(() => parseCatalog({ catalogVersion: 1, services: [raw.services[0], raw.services[0]] })).toThrow("unique");
  });

  it("maps catalog file and JSON failures explicitly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-monitor-catalog-"));
    const invalid = join(directory, "invalid.json");
    await writeFile(invalid, "{not-json", "utf8");

    await expect(loadCatalog(resolve("catalog/services.json"))).resolves.toMatchObject({ catalogVersion: 1 });
    await expect(loadCatalog(join(directory, "missing.json"))).rejects.toThrow("cannot read");
    await expect(loadCatalog(invalid)).rejects.toThrow("invalid JSON");
  });
});
