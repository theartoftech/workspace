import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  AuthenticationService,
  IdentityProviderUnavailableError,
  parseSessionKeyringJson,
  type AuthenticationConfig,
  type OidcAuthorizationRequest,
  type OidcCallbackRequest,
  type OidcIdentity,
  type OidcProvider,
  type OidcRefreshRequest,
  type SessionKeyring
} from "../src/auth";

const keyring: SessionKeyring = {
  activeKeyId: "2026-08",
  keys: [{ id: "2026-08", secret: Buffer.alloc(32, 7) }]
};

const config: AuthenticationConfig = {
  publicOrigin: "https://monitor.jefferyhaynes.net",
  redirectUri: "https://monitor.jefferyhaynes.net/auth/callback",
  postLogoutRedirectUri: "https://monitor.jefferyhaynes.net/",
  scopes: ["openid", "profile"],
  roleClaim: "groups",
  displayNameClaim: "preferred_username",
  groups: {
    viewer: "/workspace-monitor/viewer",
    operator: "/workspace-monitor/operator",
    administrator: "/workspace-monitor/administrator"
  },
  idleSeconds: 3600,
  absoluteSeconds: 43_200,
  transactionSeconds: 600,
  auditRetentionDays: 180,
  auditMaxRecords: 100_000
};

class FakeOidcProvider implements OidcProvider {
  authorizationRequests: OidcAuthorizationRequest[] = [];
  callbackRequests: OidcCallbackRequest[] = [];
  refreshRequests: OidcRefreshRequest[] = [];
  identity: OidcIdentity = {
    issuer: "https://identity.example.test/realms/lab",
    subject: "subject-123",
    claims: {
      preferred_username: "jhaynes",
      groups: ["/workspace-monitor/viewer", "/workspace-monitor/operator"]
    },
    refreshToken: "refresh-token-must-stay-encrypted",
    tokenExpiresAt: "2026-08-16T12:30:00.000Z"
  };
  refreshFailure: Error | null = null;
  refreshDelay: Promise<void> | null = null;
  authorizeFailure: Error | null = null;
  callbackFailure: Error | null = null;
  logoutResult: URL | null = new URL("https://identity.example.test/logout");
  logoutFailure: Error | null = null;
  refreshTokenExpiresAt = "2026-08-16T14:00:00.000Z";

  authorize(request: OidcAuthorizationRequest): Promise<URL> {
    this.authorizationRequests.push(request);
    if (this.authorizeFailure !== null) return Promise.reject(this.authorizeFailure);
    const url = new URL("https://identity.example.test/authorize");
    url.searchParams.set("state", request.state);
    url.searchParams.set("nonce", request.nonce);
    url.searchParams.set("code_challenge", request.codeChallenge);
    return Promise.resolve(url);
  }

  callback(request: OidcCallbackRequest): Promise<OidcIdentity> {
    this.callbackRequests.push(request);
    if (this.callbackFailure !== null) return Promise.reject(this.callbackFailure);
    return Promise.resolve(this.identity);
  }

  async refresh(request: OidcRefreshRequest): Promise<OidcIdentity> {
    this.refreshRequests.push(request);
    if (this.refreshDelay !== null) await this.refreshDelay;
    if (this.refreshFailure !== null) throw this.refreshFailure;
    return { ...this.identity, tokenExpiresAt: this.refreshTokenExpiresAt };
  }

  logoutUrl(postLogoutRedirectUri: string): Promise<URL | null> {
    if (this.logoutFailure !== null) return Promise.reject(this.logoutFailure);
    if (this.logoutResult === null) return Promise.resolve(null);
    const url = new URL(this.logoutResult);
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
    return Promise.resolve(url);
  }
}

function cookieValue(setCookie: string): string {
  const pair = setCookie.split(";", 1)[0];
  if (pair === undefined) throw new Error("Set-Cookie did not contain a cookie pair");
  return pair;
}

