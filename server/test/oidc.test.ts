import { beforeEach, describe, expect, it, vi } from "vitest";

const oidc = vi.hoisted(() => ({
  authorizationCodeGrant: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  buildEndSessionUrl: vi.fn(),
  clientSecretBasic: vi.fn(),
  discovery: vi.fn(),
  fetchUserInfo: vi.fn(),
  refreshTokenGrant: vi.fn()
}));

vi.mock("openid-client", () => ({
  clockTolerance: Symbol("clockTolerance"),
  ClientSecretBasic: oidc.clientSecretBasic,
  discovery: oidc.discovery,
  buildAuthorizationUrl: oidc.buildAuthorizationUrl,
  authorizationCodeGrant: oidc.authorizationCodeGrant,
  fetchUserInfo: oidc.fetchUserInfo,
  refreshTokenGrant: oidc.refreshTokenGrant,
  buildEndSessionUrl: oidc.buildEndSessionUrl
}));

import { IdentityProviderRejectedError, IdentityProviderUnavailableError } from "../src/auth";
import { DirectOidcProvider, type DirectOidcProviderOptions } from "../src/oidc";

const serverMetadata = { issuer: "https://identity.example.test/realms/lab", end_session_endpoint: "https://identity.example.test/logout" };
const configuration = { serverMetadata: () => serverMetadata };

function provider(overrides: Partial<DirectOidcProviderOptions> = {}): DirectOidcProvider {
  return new DirectOidcProvider({
    issuerUrl: serverMetadata.issuer,
    clientId: "workspace-monitor",
    clientSecret: "server-side-secret",
    clockToleranceSeconds: 60,
    timeoutSeconds: 5,
    ...overrides
  });
}

