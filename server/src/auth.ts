import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { AuthenticationAuditAction, AuthenticationAuditEvent, SessionUser, WorkspaceRole } from "../../shared/auth";

export type { AuthenticationAuditAction, AuthenticationAuditEvent, SessionUser, WorkspaceRole } from "../../shared/auth";

export interface SessionKey {
  readonly id: string;
  readonly secret: Buffer;
}

export interface SessionKeyring {
  readonly activeKeyId: string;
  readonly keys: readonly SessionKey[];
}

export interface AuthenticationConfig {
  readonly publicOrigin: string;
  readonly redirectUri: string;
  readonly postLogoutRedirectUri: string;
  readonly scopes: readonly string[];
  readonly roleClaim: string;
  readonly displayNameClaim: string;
  readonly groups: Readonly<Record<WorkspaceRole, string>>;
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
  readonly transactionSeconds: number;
  readonly auditRetentionDays: number;
  readonly auditMaxRecords: number;
}

export interface OidcAuthorizationRequest {
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
}

export interface OidcCallbackRequest {
  readonly callbackUrl: string;
  readonly redirectUri: string;
  readonly expectedState: string;
  readonly expectedNonce: string;
  readonly pkceVerifier: string;
}

export interface OidcRefreshRequest {
  readonly refreshToken: string;
  readonly expectedSubject: string;
}

export interface OidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly claims: Readonly<Record<string, unknown>>;
  readonly refreshToken: string | null;
  readonly tokenExpiresAt: string;
}