function service(options: {
  readonly provider?: FakeOidcProvider;
  readonly now?: { value: Date };
  readonly databasePath?: string;
  readonly configuration?: AuthenticationConfig;
  readonly sessionKeyring?: SessionKeyring;
} = {}): { readonly auth: AuthenticationService; readonly provider: FakeOidcProvider; readonly now: { value: Date } } {
  const provider = options.provider ?? new FakeOidcProvider();
  const now = options.now ?? { value: new Date("2026-08-16T12:00:00.000Z") };
  const auth = new AuthenticationService({
    config: options.configuration ?? config,
    databasePath: options.databasePath ?? ":memory:",
    keyring: options.sessionKeyring ?? keyring,
    provider,
    clock: () => now.value
  });
  return { auth, provider, now };
}

async function signedIn(options: { readonly groups?: readonly string[]; readonly databasePath?: string; readonly configuration?: AuthenticationConfig } = {}): Promise<{
  readonly auth: AuthenticationService;
  readonly provider: FakeOidcProvider;
  readonly now: { value: Date };
  readonly sessionCookie: string;
}> {
  const instance = service({ databasePath: options.databasePath, configuration: options.configuration });
  if (options.groups !== undefined) {
    instance.provider.identity = {
      ...instance.provider.identity,
      claims: { ...instance.provider.identity.claims, groups: options.groups }
    };
  }
  const login = await instance.auth.startLogin("/incidents?status=active");
  const state = new URL(login.authorizationUrl).searchParams.get("state");
  if (state === null) throw new Error("Fake provider did not receive state");
  const complete = await instance.auth.completeLogin({
    callbackUrl: `${config.redirectUri}?code=one-use-code&state=${encodeURIComponent(state)}`,
    cookieHeader: cookieValue(login.transactionCookie)
  });
  return { ...instance, sessionCookie: cookieValue(complete.sessionCookie) };
}