describe("direct OIDC provider adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oidc.clientSecretBasic.mockReturnValue(() => undefined);
    oidc.discovery.mockResolvedValue(configuration);
    oidc.buildAuthorizationUrl.mockReturnValue(new URL("https://identity.example.test/authorize"));
    oidc.buildEndSessionUrl.mockReturnValue(new URL("https://identity.example.test/logout?client_id=workspace-monitor"));
  });

  it("rejects unsafe issuer, client, secret, clock, and timeout configuration", () => {
    for (const overrides of [
      { issuerUrl: "http://identity.example.test" },
      { issuerUrl: "https://user:password@identity.example.test" },
      { issuerUrl: "https://identity.example.test?tenant=lab" },
      { issuerUrl: "https://identity.example.test#fragment" },
      { clientId: "" },
      { clientId: "x".repeat(257) },
      { clientSecret: "" },
      { clientSecret: "x".repeat(16_385) },
      { clockToleranceSeconds: -1 },
      { clockToleranceSeconds: 121 },
      { clockToleranceSeconds: 1.5 },
      { timeoutSeconds: 0 },
      { timeoutSeconds: 31 },
      { timeoutSeconds: 1.5 }
    ] satisfies readonly Partial<DirectOidcProviderOptions>[]) {
      expect(() => provider(overrides)).toThrow();
    }
  });

  it("builds an authorization-code request with exact redirect, state, nonce, and PKCE S256", async () => {
    await provider().authorize({
      redirectUri: "https://monitor.jefferyhaynes.net/auth/callback",
      scopes: ["openid", "profile"],
      state: "one-use-state",
      nonce: "one-use-nonce",
      codeChallenge: "pkce-challenge",
      codeChallengeMethod: "S256"
    });
    expect(oidc.discovery).toHaveBeenCalledWith(expect.any(URL), "workspace-monitor", expect.objectContaining({ response_types: ["code"] }), expect.any(Function), { timeout: 5 });
    expect(oidc.buildAuthorizationUrl).toHaveBeenCalledWith(configuration, {
      response_type: "code",
      redirect_uri: "https://monitor.jefferyhaynes.net/auth/callback",
      scope: "openid profile",
      state: "one-use-state",
      nonce: "one-use-nonce",
      code_challenge: "pkce-challenge",
      code_challenge_method: "S256"
    });
  });

  it("validates the callback through the library and derives role claims from UserInfo", async () => {
    const tokens = {
      access_token: "access-token",
      refresh_token: "refresh-token",
      claims: () => ({ sub: "subject-123" }),
      expiresIn: () => 600
    };
    oidc.authorizationCodeGrant.mockResolvedValue(tokens);
    oidc.fetchUserInfo.mockResolvedValue({ sub: "subject-123", preferred_username: "jhaynes", groups: ["/workspace-monitor/operator"] });
    const identity = await provider().callback({
      callbackUrl: "https://monitor.jefferyhaynes.net/auth/callback?code=code&state=state",
      redirectUri: "https://monitor.jefferyhaynes.net/auth/callback",
      expectedState: "state",
      expectedNonce: "nonce",
      pkceVerifier: "verifier"
    });
    expect(oidc.authorizationCodeGrant).toHaveBeenCalledWith(configuration, expect.any(URL), {
      expectedState: "state", expectedNonce: "nonce", pkceCodeVerifier: "verifier", idTokenExpected: true
    }, { redirect_uri: "https://monitor.jefferyhaynes.net/auth/callback" });
    expect(oidc.fetchUserInfo).toHaveBeenCalledWith(configuration, "access-token", "subject-123");
    expect(identity).toMatchObject({ issuer: serverMetadata.issuer, subject: "subject-123", refreshToken: "refresh-token" });
  });

  it("rotates refresh credentials when supplied and retains no provider error details", async () => {
    oidc.refreshTokenGrant.mockResolvedValue({ access_token: "next-access", refresh_token: "rotated-refresh", expiresIn: () => 600 });
    oidc.fetchUserInfo.mockResolvedValue({ sub: "subject-123", groups: ["/workspace-monitor/operator"] });
    await expect(provider().refresh({ refreshToken: "old-refresh", expectedSubject: "subject-123" }))
      .resolves.toMatchObject({ refreshToken: "rotated-refresh", subject: "subject-123" });

    oidc.refreshTokenGrant.mockResolvedValueOnce({ access_token: "next-access", expiresIn: () => 600 });
    await expect(provider().refresh({ refreshToken: "old-refresh", expectedSubject: "subject-123" }))
      .resolves.toMatchObject({ refreshToken: null });

    const wrappedNetworkFailure = new Error("client wrapper must not leak", { cause: new TypeError("issuer URL and secret must not leak") });
    wrappedNetworkFailure.name = "ClientError";
    oidc.discovery.mockRejectedValueOnce(wrappedNetworkFailure);
    await expect(provider().authorize({
      redirectUri: "https://monitor.jefferyhaynes.net/auth/callback", scopes: ["openid"], state: "s", nonce: "n", codeChallenge: "c", codeChallengeMethod: "S256"
    })).rejects.toEqual(new IdentityProviderUnavailableError());

    oidc.discovery.mockRejectedValueOnce(Object.assign(new Error("provider body must not leak"), { code: "temporarily_unavailable" }));
    await expect(provider().authorize({
      redirectUri: "https://monitor.jefferyhaynes.net/auth/callback", scopes: ["openid"], state: "s", nonce: "n", codeChallenge: "c", codeChallengeMethod: "S256"
    })).rejects.toEqual(new IdentityProviderUnavailableError());

    oidc.discovery.mockResolvedValueOnce(configuration);
    oidc.authorizationCodeGrant.mockRejectedValueOnce(new Error("invalid_grant with secret details"));
    await expect(provider().callback({
      callbackUrl: "https://monitor.jefferyhaynes.net/auth/callback?code=x&state=y", redirectUri: "https://monitor.jefferyhaynes.net/auth/callback",
      expectedState: "y", expectedNonce: "n", pkceVerifier: "v"
    })).rejects.toEqual(new IdentityProviderRejectedError());
  });

  it("rejects missing tokens, subjects, and invalid provider expiration", async () => {
    const invalidTokens = [
      { access_token: "access", refresh_token: "refresh", claims: () => undefined, expiresIn: () => 600 },
      { access_token: "", refresh_token: "refresh", claims: () => ({ sub: "subject-123" }), expiresIn: () => 600 },
      { access_token: "access", refresh_token: "", claims: () => ({ sub: "subject-123" }), expiresIn: () => 600 },
      { access_token: "access", refresh_token: "refresh", claims: () => ({ sub: "subject-123" }), expiresIn: () => undefined },
      { access_token: "access", refresh_token: "refresh", claims: () => ({ sub: "subject-123" }), expiresIn: () => Number.NaN },
      { access_token: "access", refresh_token: "refresh", claims: () => ({ sub: "subject-123" }), expiresIn: () => 0 }
    ];
    oidc.fetchUserInfo.mockResolvedValue({ sub: "subject-123", groups: ["/workspace-monitor/operator"] });
    for (const tokens of invalidTokens) {
      oidc.authorizationCodeGrant.mockResolvedValueOnce(tokens);
      await expect(provider().callback({
        callbackUrl: "https://monitor.jefferyhaynes.net/auth/callback?code=x&state=y",
        redirectUri: "https://monitor.jefferyhaynes.net/auth/callback",
        expectedState: "y",
        expectedNonce: "n",
        pkceVerifier: "v"
      })).rejects.toEqual(new IdentityProviderRejectedError());
    }
  });

  it("builds provider logout without placing an ID token in the browser URL", async () => {
    const url = await provider().logoutUrl("https://monitor.jefferyhaynes.net/");
    expect(oidc.buildEndSessionUrl).toHaveBeenCalledWith(configuration, { post_logout_redirect_uri: "https://monitor.jefferyhaynes.net/" });
    expect(url?.searchParams.has("id_token_hint")).toBe(false);

    oidc.discovery.mockResolvedValueOnce({ serverMetadata: () => ({ issuer: serverMetadata.issuer }) });
    await expect(provider().logoutUrl("https://monitor.jefferyhaynes.net/")).resolves.toBeNull();

    oidc.discovery.mockRejectedValueOnce(new Error("invalid logout metadata"));
    await expect(provider().logoutUrl("https://monitor.jefferyhaynes.net/")).rejects.toEqual(new IdentityProviderRejectedError());

    oidc.discovery.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "OAUTH_TIMEOUT" }));
    await expect(provider().logoutUrl("https://monitor.jefferyhaynes.net/")).rejects.toEqual(new IdentityProviderUnavailableError());
  });
});