export interface OidcProvider {
  authorize(request: OidcAuthorizationRequest): Promise<URL>;
  callback(request: OidcCallbackRequest): Promise<OidcIdentity>;
  refresh(request: OidcRefreshRequest): Promise<OidcIdentity>;
  logoutUrl(postLogoutRedirectUri: string): Promise<URL | null>;
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

export class IdentityProviderRejectedError extends Error {
  constructor(message = "Identity provider rejected the request") {
    super(message);
    this.name = "IdentityProviderRejectedError";
  }
}

export interface LoginStart {
  readonly authorizationUrl: string;
  readonly transactionCookie: string;
}

export interface LoginCompletion {
  readonly user: SessionUser;
  readonly sessionCookie: string;
  readonly clearTransactionCookie: string;
  readonly returnTo: string;
}

export interface AuthenticatedSession {
  readonly user: SessionUser;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
}

export interface LogoutResult {
  readonly clearSessionCookie: string;
  readonly redirectTo: string;
  readonly providerLogoutAvailable: boolean;
}

interface TransactionPayload {
  readonly state: string;
  readonly nonce: string;
  readonly pkceVerifier: string;
  readonly returnTo: string;
}

interface SessionPayload {
  readonly issuer: string;
  readonly subject: string;
  readonly refreshToken: string;
  readonly user: SessionUser;
}

interface TransactionRow {
  readonly encrypted_payload: string;
  readonly state_hash: string;
  readonly expires_at: number | bigint;
  readonly consumed_at: number | bigint | null;
}

interface SessionRow {
  readonly encrypted_payload: string;
  readonly idle_expires_at: number | bigint;
  readonly absolute_expires_at: number | bigint;
  readonly auth_valid_until: number | bigint;
  readonly revoked_at: number | bigint | null;
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

interface AuthenticationServiceOptions {
  readonly config: AuthenticationConfig;
  readonly databasePath: string;
  readonly keyring: SessionKeyring;
  readonly provider: OidcProvider;
  readonly clock?: () => Date;
}

const SESSION_COOKIE = "__Host-workspace_session";
const TRANSACTION_COOKIE = "__Host-workspace_oidc";
const roleRank: Readonly<Record<WorkspaceRole, number>> = { viewer: 1, operator: 2, administrator: 3 };
const allowedPaths = new Set(["/", "/deployments", "/infrastructure", "/performance", "/incidents", "/logs", "/settings"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const expected = new Set(fields);
  if (Object.keys(value).some((field) => !expected.has(field))) throw new Error(`${label} has unsupported fields`);
}

export function parseSessionKeyringJson(source: string): SessionKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error("Session keyring is not valid JSON");
  }
  const raw = record(parsed);
  if (raw === null) throw new Error("Session keyring must be a JSON object");
  exactFields(raw, ["version", "activeKeyId", "keys"], "Session keyring");
  if (raw.version !== 1 || typeof raw.activeKeyId !== "string" || !Array.isArray(raw.keys)) throw new Error("Session keyring must use version 1 with an activeKeyId and keys array");
  const keys = raw.keys.map((value): SessionKey => {
    const entry = record(value);
    if (entry === null) throw new Error("Session keyring entries must be JSON objects");
    exactFields(entry, ["id", "secret"], "Session keyring entry");
    if (typeof entry.id !== "string" || typeof entry.secret !== "string") throw new Error("Session keyring entries require id and secret strings");
    if (!/^[A-Za-z0-9_-]{43}$/u.test(entry.secret)) throw new Error("Session keyring secrets must be base64url-encoded 32-byte values");
    const secret = Buffer.from(entry.secret, "base64url");
    if (secret.byteLength !== 32) throw new Error("Session keyring secrets must be base64url-encoded 32-byte values");
    return { id: entry.id, secret };
  });
  return { activeKeyId: raw.activeKeyId, keys };
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

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function opaqueValue(): string {
  return base64url(randomBytes(32));
}

function constantEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function normalizedClaim(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new AuthenticationError(403, "identity_claim_invalid", `The configured ${label} claim is unavailable.`);
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maximum || containsControl(normalized)) {
    throw new AuthenticationError(403, "identity_claim_invalid", `The configured ${label} claim is invalid.`);
  }
  return normalized;
}

function claimAtPath(claims: Readonly<Record<string, unknown>>, path: string): unknown {
  const segments = path.split(".");
  let value: unknown = claims;
  for (const segment of segments) {
    if (segment === "" || segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      throw new AuthenticationError(403, "identity_claim_invalid", "The configured identity claim path is invalid.");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Readonly<Record<string, unknown>>)[segment];
  }
  return value;
}

function effectiveRole(claims: Readonly<Record<string, unknown>>, config: AuthenticationConfig): WorkspaceRole {
  const raw = claimAtPath(claims, config.roleClaim);
  if (!Array.isArray(raw) || !raw.every((group) => typeof group === "string")) {
    throw new AuthenticationError(403, "role_not_authorized", "The authenticated identity has no approved Workspace Monitor role.");
  }
  const memberships = new Set(raw);
  const matches = (Object.entries(config.groups) as Array<[WorkspaceRole, string]>)
    .filter(([, group]) => memberships.has(group))
    .map(([role]) => role)
    .sort((left, right) => roleRank[right] - roleRank[left]);
  const role = matches[0];
  if (role === undefined) throw new AuthenticationError(403, "role_not_authorized", "The authenticated identity has no approved Workspace Monitor role.");
  return role;
}

function identityUser(identity: OidcIdentity, config: AuthenticationConfig): SessionUser {
  const issuer = normalizedClaim(identity.issuer, "issuer", 2048);
  const subject = normalizedClaim(identity.subject, "subject", 512);
  const displayName = normalizedClaim(claimAtPath(identity.claims, config.displayNameClaim), "display name", 80);
  const id = `oidc:${createHash("sha256").update(`${issuer}\n${subject}`, "utf8").digest("hex").slice(0, 32)}`;
  return { id, displayName, role: effectiveRole(identity.claims, config) };
}

function parseExpiry(value: string, now: number): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= now) throw new AuthenticationError(401, "identity_token_expired", "The identity provider returned an expired session.");
  return parsed;
}

