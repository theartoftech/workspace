import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { InventorySnapshot, ServiceInventory } from "../../shared/inventory";
import type { SessionUser } from "../../shared/auth";
import type { DeclareIncidentCommand, IncidentDetailResponse, IncidentListResponse, IncidentTransitionCommand } from "../../shared/incidents";
import { IncidentRequestError, IncidentOperationsService, SqliteIncidentRepository } from "../src/incidents";
import { catalogFixture } from "./fixtures";

const temporaryDirectories: string[] = [];
const operator: SessionUser = { id: "access:operator", displayName: "Lab Operator", role: "operator" };

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "workspace-monitor-incidents-"));
  temporaryDirectories.push(directory);
  return join(directory, "incidents.sqlite");
}

function serviceInventory(state: ServiceInventory["state"]): ServiceInventory {
  return {
    id: "cpq-demo",
    name: "CPQ Demo",
    kind: "application",
    environment: "demo",
    owner: "Development Lab",
    criticality: "critical",
    state,
    lastCheckedAt: "2026-08-14T14:00:00.000Z",
    version: "v4.14.0",
    endpoint: "https://cpq.example.test/ready",
    reachability: { internal: state, external: state, comparison: "aligned" },
    probes: [{
      id: "cpq-demo-ready-internal",
      name: "CPQ Demo readiness",
      endpoint: "https://cpq.example.test/ready",
      vantagePoint: "internal",
      state,
      checkedAt: "2026-08-14T14:00:00.000Z",
      latencyMs: 18,
      statusCode: state === "failing" ? 503 : 200,
      source: "gatus-internal",
      sourceToolUrl: "/tools/gatus-internal/"
    }],
    workloads: [],
    sourceLinks: []
  };
}

function inventory(state: ServiceInventory["state"]): InventorySnapshot {
  const service = serviceInventory(state);
  return {
    apiVersion: 1,
    mode: "live",
    assembledAt: "2026-08-14T14:00:00.000Z",
    lastObservedAt: "2026-08-14T14:00:00.000Z",
    environment: "all",
    summary: {
      total: 1,
      healthy: state === "healthy" ? 1 : 0,
      degraded: state === "degraded" ? 1 : 0,
      failing: state === "failing" ? 1 : 0,
      unknown: state === "unknown" ? 1 : 0,
      paused: state === "paused" ? 1 : 0,
      stale: state === "stale" ? 1 : 0
    },
    services: [service],
    sources: [{ source: "gatus-internal", availability: "available", observedAt: service.lastCheckedAt, toolUrl: "/tools/gatus-internal/", message: null }]
  };
}

interface Harness {
  readonly repository: SqliteIncidentRepository;
  readonly service: {
    evaluate(): Promise<void>;
    list(environment: string, status: string): Promise<IncidentListResponse>;
    getDetail(id: string): Promise<IncidentDetailResponse>;
    declare(command: DeclareIncidentCommand): Promise<IncidentDetailResponse>;
    transition(id: string, command: IncidentTransitionCommand): Promise<IncidentDetailResponse>;
  };
  setInventory(snapshot: InventorySnapshot): void;
  failInventory(): void;
  setNow(value: string): void;
  inventoryCalls(): number;
}

function harness(path = databasePath()): Harness {
  let currentInventory = inventory("failing");
  let inventoryError: Error | null = null;
  let inventoryCalls = 0;
  let now = new Date("2026-08-14T14:00:00.000Z");
  const repository = new SqliteIncidentRepository({
    databasePath: path,
    catalog: catalogFixture,
    clock: () => now
  });
  const operations = new IncidentOperationsService({
    repository,
    inventoryReader: {
      async getInventory(): Promise<InventorySnapshot> {
        inventoryCalls += 1;
        if (inventoryError !== null) throw inventoryError;
        return currentInventory;
      }
    },
    clock: () => now
  });
  return {
    repository,
    service: {
      evaluate: () => operations.evaluate(),
      list: (environment, status) => operations.list(environment, status, operator),
      getDetail: (id) => operations.getDetail(id, operator),
      declare: (command) => operations.declare(command, operator),
      transition: (id, command) => operations.transition(id, command, operator)
    },
    setInventory(snapshot) { currentInventory = snapshot; inventoryError = null; },
    failInventory() { inventoryError = new Error("authorization=Bearer must-not-leak"); },
    setNow(value) { now = new Date(value); },
    inventoryCalls() { return inventoryCalls; }
  };
}