describe("enterprise authentication and session lifecycle", () => {
  it("parses a strict versioned runtime keyring without accepting unknown or malformed keys", () => {
    const parsed = parseSessionKeyringJson(JSON.stringify({
      version: 1,
      activeKeyId: "current",
      keys: [
        { id: "current", secret: Buffer.alloc(32, 1).toString("base64url") },
        { id: "previous", secret: Buffer.alloc(32, 2).toString("base64url") }
      ]
    }));
    expect(parsed).toMatchObject({ activeKeyId: "current", keys: [{ id: "current" }, { id: "previous" }] });
    expect(() => parseSessionKeyringJson("not-json")).toThrow("Session keyring is not valid JSON");
    expect(() => parseSessionKeyringJson("[]")).toThrow("Session keyring must be a JSON object");
    expect(() => parseSessionKeyringJson(JSON.stringify({ version: 2, activeKeyId: "current", keys: [] }))).toThrow("version 1");
    expect(() => parseSessionKeyringJson(JSON.stringify({ version: 1, activeKeyId: 7, keys: [] }))).toThrow("version 1");
    expect(() => parseSessionKeyringJson(JSON.stringify({ version: 1, activeKeyId: "current", keys: {} }))).toThrow("version 1");
    expect(() => parseSessionKeyringJson(JSON.stringify({ version: 1, activeKeyId: "current", keys: [], extra: true }))).toThrow("Session keyring has unsupported fields");
    expect(() => parseSessionKeyringJson(JSON.stringify({ version: 1, activeKeyId: "current", keys: [null] }))).toThrow("entries must be JSON objects");
    expect(() => parseSessionKeyringJson(JSON.stringify({ version: 1, activeKeyId: "current", keys: [{ id: "current", secret: Buffer.alloc(32).toString("base64url"), extra: true }] }))).toThrow("entry has unsupported fields");
    expect(() => parseSessionKeyringJson(JSON.stringify({ version: 1, activeKeyId: "current", keys: [{ id: 3, secret: Buffer.alloc(32).toString("base64url") }] }))).toThrow("id and secret strings");
    expect(() => parseSessionKeyringJson(JSON.stringify({ version: 1, activeKeyId: "current", keys: [{ id: "current", secret: 3 }] }))).toThrow("id and secret strings");
    expect(() => parseSessionKeyringJson(JSON.stringify({ version: 1, activeKeyId: "current", keys: [{ id: "current", secret: "short" }] }))).toThrow("32-byte");
  });

  it("rejects unsafe authentication configuration and invalid rotation keyrings", () => {
    const invalidConfigurations: readonly AuthenticationConfig[] = [
      { ...config, publicOrigin: "http://monitor.jefferyhaynes.net" },
      { ...config, publicOrigin: "https://monitor.jefferyhaynes.net/path" },
      { ...config, redirectUri: "https://monitor.jefferyhaynes.net/other-callback" },
      { ...config, postLogoutRedirectUri: "https://monitor.jefferyhaynes.net/settings" },
      { ...config, scopes: ["profile"] },
      { ...config, scopes: ["openid", "openid"] },
      { ...config, idleSeconds: 59 },
      { ...config, absoluteSeconds: 604_801 },
      { ...config, transactionSeconds: 60.5 },
      { ...config, auditRetentionDays: 0 },
      { ...config, auditMaxRecords: 99 },
      { ...config, idleSeconds: 3600, absoluteSeconds: 3600 },
      { ...config, groups: { ...config.groups, operator: config.groups.viewer } },
      { ...config, groups: { ...config.groups, viewer: "" } },
      { ...config, groups: { ...config.groups, administrator: "admin\nunsafe" } }
    ];
    for (const configuration of invalidConfigurations) {
      expect(() => service({ configuration })).toThrow();
    }

    const invalidKeyrings: readonly SessionKeyring[] = [
      { activeKeyId: "current", keys: [] },
      { activeKeyId: "current", keys: [
        { id: "current", secret: Buffer.alloc(32) },
        { id: "previous", secret: Buffer.alloc(32, 1) },
        { id: "older", secret: Buffer.alloc(32, 2) }
      ] },
      { activeKeyId: "bad id", keys: [{ id: "bad id", secret: Buffer.alloc(32) }] },
      { activeKeyId: "current", keys: [{ id: "current", secret: Buffer.alloc(31) }] },
      { activeKeyId: "current", keys: [{ id: "current", secret: Buffer.alloc(32) }, { id: "current", secret: Buffer.alloc(32, 1) }] },
      { activeKeyId: "missing", keys: [{ id: "current", secret: Buffer.alloc(32) }] }
    ];
    for (const sessionKeyring of invalidKeyrings) {
      expect(() => service({ sessionKeyring })).toThrow();
    }
  });

  it("creates one-use state, nonce, and PKCE transactions and prevents session fixation", async () => {
    const { auth, provider } = service();
    const login = await auth.startLogin("/incidents?status=active");
    const request = provider.authorizationRequests[0];
    expect(request).toBeDefined();
    expect(request?.state).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(request?.nonce).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(request?.codeChallenge).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(request?.codeChallengeMethod).toBe("S256");
    expect(login.transactionCookie).toContain("__Host-workspace_oidc=");
    expect(login.transactionCookie).toContain("HttpOnly");
    expect(login.transactionCookie).toContain("Secure");
    expect(login.transactionCookie).toContain("SameSite=Lax");

    const state = new URL(login.authorizationUrl).searchParams.get("state");
    const completion = await auth.completeLogin({
      callbackUrl: `${config.redirectUri}?code=one-use-code&state=${encodeURIComponent(state ?? "")}`,
      cookieHeader: cookieValue(login.transactionCookie)
    });
    expect(completion.returnTo).toBe("/incidents?status=active");
    expect(completion.user).toMatchObject({ displayName: "jhaynes", role: "operator" });
    expect(completion.sessionCookie).toContain("__Host-workspace_session=");
    expect(cookieValue(completion.sessionCookie)).not.toBe(cookieValue(login.transactionCookie));
    expect(completion.clearTransactionCookie).toContain("Max-Age=0");
    expect(provider.callbackRequests[0]).toMatchObject({ expectedState: state, expectedNonce: request?.nonce });

    await expect(auth.completeLogin({
      callbackUrl: `${config.redirectUri}?code=replay&state=${encodeURIComponent(state ?? "")}`,
      cookieHeader: cookieValue(login.transactionCookie)
    })).rejects.toMatchObject({ code: "invalid_oidc_state", status: 401 });
    expect(auth.listAudit(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "login_failed", outcome: "failed", reasonCode: "invalid_state" })
    ]));
    auth.close();
  });

  it("audits provider-unavailable login starts without retaining error details", async () => {
    const instance = service();
    instance.provider.authorizeFailure = new IdentityProviderUnavailableError("secret provider detail");
    await expect(instance.auth.startLogin("/")).rejects.toMatchObject({ code: "identity_provider_unavailable", status: 503 });
    expect(instance.auth.listAudit(10)).toEqual([
      expect.objectContaining({ action: "login_failed", outcome: "failed", reasonCode: "provider_unavailable" })
    ]);
    expect(JSON.stringify(instance.auth.listAudit(10))).not.toContain("secret provider detail");
    instance.auth.close();
  });

  it("rejects open redirects and malformed return paths instead of silently falling back", async () => {
    const { auth } = service();
    for (const returnTo of [
      "https://attacker.example/steal",
      "//attacker.example/steal",
      "/\\attacker.example/steal",
      `/${"a".repeat(2048)}`,
      "/settings#fragment",
      "/%",
      "/%2Fattacker.example",
      "/%5Cattacker.example",
      "/line\nbreak",
      "/%0d%0aLocation:%20https://attacker.example",
      "/not-a-workspace-route"
    ]) {
      await expect(auth.startLogin(returnTo)).rejects.toMatchObject({ code: "invalid_return_path", status: 400 });
    }
    await expect(auth.startLogin("/services/cpq-demo?range=6h")).resolves.toMatchObject({ authorizationUrl: expect.any(String) });
    auth.close();
  });

  it("rejects malformed callbacks, missing transactions, state tampering, and provider denial", async () => {
    const invalidCallback = service();
    await expect(invalidCallback.auth.completeLogin({
      callbackUrl: `${config.redirectUri}?error=access_denied&state=x`,
      cookieHeader: null
    })).rejects.toMatchObject({ code: "invalid_oidc_callback", status: 401 });
    await expect(invalidCallback.auth.completeLogin({
      callbackUrl: `${config.redirectUri}?code=x&state=y`,
      cookieHeader: null
    })).rejects.toMatchObject({ code: "invalid_oidc_state", status: 401 });
    await expect(invalidCallback.auth.completeLogin({
      callbackUrl: `${config.redirectUri}?code=x&state=y`,
      cookieHeader: `__Host-workspace_oidc=${keyring.activeKeyId}.${Buffer.alloc(32).toString("base64url")}`
    })).rejects.toMatchObject({ code: "invalid_oidc_state", status: 401 });
    invalidCallback.auth.close();

    for (const failure of [new IdentityProviderUnavailableError("private detail"), new Error("provider rejection detail")]) {
      const instance = service();
      instance.provider.callbackFailure = failure;
      const login = await instance.auth.startLogin("/");
      const state = new URL(login.authorizationUrl).searchParams.get("state") ?? "";
      await expect(instance.auth.completeLogin({
        callbackUrl: `${config.redirectUri}?code=denied&state=${encodeURIComponent(state)}`,
        cookieHeader: cookieValue(login.transactionCookie)
      })).rejects.toMatchObject({
        code: failure instanceof IdentityProviderUnavailableError ? "identity_provider_unavailable" : "identity_provider_rejected",
        status: failure instanceof IdentityProviderUnavailableError ? 503 : 401
      });
      expect(JSON.stringify(instance.auth.listAudit(10))).not.toContain("private detail");
      instance.auth.close();
    }

    const tampered = service();
    const login = await tampered.auth.startLogin("/");
    await expect(tampered.auth.completeLogin({
      callbackUrl: `${config.redirectUri}?code=x&state=tampered-state`,
      cookieHeader: cookieValue(login.transactionCookie)
    })).rejects.toMatchObject({ code: "invalid_oidc_state", status: 401 });
    tampered.auth.close();

    const expired = service();
    const expiredLogin = await expired.auth.startLogin("/");
    const expiredState = new URL(expiredLogin.authorizationUrl).searchParams.get("state") ?? "";
    expired.now.value = new Date("2026-08-16T12:10:01.000Z");
    await expect(expired.auth.completeLogin({
      callbackUrl: `${config.redirectUri}?code=x&state=${encodeURIComponent(expiredState)}`,
      cookieHeader: cookieValue(expiredLogin.transactionCookie)
    })).rejects.toMatchObject({ code: "invalid_oidc_state", status: 401 });
    expired.auth.close();
  });

  it("maps exact groups with highest-role precedence and rejects missing role membership", async () => {
    const administrator = await signedIn({ groups: [config.groups.viewer, config.groups.administrator, config.groups.operator] });
    expect((await administrator.auth.authenticate(administrator.sessionCookie)).user.role).toBe("administrator");
    administrator.auth.close();

    const denied = service();
    denied.provider.identity = {
      ...denied.provider.identity,
      claims: { preferred_username: "outsider", groups: ["/unrelated/group"] }
    };
    const login = await denied.auth.startLogin("/");
    const state = new URL(login.authorizationUrl).searchParams.get("state") ?? "";
    await expect(denied.auth.completeLogin({
      callbackUrl: `${config.redirectUri}?code=denied&state=${encodeURIComponent(state)}`,
      cookieHeader: cookieValue(login.transactionCookie)
    })).rejects.toMatchObject({ code: "role_not_authorized", status: 403 });
    denied.auth.close();
  });

  it("rejects missing, malformed, and expired provider identity material", async () => {
    const variants: readonly OidcIdentity[] = [
      { ...new FakeOidcProvider().identity, issuer: "" },
      { ...new FakeOidcProvider().identity, subject: "subject\nunsafe" },
      { ...new FakeOidcProvider().identity, claims: { groups: [config.groups.operator] } },
      { ...new FakeOidcProvider().identity, claims: { preferred_username: "", groups: [config.groups.operator] } },
      { ...new FakeOidcProvider().identity, claims: { preferred_username: "x".repeat(81), groups: [config.groups.operator] } },
      { ...new FakeOidcProvider().identity, claims: { preferred_username: "safe", groups: "not-an-array" } },
      { ...new FakeOidcProvider().identity, claims: { preferred_username: "safe", groups: [7] } },
      { ...new FakeOidcProvider().identity, refreshToken: null },
      { ...new FakeOidcProvider().identity, tokenExpiresAt: "not-a-date" },
      { ...new FakeOidcProvider().identity, tokenExpiresAt: "2026-08-16T11:59:59.000Z" }
    ];
    for (const identity of variants) {
      const instance = service();
      instance.provider.identity = identity;
      const login = await instance.auth.startLogin("/");
      const state = new URL(login.authorizationUrl).searchParams.get("state") ?? "";
      await expect(instance.auth.completeLogin({
        callbackUrl: `${config.redirectUri}?code=invalid-identity&state=${encodeURIComponent(state)}`,
        cookieHeader: cookieValue(login.transactionCookie)
      })).rejects.toBeInstanceOf(AuthenticationError);
      instance.auth.close();
    }
  });

  it("keeps provider tokens and subjects encrypted at rest and returns only safe session identity", async () => {
    const databasePath = `/tmp/workspace-monitor-auth-${crypto.randomUUID()}.sqlite`;
    const signed = await signedIn({ databasePath });
    const session = await signed.auth.authenticate(signed.sessionCookie);
    expect(session.user).toMatchObject({ displayName: "jhaynes", role: "operator" });
    expect(JSON.stringify(session)).not.toContain("refresh-token");
    expect(JSON.stringify(session)).not.toContain("subject-123");

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const stored = JSON.stringify(database.prepare("SELECT * FROM auth_sessions").all());
    database.close();
    expect(stored).not.toContain("refresh-token-must-stay-encrypted");
    expect(stored).not.toContain("subject-123");
    expect(stored).not.toContain("jhaynes");
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
      if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    }
    signed.auth.close();
  });

  it("retains sessions across restart with one previous key and fails closed after key retirement", async () => {
    const databasePath = `/tmp/workspace-monitor-auth-rotation-${crypto.randomUUID()}.sqlite`;
    const oldKey = { id: "old", secret: Buffer.alloc(32, 4) } as const;
    const oldInstance = service({ databasePath, sessionKeyring: { activeKeyId: oldKey.id, keys: [oldKey] } });
    const login = await oldInstance.auth.startLogin("/");
    const state = new URL(login.authorizationUrl).searchParams.get("state") ?? "";
    const completion = await oldInstance.auth.completeLogin({
      callbackUrl: `${config.redirectUri}?code=rotation&state=${encodeURIComponent(state)}`,
      cookieHeader: cookieValue(login.transactionCookie)
    });
    const oldSessionCookie = cookieValue(completion.sessionCookie);
    oldInstance.auth.close();

    const newKey = { id: "new", secret: Buffer.alloc(32, 5) } as const;
    const rotating = service({ databasePath, sessionKeyring: { activeKeyId: newKey.id, keys: [newKey, oldKey] } });
    await expect(rotating.auth.authenticate(oldSessionCookie)).resolves.toMatchObject({ user: { role: "operator" } });
    rotating.auth.close();

    const retired = service({ databasePath, sessionKeyring: { activeKeyId: newKey.id, keys: [newKey] } });
    await expect(retired.auth.authenticate(oldSessionCookie)).rejects.toMatchObject({ code: "session_invalid", status: 401 });
    retired.auth.close();
  });

  it("rejects corrupted encrypted session storage and oversized cookie headers", async () => {
    const databasePath = `/tmp/workspace-monitor-auth-corrupt-${crypto.randomUUID()}.sqlite`;
    const signed = await signedIn({ databasePath });
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE auth_sessions SET encrypted_payload = ?").run("malformed");
    database.close();
    await expect(signed.auth.authenticate(signed.sessionCookie)).rejects.toMatchObject({ code: "session_invalid", status: 401 });
    const tamperedDatabase = new DatabaseSync(databasePath);
    tamperedDatabase.prepare("UPDATE auth_sessions SET encrypted_payload = ?").run("2026-08.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AA");
    tamperedDatabase.close();
    await expect(signed.auth.authenticate(signed.sessionCookie)).rejects.toMatchObject({ code: "session_invalid", status: 401 });
    await expect(signed.auth.authenticate("x".repeat(8193))).rejects.toMatchObject({ code: "authentication_required", status: 401 });
    await expect(signed.auth.authenticate(`other=value; ${signed.sessionCookie}`)).rejects.toMatchObject({ code: "session_invalid", status: 401 });
    signed.auth.close();
  });

  it("refreshes an active session without exposing refresh credentials", async () => {
    const signed = await signedIn();
    signed.now.value = new Date("2026-08-16T12:30:01.000Z");
    const session = await signed.auth.authenticate(signed.sessionCookie);
    expect(session.user.role).toBe("operator");
    expect(signed.provider.refreshRequests).toHaveLength(1);
    expect(signed.provider.refreshRequests[0]).toMatchObject({ refreshToken: "refresh-token-must-stay-encrypted", expectedSubject: "subject-123" });
    signed.auth.close();
  });

  it("coalesces concurrent refreshes so a rotating refresh token is used once", async () => {
    const signed = await signedIn();
    let releaseRefresh: (() => void) | undefined;
    signed.provider.refreshDelay = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    signed.now.value = new Date("2026-08-16T12:30:01.000Z");

    const first = signed.auth.authenticate(signed.sessionCookie);
    const second = signed.auth.authenticate(signed.sessionCookie);
    await Promise.resolve();
    const concurrentRefreshRequests = signed.provider.refreshRequests.length;
    releaseRefresh?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(concurrentRefreshRequests).toBe(1);
    expect(signed.provider.refreshRequests).toHaveLength(1);
    signed.auth.close();
  });

  it("revokes and audits a session when refreshed claims lose their approved role", async () => {
    const signed = await signedIn();
    signed.provider.identity = {
      ...signed.provider.identity,
      claims: { preferred_username: "jhaynes", groups: ["/unrelated/group"] }
    };
    signed.now.value = new Date("2026-08-16T12:30:01.000Z");

    await expect(signed.auth.authenticate(signed.sessionCookie)).rejects.toMatchObject({ code: "role_not_authorized", status: 403 });
    await expect(signed.auth.authenticate(signed.sessionCookie)).rejects.toMatchObject({ code: "session_revoked", status: 401 });
    expect(signed.auth.listAudit(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "session_revoked", outcome: "denied", reasonCode: "role_not_authorized" })
    ]));
    signed.auth.close();
  });

  it("revokes refresh rejection, subject mismatch, and expired refreshed identity", async () => {
    const rejected = await signedIn();
    rejected.provider.refreshFailure = new Error("invalid_grant secret detail");
    rejected.now.value = new Date("2026-08-16T12:30:01.000Z");
    await expect(rejected.auth.authenticate(rejected.sessionCookie)).rejects.toMatchObject({ code: "session_invalid", status: 401 });
    expect(JSON.stringify(rejected.auth.listAudit(20))).not.toContain("invalid_grant secret detail");
    rejected.auth.close();

    const mismatch = await signedIn();
    mismatch.provider.identity = { ...mismatch.provider.identity, subject: "different-subject" };
    mismatch.now.value = new Date("2026-08-16T12:30:01.000Z");
    await expect(mismatch.auth.authenticate(mismatch.sessionCookie)).rejects.toMatchObject({ code: "session_invalid", status: 401 });
    expect(mismatch.auth.listAudit(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "session_revoked", reasonCode: "identity_mismatch" })
    ]));
    mismatch.auth.close();

    const expired = await signedIn();
    expired.provider.refreshTokenExpiresAt = "2026-08-16T12:29:00.000Z";
    expired.now.value = new Date("2026-08-16T12:30:01.000Z");
    await expect(expired.auth.authenticate(expired.sessionCookie)).rejects.toMatchObject({ code: "identity_token_expired", status: 401 });
    expired.auth.close();
  });

  it("fails closed when the provider is unavailable and never extends an expired validation window", async () => {
    const signed = await signedIn();
    signed.provider.refreshFailure = new IdentityProviderUnavailableError("upstream contains secret-token");
    signed.now.value = new Date("2026-08-16T12:30:01.000Z");
    await expect(signed.auth.authenticate(signed.sessionCookie)).rejects.toMatchObject({
      code: "identity_provider_unavailable",
      status: 503,
      message: "The identity provider is temporarily unavailable."
    });
    signed.auth.close();
  });

  it("enforces idle, absolute, revoked, and malformed session failures", async () => {
    const idle = await signedIn();
    idle.now.value = new Date("2026-08-16T13:00:01.000Z");
    await expect(idle.auth.authenticate(idle.sessionCookie)).rejects.toMatchObject({ code: "session_expired", status: 401 });
    expect(idle.auth.listAudit(1)[0]).toMatchObject({
      action: "session_revoked",
      actorId: expect.stringMatching(/^oidc:/u),
      displayName: "jhaynes",
      reasonCode: "session_expired"
    });
    idle.auth.close();

    const absolute = await signedIn({ configuration: { ...config, absoluteSeconds: 7200 } });
    absolute.now.value = new Date("2026-08-16T12:50:00.000Z");
    await expect(absolute.auth.authenticate(absolute.sessionCookie)).resolves.toMatchObject({ user: { role: "operator" } });
    absolute.now.value = new Date("2026-08-16T13:40:00.000Z");
    await expect(absolute.auth.authenticate(absolute.sessionCookie)).resolves.toMatchObject({ expiresAt: "2026-08-16T14:00:00.000Z" });
    absolute.now.value = new Date("2026-08-16T14:00:01.000Z");
    await expect(absolute.auth.authenticate(absolute.sessionCookie)).rejects.toMatchObject({ code: "session_expired", status: 401 });
    absolute.auth.close();

    const revoked = await signedIn();
    const logout = await revoked.auth.logout(revoked.sessionCookie);
    expect(logout.clearSessionCookie).toContain("Max-Age=0");
    expect(logout.redirectTo).toBe("https://identity.example.test/logout?post_logout_redirect_uri=https%3A%2F%2Fmonitor.jefferyhaynes.net%2F");
    await expect(revoked.auth.authenticate(revoked.sessionCookie)).rejects.toMatchObject({ code: "session_revoked", status: 401 });
    await expect(revoked.auth.authenticate("__Host-workspace_session=malformed"))
      .rejects.toBeInstanceOf(AuthenticationError);
    revoked.auth.close();
  });

  it("always clears logout locally when provider logout is absent or unavailable", async () => {
    const noProvider = await signedIn();
    noProvider.provider.logoutResult = null;
    await expect(noProvider.auth.logout(null)).resolves.toMatchObject({
      redirectTo: config.postLogoutRedirectUri,
      providerLogoutAvailable: false,
      clearSessionCookie: expect.stringContaining("Max-Age=0")
    });
    expect(noProvider.auth.listAudit(1)[0]?.reasonCode).toBe("local_session_revoked_provider_logout_unsupported");
    noProvider.auth.close();

    const unavailable = await signedIn();
    unavailable.provider.logoutFailure = new Error("provider secret detail");
    const logout = await unavailable.auth.logout("__Host-workspace_session=malformed");
    expect(logout).toMatchObject({ redirectTo: config.postLogoutRedirectUri, providerLogoutAvailable: false });
    expect(unavailable.auth.listAudit(1)[0]?.reasonCode).toBe("local_session_revoked_provider_logout_failed");
    expect(JSON.stringify(unavailable.auth.listAudit(20))).not.toContain("provider secret detail");
    unavailable.auth.close();
  });

  it("writes bounded secret-free authentication and authorization audit history", async () => {
    const signed = await signedIn();
    const session = await signed.auth.authenticate(signed.sessionCookie);
    signed.auth.recordAuthorizationDenied(session.user, "incident.transition", "insufficient_role");
    const events = signed.auth.listAudit(100);
    expect(events.map((event) => event.action)).toEqual(expect.arrayContaining(["login_succeeded", "authorization_denied"]));
    expect(events.every((event) => event.metadata === null || !JSON.stringify(event.metadata).includes("token"))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("subject-123");
    expect(JSON.stringify(events)).not.toContain("refresh-token");
    expect(() => signed.auth.recordAuthorizationDenied(session.user, "Invalid action", "insufficient_role")).toThrow("Authorization audit values");
    expect(() => signed.auth.recordAuthorizationDenied(session.user, "incident.transition", "Invalid reason")).toThrow("Authorization audit values");
    expect(() => signed.auth.listAudit(0)).toThrow("1 to 100");
    expect(() => signed.auth.listAudit(101)).toThrow("1 to 100");
    expect(() => signed.auth.listAudit(1.5)).toThrow("1 to 100");
    signed.auth.close();
  });
});
