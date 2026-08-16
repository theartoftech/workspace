import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  AccessAuthenticationService,
  AuthenticationError,
  IdentityAssertionRejectedError,
  IdentityProviderUnavailableError,
  parseAccessRoleMappingJson,
  type CloudflareAccessIdentity,
  type CloudflareAccessVerifier
} from "../src/auth";

const config = {
  publicOrigin: "https://monitor.jefferyhaynes.net",
  teamDomain: "https://lab.cloudflareaccess.com",
  auditRetentionDays: 180,
  auditMaxRecords: 100
} as const;

const mappingSource = JSON.stringify({
  version: 1,
  identities: [
    { email: "viewer@example.test", displayName: "Read Only", role: "viewer" },
    { email: "operator@example.test", displayName: "Lab Operator", role: "operator" },
    { email: "administrator@example.test", displayName: "Lab Admin", role: "administrator" }
  ]
});

class FakeVerifier implements CloudflareAccessVerifier {
  identity: CloudflareAccessIdentity = {
    issuer: config.teamDomain,
    subject: "subject-operator",
    email: "operator@example.test",
    issuedAt: "2026-08-16T11:59:00.000Z",
    expiresAt: "2026-08-16T13:00:00.000Z"
  };
  failure: Error | null = null;

  verify(): Promise<CloudflareAccessIdentity> {
    return this.failure === null ? Promise.resolve(this.identity) : Promise.reject(this.failure);
  }
}

function service(overrides: {
  readonly mappingSource?: string;
  readonly databasePath?: string;
  readonly clock?: () => Date;
} = {}): { readonly auth: AccessAuthenticationService; readonly verifier: FakeVerifier } {
  const verifier = new FakeVerifier();
  const auth = new AccessAuthenticationService({
    config,
    databasePath: overrides.databasePath ?? ":memory:",
    roleMapping: parseAccessRoleMappingJson(overrides.mappingSource ?? mappingSource),
    verifier,
    clock: overrides.clock ?? (() => new Date("2026-08-16T12:00:00.000Z"))
  });
  return { auth, verifier };
}

