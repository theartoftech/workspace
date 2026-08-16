import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { InventorySnapshot, ServiceInventory } from "../../shared/inventory";
import type { SessionUser } from "../../shared/auth";
import type {
  DeclareIncidentCommand,
  IncidentAlertSourceStatus,
  IncidentAuditAction,
  IncidentAuditEvent,
  IncidentDetailResponse,
  IncidentEnvironment,
  IncidentEvidence,
  IncidentListResponse,
  IncidentNotificationStatus,
  IncidentRunbook,
  IncidentSeverity,
  IncidentSilence,
  IncidentStatus,
  IncidentStatusFilter,
  IncidentSummary,
  IncidentTransitionCommand
} from "../../shared/incidents";
import type { CatalogDefinition, CatalogServiceDefinition } from "./catalog";

const SCHEMA_VERSION = 1;
const MAX_INCIDENTS = 100;
const MAX_AUDIT_EVENTS = 100;
const environmentValues = new Set(["all", "demo", "test", "portfolio"]);
const statusFilterValues = new Set<IncidentStatusFilter>(["active", "resolved", "all"]);
const severityValues = new Set<IncidentSeverity>(["P1", "P2", "P3"]);
const transitionValues = new Set(["acknowledge", "declare", "silence", "resolve"]);
const silenceDurations = new Set([15, 60, 360, 1440]);
const notification: IncidentNotificationStatus = {
  state: "unconfigured",
  message: "Notification delivery is not configured; no destination or credential workflow has been approved."
};

interface IncidentInventoryReader {
  getInventory(environment: string): Promise<InventorySnapshot>;
}

export class IncidentRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409,
    message: string
  ) {
    super(message);
    this.name = "IncidentRequestError";
  }
}

interface IncidentRepositoryOptions {
  readonly databasePath: string;
  readonly catalog: CatalogDefinition;
  readonly clock?: () => Date;
}

interface IncidentServiceOptions {
  readonly repository: SqliteIncidentRepository;
  readonly inventoryReader: IncidentInventoryReader;
  readonly clock?: () => Date;
}

interface IncidentPage {
  readonly incidents: readonly IncidentSummary[];
  readonly truncated: boolean;
}

interface IncidentRow {
  readonly id: number | bigint;
  readonly fingerprint: string;
  readonly title: string;
  readonly description: string;
  readonly service_id: string;
  readonly service_name: string;
  readonly environment: IncidentEnvironment;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly version: number | bigint;
  readonly started_at: string;
  readonly last_observed_at: string;
  readonly updated_at: string;
  readonly resolved_at: string | null;
  readonly acknowledged_at: string | null;
  readonly acknowledged_by: string | null;
  readonly declared_at: string | null;
  readonly declared_by: string | null;
  readonly assignee: string;
  readonly owner: string;
  readonly alert_active: number | bigint;
  readonly recovered_at: string | null;
  readonly runbook_json: string;
}

interface EvidenceRow {
  readonly source: string;
  readonly state: IncidentEvidence["state"];
  readonly first_observed_at: string;
  readonly last_observed_at: string;
  readonly occurrences: number | bigint;
  readonly message: string;
  readonly active: number | bigint;
}

interface SilenceRow {
  readonly created_at: string;
  readonly expires_at: string;
  readonly created_by: string;
  readonly reason: string;
  readonly expired_at: string | null;
}

interface AuditRow {
  readonly id: number | bigint;
  readonly action: IncidentAuditAction;
  readonly actor: string;
  readonly reason: string;
  readonly created_at: string;
  readonly from_status: IncidentStatus | null;
  readonly to_status: IncidentStatus;
  readonly version: number | bigint;
}

function integer(value: number | bigint, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is outside the supported integer range`);
  return parsed;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function normalizedText(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw new IncidentRequestError("invalid_incident_command", 400, `${field} must be a string.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum || hasControlCharacter(normalized)) {
    throw new IncidentRequestError("invalid_incident_command", 400, `${field} must contain ${minimum} to ${maximum} printable characters.`);
  }
  return normalized;
}

