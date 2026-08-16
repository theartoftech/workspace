// @vitest-environment node

import { SignJWT, createLocalJWKSet, errors, exportJWK, generateKeyPair, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { IdentityAssertionRejectedError, IdentityProviderUnavailableError } from "../src/auth";
import { CloudflareAccessJwtVerifier, type CloudflareAccessJwtVerifierOptions } from "../src/cloudflare-access";

const now = new Date("2026-08-16T12:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  keyResolver = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "access-key", alg: "RS256", use: "sig" }] } satisfies JSONWebKeySet);
});

const options: CloudflareAccessJwtVerifierOptions = {
  teamDomain: "https://lab.cloudflareaccess.com",
  audience: "a".repeat(64),
  clockToleranceSeconds: 60,
  maxTokenLifetimeSeconds: 86_400,
  timeoutSeconds: 5,
  clock: () => now,
  keyResolver: () => keyResolver
};

async function assertion(overrides: Readonly<Record<string, unknown>> = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    iss: options.teamDomain,
    aud: [options.audience],
    sub: "access-subject-123",
    email: "operator@example.test",
    type: "app",
    iat: nowSeconds - 60,
    nbf: nowSeconds - 60,
    exp: nowSeconds + 3600,
    ...overrides
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "access-key", typ: "JWT" })
    .sign(privateKey);
}

describe("Cloudflare Access JWT verifier", () => {
  it("cryptographically validates the exact application identity", async () => {
    const verifier = new CloudflareAccessJwtVerifier(options);
    await expect(verifier.verify(await assertion())).resolves.toEqual({
      issuer: options.teamDomain,
      subject: "access-subject-123",
      email: "operator@example.test",
      issuedAt: new Date((nowSeconds - 60) * 1000).toISOString(),
      expiresAt: new Date((nowSeconds + 3600) * 1000).toISOString()
    });
  });

  it("rejects malformed, incorrectly signed, and claim-tampered assertions", async () => {
    const verifier = new CloudflareAccessJwtVerifier(options);
    const invalidClaims = [
      { iss: "https://other.cloudflareaccess.com" },
      { aud: ["b".repeat(64)] },
      { sub: "" },
      { email: "not-an-email" },
      { type: "org" },
      { service_token_id: "service-token" },
      { iat: nowSeconds + 120 },
      { exp: nowSeconds - 120 },
      { exp: nowSeconds + 86_500 },
      { iat: undefined },
      { exp: undefined }
    ];
    for (const claims of invalidClaims) {
      await expect(verifier.verify(await assertion(claims))).rejects.toBeInstanceOf(IdentityAssertionRejectedError);
    }
    await expect(verifier.verify("not-a-jwt")).rejects.toBeInstanceOf(IdentityAssertionRejectedError);

    const otherPair = await generateKeyPair("RS256", { modulusLength: 2048 });
    const wrongSignature = await new SignJWT({ iss: options.teamDomain, aud: [options.audience], sub: "x", email: "x@example.test", type: "app", iat: nowSeconds, exp: nowSeconds + 300 })
      .setProtectedHeader({ alg: "RS256", kid: "access-key" })
      .sign(otherPair.privateKey);
    await expect(verifier.verify(wrongSignature)).rejects.toBeInstanceOf(IdentityAssertionRejectedError);
  });

  it("classifies JWKS transport failure as unavailable without leaking details", async () => {
    const verifier = new CloudflareAccessJwtVerifier({
      ...options,
      keyResolver: () => (() => Promise.reject(new TypeError("private upstream detail")))
    });
    await expect(verifier.verify(await assertion())).rejects.toEqual(new IdentityProviderUnavailableError());
    for (const failure of [new errors.JWKSTimeout(), new IdentityProviderUnavailableError("private")]) {
      const failing = new CloudflareAccessJwtVerifier({ ...options, keyResolver: () => (() => Promise.reject(failure)) });
      await expect(failing.verify(await assertion())).rejects.toEqual(new IdentityProviderUnavailableError());
    }
  });

  it("rejects invalid verifier clocks and control-character claims", async () => {
    const invalidClock = new CloudflareAccessJwtVerifier({ ...options, clock: () => new Date(Number.NaN) });
    await expect(invalidClock.verify(await assertion())).rejects.toBeInstanceOf(IdentityAssertionRejectedError);
    const verifier = new CloudflareAccessJwtVerifier(options);
    await expect(verifier.verify(await assertion({ sub: "bad\nsubject" }))).rejects.toBeInstanceOf(IdentityAssertionRejectedError);
  });

  it("rejects unsafe verifier configuration", () => {
    const invalid: readonly CloudflareAccessJwtVerifierOptions[] = [
      { ...options, teamDomain: "http://lab.cloudflareaccess.com" },
      { ...options, teamDomain: "not-a-url" },
      { ...options, teamDomain: "https://attacker.example" },
      { ...options, teamDomain: "https://lab.cloudflareaccess.com/path" },
      { ...options, audience: "" },
      { ...options, clockToleranceSeconds: 121 },
      { ...options, timeoutSeconds: 0 },
      { ...options, maxTokenLifetimeSeconds: 59 }
    ];
    for (const value of invalid) expect(() => new CloudflareAccessJwtVerifier(value)).toThrow();
    expect(() => new CloudflareAccessJwtVerifier({ ...options, clock: undefined, keyResolver: undefined })).not.toThrow();
  });
});
