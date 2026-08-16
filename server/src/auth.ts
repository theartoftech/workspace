import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { AuthenticationAuditAction, AuthenticationAuditEvent, SessionUser, WorkspaceRole } from "../../shared/auth";

export type { AuthenticationAuditAction, AuthenticationAuditEvent, SessionUser, WorkspaceRole } from "../../shared/auth";

export interface AccessRoleMappingEntry {
  readonly email: string;
  readonly displayName: string;
  readonly role: WorkspaceRole;
}

export interface AccessRoleMapping {
  readonly version: 1;
  readonly identities: readonly AccessRoleMappingEntry[];
}

export interface CloudflareAccessIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface CloudflareAccessVerifier {
  verify(assertion: string): Promise<CloudflareAccessIdentity>;
}

export interface AuthenticationConfig {
  readonly publicOrigin: string;
  readonly teamDomain: string;
  readonly auditRetentionDays: number;
  readonly auditMaxRecords: number;
}

export type AuthenticationErrorStatus = 400 | 401 | 403 | 503;

export class AuthenticationError extends Error {
  constructor(readonly status: AuthenticationErrorStatus, readonly code: string, message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class IdentityProviderUnavailableError extends Error {
  constructor(message = "Identity provider unavailable") {
    super(message);
    this.name = "IdentityProviderUnavailableError";
  }
}

export class IdentityAssertionRejectedError extends Error {
  constructor(message = "Identity assertion rejected") {
    super(message);
    this.name = "IdentityAssertionRejectedError";
  }
}

export interface AuthenticatedSession {
  readonly user: SessionUser;
  readonly expiresAt: string;
}

export interface LogoutResult {
  readonly redirectTo: "/cdn-cgi/access/logout";
}

interface AuditRow {
  readonly id: number | bigint;
  readonly created_at: number | bigint;
  readonly actor_id: string | null;
  readonly display_name: string | null;
  readonly action: AuthenticationAuditAction;
  readonly outcome: AuthenticationAuditEvent["outcome"];
  readonly reason_code: string;
  readonly metadata_json: string | null;
}

export interface AccessAuthenticationServiceOptions {
  readonly config: AuthenticationConfig;
  readonly databasePath: string;
  readonly roleMapping: AccessRoleMapping;
  readonly verifier: CloudflareAccessVerifier;
  readonly clock?: () => Date;
}

const roles = new Set<WorkspaceRole>(["viewer", "operator", "administrator"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const expected = new Set(fields);
  if (Object.keys(value).some((field) => !expected.has(field))) throw new Error(`${label} has unsupported fields`);
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function normalizedEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("Access role mapping email must be a string");
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || containsControl(email) || !/^[^\s@*]+@[^\s@*]+$/u.test(email)) {
    throw new Error("Access role mapping email must be one exact email address");
  }
  return email;
}

function normalizedDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Access role mapping displayName must be a string");
  const displayName = value.trim();
  if (displayName === "" || displayName.length > 80 || containsControl(displayName)) {
    throw new Error("Access role mapping displayName must contain 1 to 80 printable characters");
  }
  return displayName;
}

export function parseAccessRoleMappingJson(source: string): AccessRoleMapping {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error("Cloudflare Access role mapping is not valid JSON");
  }
  const raw = record(parsed);
  if (raw === null) throw new Error("Cloudflare Access role mapping must be a JSON object");
  exactFields(raw, ["version", "identities"], "Cloudflare Access role mapping");
  if (raw.version !== 1 || !Array.isArray(raw.identities) || raw.identities.length < 1 || raw.identities.length > 100) {
    throw new Error("Cloudflare Access role mapping must use version 1 with 1 to 100 identities");
  }
  const seen = new Set<string>();
  const identities = raw.identities.map((value): AccessRoleMappingEntry => {
    const entry = record(value);
    if (entry === null) throw new Error("Cloudflare Access role mapping identities must be JSON objects");
    exactFields(entry, ["email", "displayName", "role"], "Cloudflare Access role mapping identity");
    const email = normalizedEmail(entry.email);
    if (seen.has(email)) throw new Error("Cloudflare Access role mapping emails must be unique");
    seen.add(email);
    if (typeof entry.role !== "string" || !roles.has(entry.role as WorkspaceRole)) {
      throw new Error("Cloudflare Access role mapping role must be viewer, operator, or administrator");
    }
    return { email, displayName: normalizedDisplayName(entry.displayName), role: entry.role as WorkspaceRole };
  });
  return { version: 1, identities };
}