function publicIncidentId(id: number): string {
  return `INC-${String(id).padStart(6, "0")}`;
}

function internalIncidentId(id: string): number {
  if (!/^INC-[0-9]{6}$/u.test(id)) throw new IncidentRequestError("incident_not_found", 404, "The requested incident does not exist.");
  return Number(id.slice(4));
}

function runbook(service: CatalogServiceDefinition): IncidentRunbook {
  return {
    id: `${service.id}-incident-response`,
    title: `${service.displayName} incident response`,
    steps: [
      `Confirm the current catalog, reachability, and workload evidence for ${service.displayName}.`,
      "Inspect bounded performance and infrastructure views for the affected time window.",
      "Record findings and a reason before acknowledging, silencing, declaring, or resolving the incident."
    ]
  };
}

function parseRunbook(value: string): IncidentRunbook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Stored incident runbook is malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Stored incident runbook is malformed");
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.title !== "string" || !Array.isArray(raw.steps) || !raw.steps.every((step) => typeof step === "string")) {
    throw new Error("Stored incident runbook is malformed");
  }
  return { id: raw.id, title: raw.title, steps: raw.steps };
}

function severityFor(service: ServiceInventory): IncidentSeverity {
  if (service.state === "failing" && service.criticality === "critical") return "P1";
  if (service.state === "failing" || service.state === "degraded") return "P2";
  return "P3";
}

function isAlertState(state: ServiceInventory["state"]): boolean {
  return state === "failing" || state === "degraded" || state === "unknown" || state === "stale";
}

function evidenceFor(service: ServiceInventory, observedAt: string): readonly IncidentEvidence[] {
  const evidence = new Map<string, IncidentEvidence>();
  for (const probe of service.probes.filter((item) => item.state !== "healthy" && item.state !== "paused")) {
    evidence.set(probe.source, {
      source: probe.source,
      state: probe.state,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      occurrences: 1,
      message: `${probe.name} is ${probe.state}.`,
      active: true
    });
  }
  for (const workload of service.workloads.filter((item) => item.state !== "healthy" && item.state !== "paused")) {
    evidence.set("kubernetes", {
      source: "kubernetes",
      state: workload.state,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      occurrences: 1,
      message: `${workload.kind} ${workload.namespace}/${workload.name} is ${workload.state}.`,
      active: true
    });
  }
  if (evidence.size === 0) {
    evidence.set("inventory-health-evaluator", {
      source: "inventory-health-evaluator",
      state: service.state,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      occurrences: 1,
      message: `${service.name} aggregate health is ${service.state}.`,
      active: true
    });
  }
  return [...evidence.values()];
}

export class SqliteIncidentRepository {
  private readonly database: DatabaseSync;
  private readonly services: ReadonlyMap<string, CatalogServiceDefinition>;
  private readonly clock: () => Date;

  constructor(options: IncidentRepositoryOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.services = new Map(options.catalog.services.map((service) => [service.id, service]));
    this.database = new DatabaseSync(options.databasePath);
    try {
      this.initializeSchema();
    } catch (cause: unknown) {
      this.database.close();
      throw cause;
    }
  }

  close(): void {
    this.database.close();
  }