describe("persistent incident operations", () => {
  it("groups repeated alert evidence and survives repository restart", async () => {
    const path = databasePath();
    const first = harness(path);
    await first.service.evaluate();
    const initial = await first.service.list("all", "active");
    const incident = initial.incidents[0];
    expect(incident).toMatchObject({ severity: "P1", status: "active", serviceId: "cpq-demo", alertActive: true, version: 1 });
    expect(incident?.evidence).toEqual([expect.objectContaining({ source: "gatus-internal", occurrences: 1 })]);

    await first.service.evaluate();
    const repeated = await first.service.list("all", "active");
    expect(repeated.incidents).toHaveLength(1);
    expect(repeated.incidents[0]?.id).toBe(incident?.id);
    expect(repeated.incidents[0]?.evidence[0]?.occurrences).toBe(2);
    const id = incident?.id ?? "";
    first.repository.close();

    const reopened = harness(path);
    const detail = await reopened.service.getDetail(id);
    expect(detail.incident.id).toBe(id);
    expect(detail.audit.map((event) => event.action)).toEqual(["created"]);
    reopened.repository.close();
  });

  it("persists declared, acknowledged, and resolved transitions with exactly one audit event each", async () => {
    const current = harness();
    const declared = await current.service.declare({
      serviceId: "cpq-demo",
      title: "Checkout failure investigation",
      severity: "P2",
      reason: "Operator confirmed customer impact"
    });
    expect(declared.incident).toMatchObject({ status: "active", declaredBy: "Lab Operator", version: 1 });

    const acknowledged = await current.service.transition(declared.incident.id, {
      action: "acknowledge",
      expectedVersion: 1,
      reason: "Taking incident command"
    });
    expect(acknowledged.incident).toMatchObject({ acknowledgedBy: "Lab Operator", version: 2 });

    const resolved = await current.service.transition(declared.incident.id, {
      action: "resolve",
      expectedVersion: 2,
      reason: "Service health and synthetic checks recovered"
    });
    expect(resolved.incident).toMatchObject({ status: "resolved", version: 3 });
    expect(resolved.audit.map((event) => event.action)).toEqual(["created", "acknowledged", "resolved"]);
    expect(resolved.audit.map((event) => event.actor)).toEqual([
      "Lab Operator (access:operator)", "Lab Operator (access:operator)", "Lab Operator (access:operator)"
    ]);
    current.repository.close();
  });

  it("rejects stale, repeated, invalid, and partially applicable transitions without mutation", async () => {
    const current = harness();
    const declared = await current.service.declare({ serviceId: "cpq-demo", title: "Test incident", severity: "P3", reason: "Test declaration" });
    await current.service.transition(declared.incident.id, { action: "acknowledge", expectedVersion: 1, reason: "Owned" });

    await expect(current.service.transition(declared.incident.id, { action: "resolve", expectedVersion: 1, reason: "Stale browser" }))
      .rejects.toMatchObject({ code: "incident_version_conflict", status: 409 });
    await expect(current.service.transition(declared.incident.id, { action: "acknowledge", expectedVersion: 2, reason: "Duplicate" }))
      .rejects.toMatchObject({ code: "invalid_incident_transition", status: 409 });

    const detail = await current.service.getDetail(declared.incident.id);
    expect(detail.incident).toMatchObject({ status: "active", version: 2 });
    expect(detail.audit).toHaveLength(2);
    current.repository.close();
  });

  it("expires bounded silences after downtime and records the lifecycle", async () => {
    const current = harness();
    const declared = await current.service.declare({ serviceId: "cpq-demo", title: "Maintenance alert", severity: "P3", reason: "Maintenance started" });
    const silenced = await current.service.transition(declared.incident.id, {
      action: "silence",
      expectedVersion: 1,
      reason: "Approved maintenance window",
      durationMinutes: 15
    });
    expect(silenced.incident.silence).toMatchObject({ active: true, createdBy: "Lab Operator" });
    current.setNow("2026-08-14T14:16:00.000Z");

    const readOnly = await current.service.getDetail(declared.incident.id);
    expect(readOnly.incident).toMatchObject({ version: 2, silence: expect.objectContaining({ active: false }) });
    expect(readOnly.audit.map((event) => event.action)).toEqual(["created", "silenced"]);
    await current.service.evaluate();
    const expired = await current.service.getDetail(declared.incident.id);
    expect(expired.incident).toMatchObject({ version: 3, silence: expect.objectContaining({ active: false }) });
    expect(expired.audit.map((event) => event.action)).toEqual(["created", "silenced", "silence_expired"]);
    current.repository.close();
  });

  it("does not run clock lifecycle mutations as a side effect of a rejected transition", async () => {
    const current = harness();
    const declared = await current.service.declare({ serviceId: "cpq-demo", title: "Expired maintenance", severity: "P3", reason: "Maintenance started" });
    await current.service.transition(declared.incident.id, { action: "silence", expectedVersion: 1, reason: "Bounded maintenance", durationMinutes: 15 });
    current.setNow("2026-08-14T14:16:00.000Z");

    await expect(current.service.transition(declared.incident.id, { action: "resolve", expectedVersion: 1, reason: "Stale operator" }))
      .rejects.toMatchObject({ code: "incident_version_conflict", status: 409 });
    const unchanged = await current.service.getDetail(declared.incident.id);
    expect(unchanged.incident).toMatchObject({ version: 2, status: "active", silence: expect.objectContaining({ active: false }) });
    expect(unchanged.audit.map((event) => event.action)).toEqual(["created", "silenced"]);
    current.repository.close();
  });

  it("retains valid incidents when alert evaluation is unavailable and never leaks its cause", async () => {
    const current = harness();
    await current.service.evaluate();
    const active = await current.service.list("all", "active");
    expect(active.incidents).toHaveLength(1);
    current.failInventory();
    await current.service.evaluate();
    const partial = await current.service.list("all", "active");
    expect(partial.mode).toBe("partial");
    expect(partial.alertSource).toEqual(expect.objectContaining({ availability: "unavailable", message: "Live alert evaluation is unavailable." }));
    expect(JSON.stringify(partial)).not.toContain("must-not-leak");
    expect(partial.incidents).toHaveLength(1);
    current.repository.close();
  });

  it("records recovery without falsely resolving the operator incident", async () => {
    const current = harness();
    await current.service.evaluate();
    const active = await current.service.list("all", "active");
    const id = active.incidents[0]?.id ?? "";
    current.setInventory(inventory("healthy"));
    current.setNow("2026-08-14T14:02:00.000Z");

    await current.service.evaluate();
    const recovered = await current.service.list("all", "active");
    expect(recovered.incidents[0]).toMatchObject({ id, status: "active", alertActive: false, version: 2 });
    const detail: IncidentDetailResponse = await current.service.getDetail(id);
    expect(detail.audit.map((event) => event.action)).toEqual(["created", "condition_recovered"]);
    current.repository.close();
  });

  it("records alert recurrence, operator resolution, and evaluator reopening", async () => {
    const current = harness();
    await current.service.evaluate();
    const id = (await current.service.list("all", "active")).incidents[0]?.id ?? "";

    current.setInventory(inventory("healthy"));
    current.setNow("2026-08-14T14:01:00.000Z");
    await current.service.evaluate();
    current.setInventory(inventory("failing"));
    current.setNow("2026-08-14T14:02:00.000Z");
    await current.service.evaluate();
    const recurred = await current.service.getDetail(id);
    expect(recurred.incident).toMatchObject({ status: "active", alertActive: true, version: 3 });

    const resolved = await current.service.transition(id, { action: "resolve", expectedVersion: 3, reason: "Operator confirmed recovery" });
    expect(resolved.incident).toMatchObject({ status: "resolved", version: 4 });
    current.setNow("2026-08-14T14:03:00.000Z");
    await current.service.evaluate();
    const reopened = await current.service.getDetail(id);
    expect(reopened.incident).toMatchObject({ status: "active", version: 5 });
    expect(reopened.audit.map((event) => event.action)).toEqual([
      "created", "condition_recovered", "alert_recurred", "resolved", "reopened"
    ]);
    current.repository.close();
  });

  it("updates alert severity and preserves workload or aggregate evidence", async () => {
    const workloadHarness = harness();
    const degraded = serviceInventory("degraded");
    workloadHarness.setInventory({
      ...inventory("degraded"),
      services: [{
        ...degraded,
        probes: degraded.probes.map((probe) => ({ ...probe, state: "healthy" as const })),
        workloads: [{ kind: "Deployment", namespace: "default", name: "application", state: "degraded", checkedAt: degraded.lastCheckedAt, ready: 1, desired: 2, version: "v4.14.0", sourceToolUrl: "/infrastructure" }]
      }]
    });
    await workloadHarness.service.evaluate();
    const workloadIncident = (await workloadHarness.service.list("all", "active")).incidents[0];
    expect(workloadIncident).toMatchObject({ severity: "P2", evidence: [expect.objectContaining({ source: "kubernetes" })] });

    workloadHarness.setInventory(inventory("failing"));
    await workloadHarness.service.evaluate();
    const updated = await workloadHarness.service.getDetail(workloadIncident?.id ?? "");
    expect(updated.incident).toMatchObject({ severity: "P1", version: 2 });
    expect(updated.audit.map((event) => event.action)).toEqual(["created", "alert_updated"]);
    workloadHarness.repository.close();

    const aggregateHarness = harness();
    const unknown = serviceInventory("unknown");
    aggregateHarness.setInventory({
      ...inventory("unknown"),
      services: [{
        ...unknown,
        probes: unknown.probes.map((probe) => ({ ...probe, state: "healthy" as const }))
      }]
    });
    await aggregateHarness.service.evaluate();
    expect((await aggregateHarness.service.list("all", "active")).incidents[0]).toMatchObject({
      severity: "P3",
      evidence: [expect.objectContaining({ source: "inventory-health-evaluator", state: "unknown" })]
    });
    aggregateHarness.repository.close();
  });

  it("keeps incident GET operations read-only and evaluation explicit", async () => {
    const current = harness();
    const before = await current.service.list("all", "active");
    expect(before.incidents).toHaveLength(0);
    expect(current.inventoryCalls()).toBe(0);

    await current.service.evaluate();
    expect(current.inventoryCalls()).toBe(1);
    expect((await current.service.list("all", "active")).incidents).toHaveLength(1);
    expect(current.inventoryCalls()).toBe(1);
    current.repository.close();
  });

  it("caps incident lists and discloses truncation", async () => {
    const current = harness();
    for (let index = 0; index < 101; index += 1) {
      await current.service.declare({ serviceId: "cpq-demo", title: `Bounded incident ${index}`, severity: "P3", reason: "Exercise list bounds" });
    }
    const response = await current.service.list("all", "active");
    expect(response.incidents).toHaveLength(100);
    expect(response.truncated).toBe(true);
    current.repository.close();
  });

  it("fails explicitly for unsupported storage schemas and invalid commands", async () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE schema_metadata (version INTEGER NOT NULL); INSERT INTO schema_metadata(version) VALUES (99);");
    database.close();
    expect(() => harness(path)).toThrow("Unsupported incident database schema version: 99");

    const current = harness();
    await expect(current.service.declare({ serviceId: "unknown", title: "Unknown", severity: "P2", reason: "No catalog mapping" }))
      .rejects.toBeInstanceOf(IncidentRequestError);
    await expect(current.service.declare({ serviceId: "cpq-demo", title: " ", severity: "P2", reason: "No title" }))
      .rejects.toMatchObject({ code: "invalid_incident_command", status: 400 });
    await expect(current.service.declare({ serviceId: "cpq-demo", title: "Invalid severity", severity: "P4", reason: "No such severity" } as unknown as DeclareIncidentCommand))
      .rejects.toMatchObject({ code: "invalid_incident_command", status: 400 });
    await expect(current.service.declare({ serviceId: "cpq-demo", title: 7, severity: "P2", reason: "Wrong JSON type" } as unknown as DeclareIncidentCommand))
      .rejects.toMatchObject({ code: "invalid_incident_command", status: 400 });
    await expect(current.service.declare({ serviceId: "cpq-demo", title: "Control character", severity: "P2", reason: "bad\nreason" }))
      .rejects.toMatchObject({ code: "invalid_incident_command", status: 400 });
    current.repository.close();
  });

  it("rejects invalid transition shapes and state conflicts atomically", async () => {
    const current = harness();
    await current.service.evaluate();
    const id = (await current.service.list("all", "active")).incidents[0]?.id ?? "";
    const invalidCommands: readonly IncidentTransitionCommand[] = [
      { action: "delete", expectedVersion: 1, reason: "Unsupported action" } as unknown as IncidentTransitionCommand,
      { action: "acknowledge", expectedVersion: 0, reason: "Invalid version" },
      { action: "acknowledge", expectedVersion: Number.MAX_SAFE_INTEGER + 1, reason: "Unsafe version" },
      { action: "silence", expectedVersion: 1, reason: "Missing duration" },
      { action: "silence", expectedVersion: 1, reason: "Unsupported duration", durationMinutes: 30 as 15 },
      { action: "acknowledge", expectedVersion: 1, reason: "Misplaced duration", durationMinutes: 15 }
    ];
    for (const command of invalidCommands) {
      await expect(current.service.transition(id, command)).rejects.toMatchObject({ code: "invalid_incident_command", status: 400 });
    }

    const declared = await current.service.transition(id, { action: "declare", expectedVersion: 1, reason: "Declare operator response" });
    expect(declared.incident).toMatchObject({ declaredBy: "Lab Operator", version: 2 });
    await expect(current.service.transition(id, { action: "declare", expectedVersion: 2, reason: "Duplicate declaration" }))
      .rejects.toMatchObject({ code: "invalid_incident_transition", status: 409 });

    const silenced = await current.service.transition(id, { action: "silence", expectedVersion: 2, reason: "Maintenance window", durationMinutes: 15 });
    await expect(current.service.transition(id, { action: "silence", expectedVersion: 3, reason: "Duplicate silence", durationMinutes: 15 }))
      .rejects.toMatchObject({ code: "invalid_incident_transition", status: 409 });
    const resolved = await current.service.transition(id, { action: "resolve", expectedVersion: silenced.incident.version, reason: "Condition cleared" });
    await expect(current.service.transition(id, { action: "acknowledge", expectedVersion: resolved.incident.version, reason: "Too late" }))
      .rejects.toMatchObject({ code: "invalid_incident_transition", status: 409 });

    await expect(current.service.getDetail("incident-1")).rejects.toMatchObject({ code: "incident_not_found", status: 404 });
    await expect(current.service.getDetail("INC-999999")).rejects.toMatchObject({ code: "incident_not_found", status: 404 });
    expect((await current.service.list("demo", "resolved")).incidents).toHaveLength(1);
    expect((await current.service.list("all", "all")).summary.resolved).toBe(1);
    await expect(current.service.list("production", "active")).rejects.toMatchObject({ code: "invalid_environment", status: 400 });
    await expect(current.service.list("shared", "active")).rejects.toMatchObject({ code: "invalid_environment", status: 400 });
    await expect(current.service.list("all", "deleted")).rejects.toMatchObject({ code: "invalid_incident_filter", status: 400 });
    current.repository.close();
  });

  it("fails explicitly for empty metadata, corrupt stored runbooks, and invalid clocks", async () => {
    const emptyPath = databasePath();
    const empty = new DatabaseSync(emptyPath);
    empty.exec("CREATE TABLE schema_metadata (version INTEGER NOT NULL);");
    empty.close();
    expect(() => harness(emptyPath)).toThrow("Incident database schema metadata is empty");

    const corruptPath = databasePath();
    const first = harness(corruptPath);
    const declared = await first.service.declare({ serviceId: "cpq-demo", title: "Stored data validation", severity: "P3", reason: "Create persisted incident" });
    first.repository.close();
    const database = new DatabaseSync(corruptPath);
    database.prepare("UPDATE incidents SET runbook_json = ? WHERE id = 1").run("not-json");
    database.close();
    const corrupt = harness(corruptPath);
    await expect(corrupt.service.getDetail(declared.incident.id)).rejects.toThrow("Stored incident runbook is malformed");
    corrupt.repository.close();

    const invalidClockRepository = new SqliteIncidentRepository({
      databasePath: databasePath(), catalog: catalogFixture, clock: () => new Date(Number.NaN)
    });
    expect(() => invalidClockRepository.list("all", "all")).toThrow("Incident clock returned an invalid date");
    invalidClockRepository.close();
  });
});