function safeReturnPath(raw: string, publicOrigin: string): string {
  if (raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || containsControl(raw) || raw.includes("#")) {
    throw new AuthenticationError(400, "invalid_return_path", "The requested return path is not allowed.");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new AuthenticationError(400, "invalid_return_path", "The requested return path is malformed.");
  }
  if (decoded.startsWith("//") || decoded.includes("\\") || containsControl(decoded)) {
    throw new AuthenticationError(400, "invalid_return_path", "The requested return path is not allowed.");
  }
  const url = new URL(raw, publicOrigin);
  if (url.origin !== publicOrigin || url.username !== "" || url.password !== "") {
    throw new AuthenticationError(400, "invalid_return_path", "The requested return path is not allowed.");
  }
  const pathAllowed = allowedPaths.has(url.pathname) || /^\/services\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(url.pathname);
  if (!pathAllowed) throw new AuthenticationError(400, "invalid_return_path", "The requested return path is not a Workspace Monitor route.");
  return `${url.pathname}${url.search}`;
}

function cookiePair(header: string | null, name: string): string | null {
  if (header === null || header.length > 8192) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
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

export class AuthenticationService {
  private readonly database: DatabaseSync;
  private readonly config: AuthenticationConfig;
  private readonly provider: OidcProvider;
  private readonly clock: () => Date;
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly activeKeyId: string;
  private readonly refreshOperations = new Map<string, Promise<void>>();

  constructor(options: AuthenticationServiceOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.clock = options.clock ?? (() => new Date());
    this.validateConfig();
    this.keys = this.validateKeyring(options.keyring);
    this.activeKeyId = options.keyring.activeKeyId;
    this.database = new DatabaseSync(options.databasePath);
    try {
      if (options.databasePath !== ":memory:" && !options.databasePath.startsWith("file::memory:")) chmodSync(options.databasePath, 0o600);
      this.initializeSchema();
    } catch (cause: unknown) {
      this.database.close();
      throw cause;
    }
  }

  close(): void {
    this.database.close();
  }

  get publicOrigin(): string {
    return this.config.publicOrigin;
  }

  completeLoginQuery(search: string, cookieHeader: string | null): Promise<LoginCompletion> {
    return this.completeLogin({ callbackUrl: `${this.config.redirectUri}${search}`, cookieHeader });
  }

  private validateConfig(): void {
    const origin = new URL(this.config.publicOrigin);
    if (origin.protocol !== "https:" || origin.origin !== this.config.publicOrigin || origin.pathname !== "/") {
      throw new Error("Authentication publicOrigin must be an HTTPS origin without a path");
    }
    if (this.config.redirectUri !== `${this.config.publicOrigin}/auth/callback`) throw new Error("OIDC redirectUri must use the exact Workspace Monitor callback");
    if (this.config.postLogoutRedirectUri !== `${this.config.publicOrigin}/`) throw new Error("OIDC postLogoutRedirectUri must use the Workspace Monitor root");
    if (!this.config.scopes.includes("openid") || new Set(this.config.scopes).size !== this.config.scopes.length) throw new Error("OIDC scopes must be unique and include openid");
    for (const [label, value, minimum, maximum] of [
      ["idleSeconds", this.config.idleSeconds, 60, 86_400],
      ["absoluteSeconds", this.config.absoluteSeconds, 300, 604_800],
      ["transactionSeconds", this.config.transactionSeconds, 60, 1800],
      ["auditRetentionDays", this.config.auditRetentionDays, 1, 3650],
      ["auditMaxRecords", this.config.auditMaxRecords, 100, 1_000_000]
    ] as const) {
      if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be ${minimum}..${maximum}`);
    }
    if (this.config.idleSeconds >= this.config.absoluteSeconds) throw new Error("Authentication idle expiry must be shorter than absolute expiry");
    const groupValues = Object.values(this.config.groups);
    if (new Set(groupValues).size !== groupValues.length || groupValues.some((group) => group.trim() === "" || group.length > 256 || containsControl(group))) {
      throw new Error("Authentication role groups must be distinct printable values");
    }
  }

  private validateKeyring(keyring: SessionKeyring): ReadonlyMap<string, Buffer> {
    if (keyring.keys.length < 1 || keyring.keys.length > 2) throw new Error("Session keyring must contain one current key and at most one previous key");
    const keys = new Map<string, Buffer>();
    for (const key of keyring.keys) {
      if (!/^[A-Za-z0-9_-]{1,32}$/u.test(key.id) || key.secret.byteLength !== 32 || keys.has(key.id)) throw new Error("Session keyring entries must have unique safe ids and 32-byte secrets");
      keys.set(key.id, Buffer.from(key.secret));
    }
    if (!keys.has(keyring.activeKeyId)) throw new Error("Session keyring active key is unavailable");
    return keys;
  }

  private initializeSchema(): void {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS auth_schema_metadata(version INTEGER NOT NULL);
      INSERT INTO auth_schema_metadata(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM auth_schema_metadata);
      CREATE TABLE IF NOT EXISTS auth_transactions(
        id_hash TEXT PRIMARY KEY,
        state_hash TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_sessions(
        id_hash TEXT PRIMARY KEY,
        encrypted_payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        idle_expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        auth_valid_until INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(absolute_expires_at, idle_expires_at);
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
    const row = this.database.prepare("SELECT version FROM auth_schema_metadata LIMIT 1").get() as { readonly version: number | bigint } | undefined;
    if (row === undefined || safeInteger(row.version, "Authentication schema version") !== 1) throw new Error("Unsupported authentication database schema version");
  }

  private key(id: string): Buffer {
    const key = this.keys.get(id);
    if (key === undefined) throw new AuthenticationError(401, "session_key_unavailable", "The session cannot be validated.");
    return key;
  }

  private protect(payload: object, purpose: "transaction" | "session"): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(this.activeKeyId), iv);
    cipher.setAAD(Buffer.from(`workspace-monitor:${purpose}:${this.activeKeyId}`, "utf8"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return `${this.activeKeyId}.${base64url(iv)}.${base64url(cipher.getAuthTag())}.${base64url(encrypted)}`;
  }

  private unprotect(protectedValue: string, purpose: "transaction"): TransactionPayload;
  private unprotect(protectedValue: string, purpose: "session"): SessionPayload;
  private unprotect(protectedValue: string, purpose: "transaction" | "session"): TransactionPayload | SessionPayload {
    const parts = protectedValue.split(".");
    if (parts.length !== 4) throw new AuthenticationError(401, "session_invalid", "The session is invalid.");
    const [keyId, ivValue, tagValue, encryptedValue] = parts;
    if (keyId === undefined || ivValue === undefined || tagValue === undefined || encryptedValue === undefined) throw new AuthenticationError(401, "session_invalid", "The session is invalid.");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key(keyId), Buffer.from(ivValue, "base64url"));
      decipher.setAAD(Buffer.from(`workspace-monitor:${purpose}:${keyId}`, "utf8"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      const plain = Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
      return JSON.parse(plain) as TransactionPayload | SessionPayload;
    } catch (cause: unknown) {
      if (cause instanceof AuthenticationError) throw cause;
      throw new AuthenticationError(401, "session_invalid", "The session is invalid.");
    }
  }

  private opaque(purpose: "transaction" | "session"): { readonly hash: string; readonly value: string } {
    const raw = opaqueValue();
    return { value: `${this.activeKeyId}.${raw}`, hash: this.opaqueHash(`${this.activeKeyId}.${raw}`, purpose) };
  }

  private opaqueHash(value: string, purpose: "transaction" | "session"): string {
    const parts = value.split(".");
    const keyId = parts[0];
    const raw = parts[1];
    if (parts.length !== 2 || keyId === undefined || raw === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(raw)) {
      throw new AuthenticationError(401, `${purpose}_invalid`, `The ${purpose} is invalid.`);
    }
    return createHmac("sha256", this.key(keyId)).update(`${purpose}:${raw}`, "utf8").digest("hex");
  }

  private audit(event: Omit<AuthenticationAuditEvent, "id" | "createdAt">): void {
    const now = timestamp(this.clock);
    this.database.prepare("INSERT INTO auth_audit(created_at, actor_id, display_name, action, outcome, reason_code, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(now, event.actorId, event.displayName, event.action, event.outcome, event.reasonCode, auditMetadata(event.metadata));
    const cutoff = now - this.config.auditRetentionDays * 86_400_000;
    this.database.prepare("DELETE FROM auth_audit WHERE created_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM auth_audit WHERE id IN (SELECT id FROM auth_audit ORDER BY id DESC LIMIT -1 OFFSET ?)").run(this.config.auditMaxRecords);
  }

  private revokeSession(sessionHash: string, now: number): void {
    this.database.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL").run(now, sessionHash);
  }

  private refreshSession(sessionHash: string, payload: SessionPayload, absoluteExpiresAt: number, now: number): Promise<void> {
    const existing = this.refreshOperations.get(sessionHash);
    if (existing !== undefined) return existing;
    const operation = this.performRefresh(sessionHash, payload, absoluteExpiresAt, now).finally(() => {
      if (this.refreshOperations.get(sessionHash) === operation) this.refreshOperations.delete(sessionHash);
    });
    this.refreshOperations.set(sessionHash, operation);
    return operation;
  }

  private async performRefresh(sessionHash: string, payload: SessionPayload, absoluteExpiresAt: number, now: number): Promise<void> {
    let refreshed: OidcIdentity;
    try {
      refreshed = await this.provider.refresh({ refreshToken: payload.refreshToken, expectedSubject: payload.subject });
    } catch (cause: unknown) {
      if (cause instanceof IdentityProviderUnavailableError) {
        this.audit({ actorId: payload.user.id, displayName: payload.user.displayName, action: "session_refreshed", outcome: "failed", reasonCode: "provider_unavailable", metadata: null });
        throw new AuthenticationError(503, "identity_provider_unavailable", "The identity provider is temporarily unavailable.");
      }
      this.revokeSession(sessionHash, now);
      this.audit({ actorId: payload.user.id, displayName: payload.user.displayName, action: "session_revoked", outcome: "denied", reasonCode: "refresh_rejected", metadata: null });
      throw new AuthenticationError(401, "session_invalid", "The session can no longer be validated.");
    }
    if (refreshed.issuer !== payload.issuer || refreshed.subject !== payload.subject) {
      this.revokeSession(sessionHash, now);
      this.audit({ actorId: payload.user.id, displayName: payload.user.displayName, action: "session_revoked", outcome: "denied", reasonCode: "identity_mismatch", metadata: null });
      throw new AuthenticationError(401, "session_invalid", "The refreshed identity did not match the session.");
    }
    let user: SessionUser;
    let refreshToken: string;
    let authValidUntil: number;
    try {
      user = identityUser(refreshed, this.config);
      refreshToken = refreshed.refreshToken === null ? payload.refreshToken : normalizedClaim(refreshed.refreshToken, "refresh token", 16_384);
      authValidUntil = Math.min(parseExpiry(refreshed.tokenExpiresAt, now), absoluteExpiresAt);
    } catch (cause: unknown) {
      this.revokeSession(sessionHash, now);
      const reasonCode = cause instanceof AuthenticationError ? cause.code : "identity_invalid";
      this.audit({ actorId: payload.user.id, displayName: payload.user.displayName, action: "session_revoked", outcome: "denied", reasonCode, metadata: null });
      if (cause instanceof AuthenticationError) throw cause;
      throw new AuthenticationError(401, "session_invalid", "The refreshed identity is invalid.");
    }
    const nextPayload: SessionPayload = { issuer: payload.issuer, subject: payload.subject, refreshToken, user };
    this.database.prepare("UPDATE auth_sessions SET encrypted_payload = ?, auth_valid_until = ? WHERE id_hash = ? AND revoked_at IS NULL")
      .run(this.protect(nextPayload, "session"), authValidUntil, sessionHash);
    this.audit({ actorId: user.id, displayName: user.displayName, action: "session_refreshed", outcome: "succeeded", reasonCode: "oidc_refresh_validated", metadata: { role: user.role } });
  }

  async startLogin(returnTo: string): Promise<LoginStart> {
    const normalizedReturnTo = safeReturnPath(returnTo, this.config.publicOrigin);
    const now = timestamp(this.clock);
    const transaction = this.opaque("transaction");
    const state = opaqueValue();
    const nonce = opaqueValue();
    const pkceVerifier = opaqueValue();
    const codeChallenge = base64url(createHash("sha256").update(pkceVerifier, "ascii").digest());
    const payload: TransactionPayload = { state, nonce, pkceVerifier, returnTo: normalizedReturnTo };
    this.database.prepare("INSERT INTO auth_transactions(id_hash, state_hash, encrypted_payload, expires_at, consumed_at) VALUES (?, ?, ?, ?, NULL)")
      .run(transaction.hash, createHmac("sha256", this.key(this.activeKeyId)).update(state, "utf8").digest("hex"), this.protect(payload, "transaction"), now + this.config.transactionSeconds * 1000);
    try {
      const authorizationUrl = await this.provider.authorize({
        redirectUri: this.config.redirectUri,
        scopes: this.config.scopes,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod: "S256"
      });
      return { authorizationUrl: authorizationUrl.toString(), transactionCookie: setCookie(TRANSACTION_COOKIE, transaction.value, this.config.transactionSeconds) };
    } catch (cause: unknown) {
      this.database.prepare("DELETE FROM auth_transactions WHERE id_hash = ?").run(transaction.hash);
      this.audit({ actorId: null, displayName: null, action: "login_failed", outcome: "failed", reasonCode: "provider_unavailable", metadata: null });
      if (cause instanceof IdentityProviderUnavailableError) throw new AuthenticationError(503, "identity_provider_unavailable", "The identity provider is temporarily unavailable.");
      throw new AuthenticationError(503, "identity_provider_unavailable", "The identity provider is temporarily unavailable.");
    }
  }

  async completeLogin(input: { readonly callbackUrl: string; readonly cookieHeader: string | null }): Promise<LoginCompletion> {
    const now = timestamp(this.clock);
    const callback = new URL(input.callbackUrl);
    if (`${callback.origin}${callback.pathname}` !== this.config.redirectUri || callback.searchParams.getAll("state").length !== 1 || callback.searchParams.getAll("code").length !== 1 || callback.searchParams.has("error")) {
      this.audit({ actorId: null, displayName: null, action: "login_failed", outcome: "failed", reasonCode: "invalid_callback", metadata: null });
      throw new AuthenticationError(401, "invalid_oidc_callback", "The identity callback is invalid.");
    }
    const transactionCookie = cookiePair(input.cookieHeader, TRANSACTION_COOKIE);
    if (transactionCookie === null) {
      this.audit({ actorId: null, displayName: null, action: "login_failed", outcome: "failed", reasonCode: "invalid_state", metadata: null });
      throw new AuthenticationError(401, "invalid_oidc_state", "The identity transaction is missing or expired.");
    }
    const transactionHash = this.opaqueHash(transactionCookie, "transaction");
    const row = this.database.prepare("SELECT encrypted_payload, state_hash, expires_at, consumed_at FROM auth_transactions WHERE id_hash = ?").get(transactionHash) as unknown as TransactionRow | undefined;
    if (row === undefined || row.consumed_at !== null || safeInteger(row.expires_at, "OIDC transaction expiry") <= now) {
      this.audit({ actorId: null, displayName: null, action: "login_failed", outcome: "failed", reasonCode: "invalid_state", metadata: null });
      throw new AuthenticationError(401, "invalid_oidc_state", "The identity transaction is missing or expired.");
    }
    const transaction = this.unprotect(row.encrypted_payload, "transaction");
    const state = callback.searchParams.get("state") ?? "";
    const stateHash = createHmac("sha256", this.key(transactionCookie.split(".")[0] ?? "")).update(state, "utf8").digest("hex");
    if (!constantEqual(row.state_hash, stateHash) || !constantEqual(transaction.state, state)) {
      this.audit({ actorId: null, displayName: null, action: "login_failed", outcome: "failed", reasonCode: "invalid_state", metadata: null });
      throw new AuthenticationError(401, "invalid_oidc_state", "The identity transaction is invalid.");
    }
    const consumed = this.database.prepare("UPDATE auth_transactions SET consumed_at = ? WHERE id_hash = ? AND consumed_at IS NULL").run(now, transactionHash);
    if (safeInteger(consumed.changes, "Consumed OIDC transaction count") !== 1) {
      this.audit({ actorId: null, displayName: null, action: "login_failed", outcome: "failed", reasonCode: "invalid_state", metadata: null });
      throw new AuthenticationError(401, "invalid_oidc_state", "The identity transaction was already used.");
    }
    let identity: OidcIdentity;
    try {
      identity = await this.provider.callback({
        callbackUrl: callback.toString(),
        redirectUri: this.config.redirectUri,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        pkceVerifier: transaction.pkceVerifier
      });
    } catch (cause: unknown) {
      this.audit({ actorId: null, displayName: null, action: "login_failed", outcome: "failed", reasonCode: cause instanceof IdentityProviderUnavailableError ? "provider_unavailable" : "provider_rejected", metadata: null });
      if (cause instanceof IdentityProviderUnavailableError) throw new AuthenticationError(503, "identity_provider_unavailable", "The identity provider is temporarily unavailable.");
      throw new AuthenticationError(401, "identity_provider_rejected", "The identity provider rejected the login.");
    }
    let user: SessionUser;
    try {
      user = identityUser(identity, this.config);
    } catch (cause: unknown) {
      this.audit({ actorId: null, displayName: null, action: "login_failed", outcome: "denied", reasonCode: cause instanceof AuthenticationError ? cause.code : "identity_invalid", metadata: null });
      throw cause;
    }
    const refreshToken = normalizedClaim(identity.refreshToken, "refresh token", 16_384);
    const authValidUntil = parseExpiry(identity.tokenExpiresAt, now);
    const absoluteExpiresAt = now + this.config.absoluteSeconds * 1000;
    const idleExpiresAt = Math.min(now + this.config.idleSeconds * 1000, absoluteExpiresAt);
    const session = this.opaque("session");
    const sessionPayload: SessionPayload = { issuer: identity.issuer, subject: identity.subject, refreshToken, user };
    this.database.prepare("INSERT INTO auth_sessions(id_hash, encrypted_payload, created_at, idle_expires_at, absolute_expires_at, auth_valid_until, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run(session.hash, this.protect(sessionPayload, "session"), now, idleExpiresAt, absoluteExpiresAt, Math.min(authValidUntil, absoluteExpiresAt));
    this.audit({ actorId: user.id, displayName: user.displayName, action: "login_succeeded", outcome: "succeeded", reasonCode: "oidc_callback_validated", metadata: { role: user.role } });
    return {
      user,
      sessionCookie: setCookie(SESSION_COOKIE, session.value, this.config.absoluteSeconds),
      clearTransactionCookie: clearCookie(TRANSACTION_COOKIE),
      returnTo: transaction.returnTo
    };
  }

  async authenticate(cookieHeader: string | null): Promise<AuthenticatedSession> {
    const sessionCookie = cookiePair(cookieHeader, SESSION_COOKIE);
    if (sessionCookie === null) throw new AuthenticationError(401, "authentication_required", "Authentication is required.");
    let sessionHash: string;
    try {
      sessionHash = this.opaqueHash(sessionCookie, "session");
    } catch {
      throw new AuthenticationError(401, "session_invalid", "The session is invalid.");
    }
    const row = this.database.prepare("SELECT encrypted_payload, idle_expires_at, absolute_expires_at, auth_valid_until, revoked_at FROM auth_sessions WHERE id_hash = ?").get(sessionHash) as unknown as SessionRow | undefined;
    if (row === undefined) throw new AuthenticationError(401, "session_invalid", "The session is invalid.");
    if (row.revoked_at !== null) throw new AuthenticationError(401, "session_revoked", "The session has been revoked.");
    const now = timestamp(this.clock);
    const idleExpiresAt = safeInteger(row.idle_expires_at, "Session idle expiry");
    const absoluteExpiresAt = safeInteger(row.absolute_expires_at, "Session absolute expiry");
    const payload = this.unprotect(row.encrypted_payload, "session");
    if (now >= idleExpiresAt || now >= absoluteExpiresAt) {
      this.database.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL").run(now, sessionHash);
      this.audit({ actorId: payload.user.id, displayName: payload.user.displayName, action: "session_revoked", outcome: "denied", reasonCode: "session_expired", metadata: null });
      throw new AuthenticationError(401, "session_expired", "The session has expired.");
    }
    const authValidUntil = safeInteger(row.auth_valid_until, "Session identity expiry");
    if (now >= authValidUntil) {
      await this.refreshSession(sessionHash, payload, absoluteExpiresAt, now);
      return this.authenticate(cookieHeader);
    }
    const nextIdleExpiry = Math.min(now + this.config.idleSeconds * 1000, absoluteExpiresAt);
    this.database.prepare("UPDATE auth_sessions SET idle_expires_at = ? WHERE id_hash = ?").run(nextIdleExpiry, sessionHash);
    return { user: payload.user, expiresAt: new Date(absoluteExpiresAt).toISOString(), idleExpiresAt: new Date(nextIdleExpiry).toISOString() };
  }

  async logout(cookieHeader: string | null): Promise<LogoutResult> {
    const sessionCookie = cookiePair(cookieHeader, SESSION_COOKIE);
    let user: SessionUser | null = null;
    if (sessionCookie !== null) {
      try {
        const sessionHash = this.opaqueHash(sessionCookie, "session");
        const row = this.database.prepare("SELECT encrypted_payload FROM auth_sessions WHERE id_hash = ?").get(sessionHash) as { readonly encrypted_payload: string } | undefined;
        if (row !== undefined) {
          const payload = this.unprotect(row.encrypted_payload, "session");
          user = payload.user;
          this.database.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL").run(timestamp(this.clock), sessionHash);
        }
      } catch { /* malformed and retired sessions are still cleared locally */ }
    }
    try {
      const providerUrl = await this.provider.logoutUrl(this.config.postLogoutRedirectUri);
      const providerLogoutAvailable = providerUrl !== null;
      this.audit({
        actorId: user?.id ?? null,
        displayName: user?.displayName ?? null,
        action: "logout",
        outcome: "succeeded",
        reasonCode: providerLogoutAvailable ? "local_session_revoked_provider_logout_started" : "local_session_revoked_provider_logout_unsupported",
        metadata: null
      });
      return { clearSessionCookie: clearCookie(SESSION_COOKIE), redirectTo: providerUrl?.toString() ?? this.config.postLogoutRedirectUri, providerLogoutAvailable };
    } catch {
      this.audit({
        actorId: user?.id ?? null,
        displayName: user?.displayName ?? null,
        action: "logout",
        outcome: "succeeded",
        reasonCode: "local_session_revoked_provider_logout_failed",
        metadata: null
      });
      return { clearSessionCookie: clearCookie(SESSION_COOKIE), redirectTo: this.config.postLogoutRedirectUri, providerLogoutAvailable: false };
    }
  }

  recordAuthorizationDenied(user: SessionUser, action: string, reasonCode: string): void {
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(action) || !/^[a-z][a-z0-9_]{0,63}$/u.test(reasonCode)) throw new Error("Authorization audit values are invalid");
    this.audit({ actorId: user.id, displayName: user.displayName, action: "authorization_denied", outcome: "denied", reasonCode, metadata: { action } });
  }

  listAudit(limit: number): readonly AuthenticationAuditEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AuthenticationError(400, "invalid_audit_limit", "Authentication audit limit must be 1 to 100.");
    const rows = this.database.prepare("SELECT id, created_at, actor_id, display_name, action, outcome, reason_code, metadata_json FROM auth_audit ORDER BY id DESC LIMIT ?").all(limit) as unknown as readonly AuditRow[];
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