  private initializeSchema(): void {
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    const metadata = this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_metadata'").get();
    if (metadata !== undefined) {
      const row = this.database.prepare("SELECT version FROM schema_metadata LIMIT 1").get() as { readonly version: number | bigint } | undefined;
      if (row === undefined) throw new Error("Incident database schema metadata is empty");
      const version = integer(row.version, "Incident database schema version");
      if (version !== SCHEMA_VERSION) throw new Error(`Unsupported incident database schema version: ${version}`);
      return;
    }
    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE schema_metadata (version INTEGER NOT NULL);
      INSERT INTO schema_metadata(version) VALUES (${SCHEMA_VERSION});
      CREATE TABLE incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        service_id TEXT NOT NULL,
        service_name TEXT NOT NULL,
        environment TEXT NOT NULL CHECK(environment IN ('demo','test','portfolio','shared')),
        severity TEXT NOT NULL CHECK(severity IN ('P1','P2','P3')),
        status TEXT NOT NULL CHECK(status IN ('active','resolved')),
        version INTEGER NOT NULL CHECK(version >= 1),
        started_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        declared_at TEXT,
        declared_by TEXT,
        assignee TEXT NOT NULL,
        owner TEXT NOT NULL,
        alert_active INTEGER NOT NULL CHECK(alert_active IN (0,1)),
        recovered_at TEXT,
        runbook_json TEXT NOT NULL
      );
      CREATE INDEX incidents_environment_status_idx ON incidents(environment, status, updated_at DESC);
      CREATE TABLE incident_evidence (
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        occurrences INTEGER NOT NULL CHECK(occurrences >= 1),
        message TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        PRIMARY KEY(incident_id, source)
      );
      CREATE TABLE incident_silences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        expired_at TEXT
      );
      CREATE INDEX incident_silences_incident_idx ON incident_silences(incident_id, id DESC);
      CREATE TABLE incident_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE INDEX incident_audit_incident_idx ON incident_audit(incident_id, id ASC);
      COMMIT;
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (cause: unknown) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve the original explicit failure */ }
      throw cause;
    }
  }

  private now(): string {
    const value = this.clock();
    if (Number.isNaN(value.getTime())) throw new Error("Incident clock returned an invalid date");
    return value.toISOString();
  }

  private incidentRow(id: number): IncidentRow {
    const row = this.database.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as unknown as IncidentRow | undefined;
    if (row === undefined) throw new IncidentRequestError("incident_not_found", 404, "The requested incident does not exist.");
    return row;
  }

  private evidence(id: number): readonly IncidentEvidence[] {
    const rows = this.database.prepare("SELECT source, state, first_observed_at, last_observed_at, occurrences, message, active FROM incident_evidence WHERE incident_id = ? ORDER BY source LIMIT 20").all(id) as unknown as readonly EvidenceRow[];
    return rows.map((row) => ({
      source: row.source,
      state: row.state,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
      occurrences: integer(row.occurrences, "Incident evidence occurrences"),
      message: row.message,
      active: integer(row.active, "Incident evidence active flag") === 1
    }));
  }

  private silence(id: number, now: string): IncidentSilence | null {
    const row = this.database.prepare("SELECT created_at, expires_at, created_by, reason, expired_at FROM incident_silences WHERE incident_id = ? ORDER BY id DESC LIMIT 1").get(id) as unknown as SilenceRow | undefined;
    if (row === undefined) return null;
    return {
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      createdBy: row.created_by,
      reason: row.reason,
      active: row.expired_at === null && row.expires_at > now
    };
  }

  private summary(row: IncidentRow, now: string): IncidentSummary {
    const id = integer(row.id, "Incident id");
    return {
      id: publicIncidentId(id),
      version: integer(row.version, "Incident version"),
      title: row.title,
      description: row.description,
      serviceId: row.service_id,
      serviceName: row.service_name,
      environment: row.environment,
      severity: row.severity,
      status: row.status,
      startedAt: row.started_at,
      lastObservedAt: row.last_observed_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by,
      declaredAt: row.declared_at,
      declaredBy: row.declared_by,
      assignee: row.assignee,
      owner: row.owner,
      alertActive: integer(row.alert_active, "Incident alert flag") === 1,
      recoveredAt: row.recovered_at,
      runbook: parseRunbook(row.runbook_json),
      evidence: this.evidence(id),
      silence: this.silence(id, now)
    };
  }

  private audit(id: number): readonly IncidentAuditEvent[] {
    const rows = this.database.prepare(`SELECT id, action, actor, reason, created_at, from_status, to_status, version FROM (
      SELECT id, action, actor, reason, created_at, from_status, to_status, version FROM incident_audit
      WHERE incident_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC`).all(id, MAX_AUDIT_EVENTS) as unknown as readonly AuditRow[];
    return rows.map((row) => ({
      id: integer(row.id, "Incident audit id"),
      action: row.action,
      actor: row.actor,
      reason: row.reason,
      createdAt: row.created_at,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      version: integer(row.version, "Incident audit version")
    }));
  }

  private insertAudit(id: number, action: IncidentAuditAction, actor: string, reason: string, createdAt: string, fromStatus: IncidentStatus | null, toStatus: IncidentStatus, version: number): void {
    this.database.prepare("INSERT INTO incident_audit(incident_id, action, actor, reason, created_at, from_status, to_status, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, action, actor, reason, createdAt, fromStatus, toStatus, version);
  }

  expireSilences(): void {
    const now = this.now();
    const rows = this.database.prepare("SELECT s.id AS silence_id, s.incident_id, i.status, i.version FROM incident_silences s JOIN incidents i ON i.id = s.incident_id WHERE s.expired_at IS NULL AND s.expires_at <= ? ORDER BY s.id").all(now) as unknown as readonly { readonly silence_id: number | bigint; readonly incident_id: number | bigint; readonly status: IncidentStatus; readonly version: number | bigint }[];
    if (rows.length === 0) return;
    this.transaction(() => {
      for (const row of rows) {
        const silenceId = integer(row.silence_id, "Silence id");
        const incidentId = integer(row.incident_id, "Incident id");
        const version = integer(row.version, "Incident version") + 1;
        this.database.prepare("UPDATE incident_silences SET expired_at = ? WHERE id = ? AND expired_at IS NULL").run(now, silenceId);
        this.database.prepare("UPDATE incidents SET version = ?, updated_at = ? WHERE id = ?").run(version, now, incidentId);
        this.insertAudit(incidentId, "silence_expired", "system:clock", "Silence reached its configured expiration.", now, row.status, row.status, version);
      }
    });
  }

  evaluateInventory(snapshot: InventorySnapshot): void {
    const observedAt = snapshot.assembledAt;
    this.transaction(() => {
      for (const service of snapshot.services) {
        const fingerprint = `service-health:${service.id}`;
        const existing = this.database.prepare("SELECT * FROM incidents WHERE fingerprint = ?").get(fingerprint) as unknown as IncidentRow | undefined;
        if (isAlertState(service.state)) {
          const severity = severityFor(service);
          const title = `${service.name} is ${service.state}`;
          const description = `Live inventory health evaluation reports ${service.name} as ${service.state}.`;
          let incidentId: number;
          if (existing === undefined) {
            const catalogService = this.services.get(service.id);
            if (catalogService === undefined) throw new Error(`Alert evaluation service is not in the catalog: ${service.id}`);
            const result = this.database.prepare(`INSERT INTO incidents(
              fingerprint, title, description, service_id, service_name, environment, severity, status, version,
              started_at, last_observed_at, updated_at, resolved_at, acknowledged_at, acknowledged_by,
              declared_at, declared_by, assignee, owner, alert_active, recovered_at, runbook_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'Unassigned', ?, 1, NULL, ?)`)
              .run(fingerprint, title, description, service.id, service.name, service.environment, severity, observedAt, observedAt, observedAt, service.owner, JSON.stringify(runbook(catalogService)));
            incidentId = integer(result.lastInsertRowid, "Incident id");
            this.insertAudit(incidentId, "created", "system:inventory-health-evaluator", `Live alert evaluation observed ${service.state} service health.`, observedAt, null, "active", 1);
          } else {
            incidentId = integer(existing.id, "Incident id");
            const previousVersion = integer(existing.version, "Incident version");
            const statusChanged = existing.status === "resolved";
            const recurred = integer(existing.alert_active, "Incident alert flag") === 0;
            const updated = existing.title !== title || existing.severity !== severity;
            const nextVersion = previousVersion + (statusChanged || recurred || updated ? 1 : 0);
            this.database.prepare(`UPDATE incidents SET title = ?, description = ?, severity = ?, status = 'active',
              version = ?, last_observed_at = ?, updated_at = ?, resolved_at = NULL, alert_active = 1, recovered_at = NULL WHERE id = ?`)
              .run(title, description, severity, nextVersion, observedAt, observedAt, incidentId);
            if (statusChanged) this.insertAudit(incidentId, "reopened", "system:inventory-health-evaluator", "Live alert evidence recurred after resolution.", observedAt, "resolved", "active", nextVersion);
            else if (recurred) this.insertAudit(incidentId, "alert_recurred", "system:inventory-health-evaluator", "Live alert evidence recurred after recovery.", observedAt, "active", "active", nextVersion);
            else if (updated) this.insertAudit(incidentId, "alert_updated", "system:inventory-health-evaluator", `Live alert severity changed to ${severity}.`, observedAt, "active", "active", nextVersion);
          }
          for (const evidence of evidenceFor(service, observedAt)) {
            this.database.prepare(`INSERT INTO incident_evidence(incident_id, source, state, first_observed_at, last_observed_at, occurrences, message, active)
              VALUES (?, ?, ?, ?, ?, 1, ?, 1)
              ON CONFLICT(incident_id, source) DO UPDATE SET state = excluded.state, last_observed_at = excluded.last_observed_at,
                occurrences = incident_evidence.occurrences + 1, message = excluded.message, active = 1`)
              .run(incidentId, evidence.source, evidence.state, observedAt, observedAt, evidence.message);
          }
        } else if (service.state === "healthy" && existing !== undefined && integer(existing.alert_active, "Incident alert flag") === 1) {
          const incidentId = integer(existing.id, "Incident id");
          const version = integer(existing.version, "Incident version") + 1;
          this.database.prepare("UPDATE incidents SET alert_active = 0, recovered_at = ?, updated_at = ?, last_observed_at = ?, version = ? WHERE id = ?")
            .run(observedAt, observedAt, observedAt, version, incidentId);
          this.database.prepare("UPDATE incident_evidence SET active = 0, last_observed_at = ? WHERE incident_id = ?").run(observedAt, incidentId);
          this.insertAudit(incidentId, "condition_recovered", "system:inventory-health-evaluator", "Live inventory health returned to healthy; operator resolution is still required.", observedAt, existing.status, existing.status, version);
        }
      }
    });
  }

  list(environment: string, statusFilter: IncidentStatusFilter): IncidentPage {
    const now = this.now();
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (environment !== "all") { conditions.push("environment = ?"); parameters.push(environment); }
    if (statusFilter !== "all") { conditions.push("status = ?"); parameters.push(statusFilter); }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    parameters.push(MAX_INCIDENTS + 1);
    const rows = this.database.prepare(`SELECT * FROM incidents ${where} ORDER BY CASE severity WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, updated_at DESC LIMIT ?`)
      .all(...parameters) as unknown as readonly IncidentRow[];
    return { incidents: rows.slice(0, MAX_INCIDENTS).map((row) => this.summary(row, now)), truncated: rows.length > MAX_INCIDENTS };
  }

  detail(id: string, operator: SessionUser): IncidentDetailResponse {
    const now = this.now();
    const internalId = internalIncidentId(id);
    return {
      apiVersion: 1,
      assembledAt: now,
      notification,
      operator: { ...operator, identityMode: "authenticated-session" },
      incident: this.summary(this.incidentRow(internalId), now),
      audit: this.audit(internalId)
    };
  }

  declare(command: DeclareIncidentCommand, operator: SessionUser): IncidentDetailResponse {
    const serviceId = normalizedText(command.serviceId, "serviceId", 1, 64);
    const title = normalizedText(command.title, "title", 3, 160);
    const reason = normalizedText(command.reason, "reason", 3, 500);
    if (!severityValues.has(command.severity)) throw new IncidentRequestError("invalid_incident_command", 400, "severity must be P1, P2, or P3.");
    const service = this.services.get(serviceId);
    if (service === undefined) throw new IncidentRequestError("invalid_incident_command", 400, "serviceId must identify a catalog service.");
    const now = this.now();
    const id = this.transaction(() => {
      const result = this.database.prepare(`INSERT INTO incidents(
        fingerprint, title, description, service_id, service_name, environment, severity, status, version,
        started_at, last_observed_at, updated_at, resolved_at, acknowledged_at, acknowledged_by,
        declared_at, declared_by, assignee, owner, alert_active, recovered_at, runbook_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, 0, NULL, ?)`)
        .run(`operator:${randomUUID()}`, title, `Operator-declared incident affecting ${service.displayName}.`, service.id, service.displayName, service.environment, command.severity, now, now, now, now, operator.displayName, operator.displayName, service.owner, JSON.stringify(runbook(service)));
      const incidentId = integer(result.lastInsertRowid, "Incident id");
      this.database.prepare("INSERT INTO incident_evidence(incident_id, source, state, first_observed_at, last_observed_at, occurrences, message, active) VALUES (?, 'operator', 'operator', ?, ?, 1, ?, 1)")
        .run(incidentId, now, now, reason);
      this.insertAudit(incidentId, "created", `${operator.displayName} (${operator.id})`, reason, now, null, "active", 1);
      return incidentId;
    });
    return this.detail(publicIncidentId(id), operator);
  }

  transition(id: string, command: IncidentTransitionCommand, operator: SessionUser): IncidentDetailResponse {
    if (!transitionValues.has(command.action)) throw new IncidentRequestError("invalid_incident_command", 400, "Unsupported incident transition.");
    if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) throw new IncidentRequestError("invalid_incident_command", 400, "expectedVersion must be a positive safe integer.");
    const reason = normalizedText(command.reason, "reason", 3, 500);
    if (command.action === "silence") {
      if (command.durationMinutes === undefined || !silenceDurations.has(command.durationMinutes)) throw new IncidentRequestError("invalid_incident_command", 400, "Silence duration must be 15, 60, 360, or 1440 minutes.");
    } else if (command.durationMinutes !== undefined) {
      throw new IncidentRequestError("invalid_incident_command", 400, "durationMinutes is supported only for silence transitions.");
    }
    const internalId = internalIncidentId(id);
    const now = this.now();
    this.transaction(() => {
      const row = this.incidentRow(internalId);
      const currentVersion = integer(row.version, "Incident version");
      if (currentVersion !== command.expectedVersion) throw new IncidentRequestError("incident_version_conflict", 409, "The incident changed; refresh before retrying the transition.");
      if (row.status !== "active") throw new IncidentRequestError("invalid_incident_transition", 409, "Resolved incidents cannot be changed unless live alert evidence reopens them.");
      const version = currentVersion + 1;
      let action: IncidentAuditAction;
      let toStatus: IncidentStatus = "active";
      if (command.action === "acknowledge") {
        if (row.acknowledged_at !== null) throw new IncidentRequestError("invalid_incident_transition", 409, "The incident is already acknowledged.");
        this.database.prepare("UPDATE incidents SET acknowledged_at = ?, acknowledged_by = ?, assignee = ?, updated_at = ?, version = ? WHERE id = ?")
          .run(now, operator.displayName, operator.displayName, now, version, internalId);
        action = "acknowledged";
      } else if (command.action === "declare") {
        if (row.declared_at !== null) throw new IncidentRequestError("invalid_incident_transition", 409, "The incident is already declared.");
        this.database.prepare("UPDATE incidents SET declared_at = ?, declared_by = ?, assignee = ?, updated_at = ?, version = ? WHERE id = ?")
          .run(now, operator.displayName, operator.displayName, now, version, internalId);
        action = "declared";
      } else if (command.action === "silence") {
        const active = this.database.prepare("SELECT id FROM incident_silences WHERE incident_id = ? AND expired_at IS NULL AND expires_at > ? LIMIT 1").get(internalId, now);
        if (active !== undefined) throw new IncidentRequestError("invalid_incident_transition", 409, "The incident already has an active silence.");
        const expiresAt = new Date(Date.parse(now) + (command.durationMinutes ?? 0) * 60_000).toISOString();
        this.database.prepare("INSERT INTO incident_silences(incident_id, created_at, expires_at, created_by, reason, expired_at) VALUES (?, ?, ?, ?, ?, NULL)")
          .run(internalId, now, expiresAt, operator.displayName, reason);
        this.database.prepare("UPDATE incidents SET updated_at = ?, version = ? WHERE id = ?").run(now, version, internalId);
        action = "silenced";
      } else {
        this.database.prepare("UPDATE incidents SET status = 'resolved', resolved_at = ?, updated_at = ?, version = ? WHERE id = ?")
          .run(now, now, version, internalId);
        action = "resolved";
        toStatus = "resolved";
      }
      this.insertAudit(internalId, action, `${operator.displayName} (${operator.id})`, reason, now, row.status, toStatus, version);
    });
    return this.detail(id, operator);
  }
}