describe("Cloudflare Access authentication service", () => {
  it("strictly parses exact host-provisioned identity mappings", () => {
    expect(parseAccessRoleMappingJson(mappingSource)).toEqual({
      version: 1,
      identities: [
        { email: "viewer@example.test", displayName: "Read Only", role: "viewer" },
        { email: "operator@example.test", displayName: "Lab Operator", role: "operator" },
        { email: "administrator@example.test", displayName: "Lab Admin", role: "administrator" }
      ]
    });

    const invalid = [
      "not json",
      "[]",
      '{"version":2,"identities":[]}',
      '{"version":1,"identities":[],"extra":true}',
      '{"version":1,"identities":[]}',
      `{"version":1,"identities":[${Array.from({ length: 101 }, () => '{"email":"user@example.test","displayName":"User","role":"viewer"}').join(",")}]}`,
      '{"version":1,"identities":[null]}',
      '{"version":1,"identities":[{"email":42,"displayName":"User","role":"viewer"}]}',
      '{"version":1,"identities":[{"email":"user@example.test","displayName":42,"role":"viewer"}]}',
      '{"version":1,"identities":[{"email":"*@example.test","displayName":"Wildcard","role":"viewer"}]}',
      '{"version":1,"identities":[{"email":"user@example.test","displayName":"","role":"viewer"}]}',
      '{"version":1,"identities":[{"email":"user@example.test","displayName":"User","role":"owner"}]}',
      '{"version":1,"identities":[{"email":"same@example.test","displayName":"One","role":"viewer"},{"email":"SAME@example.test","displayName":"Two","role":"operator"}]}',
      '{"version":1,"identities":[{"email":"user@example.test","displayName":"User","role":"viewer","extra":true}]}'
    ];
    for (const source of invalid) expect(() => parseAccessRoleMappingJson(source)).toThrow();
  });

  it("derives an opaque actor and exact role from a validated Access identity", async () => {
    const { auth } = service();
    const session = await auth.authenticate("signed-access-assertion");
    expect(session).toEqual({
      user: { id: expect.stringMatching(/^access:[0-9a-f]{32}$/u), displayName: "Lab Operator", role: "operator" },
      expiresAt: "2026-08-16T13:00:00.000Z"
    });
    expect(JSON.stringify(session)).not.toMatch(/operator@example|subject-operator|signed-access/iu);
    expect(auth.listAudit(10)).toEqual([
      expect.objectContaining({ action: "identity_validated", outcome: "succeeded", reasonCode: "cloudflare_access_jwt_validated", metadata: { role: "operator" } })
    ]);
    auth.close();
  });

  it("matches verified email case-insensitively without accepting wildcards", async () => {
    const { auth, verifier } = service();
    verifier.identity = { ...verifier.identity, email: "OPERATOR@EXAMPLE.TEST" };
    await expect(auth.authenticate("assertion")).resolves.toMatchObject({ user: { role: "operator" } });
    verifier.identity = { ...verifier.identity, email: "outsider@example.test", subject: "outsider" };
    await expect(auth.authenticate("assertion-two")).rejects.toMatchObject({ status: 403, code: "role_not_authorized" });
    auth.close();
  });

  it("fails closed for missing, rejected, unavailable, or mismatched identities", async () => {
    const { auth, verifier } = service();
    await expect(auth.authenticate(null)).rejects.toMatchObject({ status: 401, code: "authentication_required" });

    verifier.failure = new IdentityAssertionRejectedError("private JWT detail");
    await expect(auth.authenticate("invalid")).rejects.toMatchObject({ status: 401, code: "invalid_access_identity" });
    verifier.failure = new IdentityProviderUnavailableError("private JWKS detail");
    await expect(auth.authenticate("valid-looking")).rejects.toMatchObject({ status: 503, code: "identity_provider_unavailable" });
    verifier.failure = null;
    verifier.identity = { ...verifier.identity, issuer: "https://other.cloudflareaccess.com" };
    await expect(auth.authenticate("assertion-three")).rejects.toMatchObject({ status: 401, code: "invalid_access_identity" });

    const serialized = JSON.stringify(auth.listAudit(20));
    expect(serialized).not.toMatch(/private JWT|private JWKS|valid-looking|assertion-three/iu);
    auth.close();
  });

  it("rejects oversized, malformed-time, expired, and invalid-email verified identities", async () => {
    const { auth, verifier } = service();
    await expect(auth.authenticate("x".repeat(16_385))).rejects.toMatchObject({ code: "invalid_access_identity" });
    for (const identity of [
      { ...verifier.identity, issuedAt: "not-a-date" },
      { ...verifier.identity, expiresAt: "not-a-date" },
      { ...verifier.identity, expiresAt: "2026-08-16T11:59:59.000Z" },
      { ...verifier.identity, issuedAt: "2026-08-16T13:00:00.000Z", expiresAt: "2026-08-16T12:30:00.000Z" },
      { ...verifier.identity, email: "not-an-email" }
    ]) {
      verifier.identity = identity;
      await expect(auth.authenticate(`assertion-${identity.issuedAt}-${identity.expiresAt}-${identity.email}`)).rejects.toBeInstanceOf(AuthenticationError);
    }
    auth.close();
  });

  it("does not duplicate successful audit records for repeated use of one assertion", async () => {
    const { auth } = service();
    await auth.authenticate("same-assertion");
    await auth.authenticate("same-assertion");
    expect(auth.listAudit(20).filter((event) => event.action === "identity_validated")).toHaveLength(1);
    auth.close();
  });

  it("forgets expired assertion fingerprints while preserving current identity validation", async () => {
    let now = new Date("2026-08-16T12:00:00.000Z");
    const { auth, verifier } = service({ clock: () => now });
    verifier.identity = { ...verifier.identity, expiresAt: "2026-08-16T12:01:00.000Z" };
    await auth.authenticate("first-assertion");
    now = new Date("2026-08-16T12:02:00.000Z");
    verifier.identity = { ...verifier.identity, expiresAt: "2026-08-16T13:00:00.000Z" };
    await auth.authenticate("second-assertion");
    expect(auth.listAudit(10).filter((event) => event.action === "identity_validated")).toHaveLength(2);
    auth.close();
  });

  it("records bounded authorization denial and Cloudflare logout audit", async () => {
    const { auth } = service();
    const session = await auth.authenticate("assertion");
    auth.recordAuthorizationDenied(session.user, "incident.mutate", "insufficient_role");
    const logout = auth.recordLogout(session.user);
    expect(logout).toEqual({ redirectTo: "/cdn-cgi/access/logout" });
    expect(auth.listAudit(10).map((event) => event.action)).toEqual(["logout", "authorization_denied", "identity_validated"]);
    auth.close();
  });

  it("persists bounded audit history and rejects unsafe service configuration", async () => {
    const databasePath = `/tmp/workspace-monitor-access-auth-${process.pid}-${Date.now()}.sqlite`;
    const instance = service({ databasePath });
    await instance.auth.authenticate("assertion");
    instance.auth.close();
    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_audit").get()).toEqual({ count: 1 });
    database.close();

    const invalidConfigs = [
      { ...config, publicOrigin: "http://monitor.jefferyhaynes.net" },
      { ...config, teamDomain: "not-a-url" },
      { ...config, teamDomain: "https://attacker.example" },
      { ...config, auditRetentionDays: 0 },
      { ...config, auditMaxRecords: 99 }
    ];
    for (const invalidConfig of invalidConfigs) {
      expect(() => new AccessAuthenticationService({
        config: invalidConfig,
        databasePath: ":memory:",
        roleMapping: parseAccessRoleMappingJson(mappingSource),
        verifier: new FakeVerifier()
      })).toThrow();
    }
  });

  it("rejects invalid clocks, unsafe audit metadata, and incompatible audit schemas", async () => {
    const invalidClock = service({ clock: () => new Date(Number.NaN) });
    await expect(invalidClock.auth.authenticate(null)).rejects.toThrow("clock");
    invalidClock.auth.close();

    const instance = service();
    const session = await instance.auth.authenticate("assertion");
    expect(() => instance.auth.recordAuthorizationDenied(session.user, "x".repeat(161), "denied")).toThrow("metadata");
    instance.auth.close();

    const databasePath = `/tmp/workspace-monitor-access-schema-${process.pid}-${Date.now()}.sqlite`;
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE access_auth_schema_metadata(version INTEGER NOT NULL); INSERT INTO access_auth_schema_metadata VALUES (2);");
    database.close();
    expect(() => service({ databasePath })).toThrow("schema version");
  });

  it("returns explicit service errors rather than null or silent fallbacks", () => {
    expect(new AuthenticationError(401, "test", "message")).toMatchObject({ status: 401, code: "test", message: "message" });
  });
});