function safeInteger(value: number | bigint, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is outside the supported integer range`);
  return parsed;
}

function timestamp(clock: () => Date): number {
  const value = clock().getTime();
  if (!Number.isFinite(value)) throw new Error("Authentication clock returned an invalid date");
  return value;
}

function auditMetadata(value: Readonly<Record<string, string>> | null): string | null {
  if (value === null) return null;
  const entries = Object.entries(value);
  if (entries.length > 8) throw new Error("Authentication audit metadata exceeds the field cap");
  const safe: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(key) || item.length > 160 || containsControl(item) || /token|cookie|secret|claim|code|state|nonce/iu.test(key)) {
      throw new Error("Authentication audit metadata is not safe");
    }
    safe[key] = item;
  }
  return JSON.stringify(safe);
}

function parsedExpiry(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new IdentityAssertionRejectedError(`${label} is invalid`);
  return parsed;
}

export class AccessAuthenticationService {
  private readonly database: DatabaseSync;
  private readonly config: AuthenticationConfig;
  private readonly verifier: CloudflareAccessVerifier;
  private readonly clock: () => Date;
  private readonly mappings: ReadonlyMap<string, AccessRoleMappingEntry>;
  private readonly validatedAssertions = new Map<string, number>();

  constructor(options: AccessAuthenticationServiceOptions) {
    this.config = options.config;
    this.verifier = options.verifier;
    this.clock = options.clock ?? (() => new Date());
    this.validateConfig();
    this.mappings = new Map(options.roleMapping.identities.map((entry) => [entry.email, entry]));
    if (this.mappings.size !== options.roleMapping.identities.length || this.mappings.size < 1) throw new Error("Cloudflare Access role mapping is invalid");
    this.database = new DatabaseSync(options.databasePath);
    try {
      if (options.databasePath !== ":memory:" && !options.databasePath.startsWith("file::memory:")) chmodSync(options.databasePath, 0o600);
      this.initializeSchema();
    } catch (cause: unknown) {
      this.database.close();
      throw cause;
    }
  }

  get publicOrigin(): string {
    return this.config.publicOrigin;
  }

  close(): void {
    this.database.close();
  }

  private validateConfig(): void {
    const origin = new URL(this.config.publicOrigin);
    if (origin.protocol !== "https:" || origin.origin !== this.config.publicOrigin || origin.pathname !== "/") {
      throw new Error("Authentication publicOrigin must be an HTTPS origin without a path");
    }
    if (this.config.teamDomain !== originForAccessTeam(this.config.teamDomain)) throw new Error("Authentication teamDomain is invalid");
    if (!Number.isInteger(this.config.auditRetentionDays) || this.config.auditRetentionDays < 1 || this.config.auditRetentionDays > 3650) {
      throw new Error("auditRetentionDays must be 1..3650");
    }
    if (!Number.isInteger(this.config.auditMaxRecords) || this.config.auditMaxRecords < 100 || this.config.auditMaxRecords > 1_000_000) {
      throw new Error("auditMaxRecords must be 100..1000000");
    }
  }

  private initializeSchema(): void {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS access_auth_schema_metadata(version INTEGER NOT NULL);
      INSERT INTO access_auth_schema_metadata(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM access_auth_schema_metadata);
      CREATE TABLE IF NOT EXISTS auth_audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        actor_id TEXT,
        display_name TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS auth_audit_created_idx ON auth_audit(created_at DESC, id DESC);
    `);
    const row = this.database.prepare("SELECT version FROM access_auth_schema_metadata LIMIT 1").get() as { readonly version: number | bigint } | undefined;
    if (row === undefined || safeInteger(row.version, "Authentication schema version") !== 1) throw new Error("Unsupported authentication database schema version");
  }

  private audit(event: {
    readonly actorId: string | null;
    readonly displayName: string | null;
    readonly action: AuthenticationAuditAction;
    readonly outcome: AuthenticationAuditEvent["outcome"];
    readonly reasonCode: string;
    readonly metadata: Readonly<Record<string, string>> | null;
  }): void {
    const now = timestamp(this.clock);
    this.database.prepare("INSERT INTO auth_audit(created_at, actor_id, display_name, action, outcome, reason_code, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(now, event.actorId, event.displayName, event.action, event.outcome, event.reasonCode, auditMetadata(event.metadata));
    const retentionCutoff = now - this.config.auditRetentionDays * 86_400_000;
    this.database.prepare("DELETE FROM auth_audit WHERE created_at < ?").run(retentionCutoff);
    this.database.prepare("DELETE FROM auth_audit WHERE id NOT IN (SELECT id FROM auth_audit ORDER BY created_at DESC, id DESC LIMIT ?)")
      .run(this.config.auditMaxRecords);
  }

  private rejected(reasonCode: string, status: 401 | 403, message: string): AuthenticationError {
    this.audit({ actorId: null, displayName: null, action: "identity_rejected", outcome: "denied", reasonCode, metadata: null });
    return new AuthenticationError(status, status === 403 ? "role_not_authorized" : "invalid_access_identity", message);
  }

  async authenticate(assertion: string | null): Promise<AuthenticatedSession> {
    if (assertion === null || assertion === "") {
      this.audit({ actorId: null, displayName: null, action: "identity_rejected", outcome: "denied", reasonCode: "assertion_missing", metadata: null });
      throw new AuthenticationError(401, "authentication_required", "Cloudflare Access authentication is required.");
    }
    if (assertion.length > 16_384) throw this.rejected("assertion_oversized", 401, "The Cloudflare Access identity is invalid.");
    let identity: CloudflareAccessIdentity;
    try {
      identity = await this.verifier.verify(assertion);
    } catch (cause: unknown) {
      if (cause instanceof IdentityProviderUnavailableError) {
        this.audit({ actorId: null, displayName: null, action: "identity_rejected", outcome: "failed", reasonCode: "jwks_unavailable", metadata: null });
        throw new AuthenticationError(503, "identity_provider_unavailable", "Cloudflare Access identity validation is temporarily unavailable.");
      }
      this.audit({ actorId: null, displayName: null, action: "identity_rejected", outcome: "denied", reasonCode: "assertion_rejected", metadata: null });
      throw new AuthenticationError(401, "invalid_access_identity", "The Cloudflare Access identity is invalid.");
    }
    const now = timestamp(this.clock);
    if (identity.issuer !== this.config.teamDomain || identity.subject.trim() === "" || identity.subject.length > 512 || containsControl(identity.subject)) {
      throw this.rejected("identity_mismatch", 401, "The Cloudflare Access identity is invalid.");
    }
    let issuedAt: number;
    let expiresAt: number;
    try {
      issuedAt = parsedExpiry(identity.issuedAt, "Access identity issue time");
      expiresAt = parsedExpiry(identity.expiresAt, "Access identity expiry");
    } catch {
      throw this.rejected("identity_timestamp_invalid", 401, "The Cloudflare Access identity is invalid.");
    }
    if (expiresAt <= now || expiresAt <= issuedAt) throw this.rejected("identity_expired", 401, "The Cloudflare Access identity is expired.");
    let email: string;
    try {
      email = normalizedEmail(identity.email);
    } catch {
      throw this.rejected("email_invalid", 401, "The Cloudflare Access identity is invalid.");
    }
    const mapping = this.mappings.get(email);
    if (mapping === undefined) throw this.rejected("identity_unmapped", 403, "The authenticated identity has no approved Workspace Monitor role.");
    const actorId = `access:${createHash("sha256").update(`${identity.issuer}\n${identity.subject}`, "utf8").digest("hex").slice(0, 32)}`;
    const user: SessionUser = { id: actorId, displayName: mapping.displayName, role: mapping.role };
    const assertionHash = createHash("sha256").update(assertion, "utf8").digest("hex");
    for (const [hash, expiry] of this.validatedAssertions) if (expiry <= now) this.validatedAssertions.delete(hash);
    if (!this.validatedAssertions.has(assertionHash)) {
      this.validatedAssertions.set(assertionHash, expiresAt);
      this.audit({ actorId, displayName: user.displayName, action: "identity_validated", outcome: "succeeded", reasonCode: "cloudflare_access_jwt_validated", metadata: { role: user.role } });
    }
    return { user, expiresAt: new Date(expiresAt).toISOString() };
  }

  recordAuthorizationDenied(user: SessionUser, action: string, reasonCode: string): void {
    this.audit({ actorId: user.id, displayName: user.displayName, action: "authorization_denied", outcome: "denied", reasonCode, metadata: { action } });
  }

  recordLogout(user: SessionUser): LogoutResult {
    this.audit({ actorId: user.id, displayName: user.displayName, action: "logout", outcome: "succeeded", reasonCode: "cloudflare_access_logout_started", metadata: null });
    return { redirectTo: "/cdn-cgi/access/logout" };
  }

  listAudit(limit: number): readonly AuthenticationAuditEvent[] {
    const rows = this.database.prepare("SELECT id, created_at, actor_id, display_name, action, outcome, reason_code, metadata_json FROM auth_audit ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as unknown as readonly AuditRow[];
    return rows.map((row) => ({
      id: safeInteger(row.id, "Authentication audit id"),
      createdAt: new Date(safeInteger(row.created_at, "Authentication audit timestamp")).toISOString(),
      actorId: row.actor_id,
      displayName: row.display_name,
      action: row.action,
      outcome: row.outcome,
      reasonCode: row.reason_code,
      metadata: row.metadata_json === null ? null : JSON.parse(row.metadata_json) as Readonly<Record<string, string>>
    }));
  }
}

function originForAccessTeam(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || !url.hostname.endsWith(".cloudflareaccess.com")) return "";
  return url.origin;
}