export class IncidentOperationsService {
  private readonly repository: SqliteIncidentRepository;
  private readonly inventoryReader: IncidentInventoryReader;
  private readonly clock: () => Date;
  private alertSource: IncidentAlertSourceStatus = {
    name: "inventory-health-evaluator",
    availability: "unavailable",
    evaluatedAt: null,
    message: "Live alert evaluation has not completed."
  };

  constructor(options: IncidentServiceOptions) {
    this.repository = options.repository;
    this.inventoryReader = options.inventoryReader;
    this.clock = options.clock ?? (() => new Date());
  }

  async evaluate(): Promise<void> {
    try {
      this.repository.expireSilences();
      const snapshot = await this.inventoryReader.getInventory("all");
      this.repository.evaluateInventory(snapshot);
      this.alertSource = { name: "inventory-health-evaluator", availability: "available", evaluatedAt: snapshot.assembledAt, message: null };
    } catch {
      this.alertSource = { name: "inventory-health-evaluator", availability: "unavailable", evaluatedAt: null, message: "Live alert evaluation is unavailable." };
    }
  }

  list(environment: string, statusFilter: string, operator: SessionUser): Promise<IncidentListResponse> {
    return Promise.resolve().then(() => {
      if (!environmentValues.has(environment)) throw new IncidentRequestError("invalid_environment", 400, `Unsupported environment: ${environment}`);
      if (!statusFilterValues.has(statusFilter as IncidentStatusFilter)) throw new IncidentRequestError("invalid_incident_filter", 400, `Unsupported incident status: ${statusFilter}`);
      const page = this.repository.list(environment, statusFilter as IncidentStatusFilter);
      const incidents = page.incidents;
      return {
        apiVersion: 1,
        mode: this.alertSource.availability === "available" ? "live" : "partial",
        assembledAt: this.clock().toISOString(),
        environment: environment as IncidentListResponse["environment"],
        statusFilter: statusFilter as IncidentStatusFilter,
        truncated: page.truncated,
        summary: {
          total: incidents.length,
          active: incidents.filter((incident) => incident.status === "active").length,
          resolved: incidents.filter((incident) => incident.status === "resolved").length,
          unacknowledged: incidents.filter((incident) => incident.status === "active" && incident.acknowledgedAt === null).length,
          silenced: incidents.filter((incident) => incident.silence?.active === true).length
        },
        alertSource: this.alertSource,
        notification,
        operator: { ...operator, identityMode: "authenticated-session" },
        incidents
      };
    });
  }

  getDetail(id: string, operator: SessionUser): Promise<IncidentDetailResponse> {
    return Promise.resolve().then(() => this.repository.detail(id, operator));
  }

  declare(command: DeclareIncidentCommand, operator: SessionUser): Promise<IncidentDetailResponse> {
    return Promise.resolve().then(() => this.repository.declare(command, operator));
  }

  transition(id: string, command: IncidentTransitionCommand, operator: SessionUser): Promise<IncidentDetailResponse> {
    return Promise.resolve().then(() => this.repository.transition(id, command, operator));
  }
}
