import * as client from "openid-client";

import {
  IdentityProviderRejectedError,
  IdentityProviderUnavailableError,
  type OidcAuthorizationRequest,
  type OidcCallbackRequest,
  type OidcIdentity,
  type OidcProvider,
  type OidcRefreshRequest
} from "./auth";

export interface DirectOidcProviderOptions {
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clockToleranceSeconds: number;
  readonly timeoutSeconds: number;
}

function unavailable(cause: unknown): boolean {
  const unavailableCodes = new Set(["OAUTH_TIMEOUT", "OAUTH_ABORT", "OAUTH_RESPONSE_IS_NOT_CONFORM", "server_error", "temporarily_unavailable"]);
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    if (current instanceof TypeError || current instanceof DOMException || current instanceof IdentityProviderUnavailableError) return true;
    const value = current as { readonly code?: unknown; readonly cause?: unknown };
    if (typeof value.code === "string" && unavailableCodes.has(value.code)) return true;
    current = value.cause;
  }
  return false;
}

function safeProviderError(cause: unknown): Error {
  return unavailable(cause)
    ? new IdentityProviderUnavailableError()
    : new IdentityProviderRejectedError();
}

function tokenExpiry(tokens: { readonly expiresIn: () => number | undefined }): string {
  const seconds = tokens.expiresIn();
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) throw new IdentityProviderRejectedError();
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function requiredToken(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new IdentityProviderRejectedError();
  return value;
}

export class DirectOidcProvider implements OidcProvider {
  private readonly issuer: URL;
  private readonly options: DirectOidcProviderOptions;
  private configuration: Promise<client.Configuration> | null = null;

  constructor(options: DirectOidcProviderOptions) {
    this.options = options;
    this.issuer = new URL(options.issuerUrl);
    if (this.issuer.protocol !== "https:" || this.issuer.username !== "" || this.issuer.password !== "" || this.issuer.search !== "" || this.issuer.hash !== "") {
      throw new Error("OIDC issuer must be an HTTPS URL without credentials, query, or fragment");
    }
    if (options.clientId.trim() === "" || options.clientId.length > 256) throw new Error("OIDC clientId must contain 1 to 256 characters");
    if (options.clientSecret.trim() === "" || options.clientSecret.length > 16_384) throw new Error("OIDC client secret file is empty or too large");
    if (!Number.isInteger(options.clockToleranceSeconds) || options.clockToleranceSeconds < 0 || options.clockToleranceSeconds > 120) throw new Error("OIDC clock tolerance must be 0 to 120 seconds");
    if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > 30) throw new Error("OIDC timeout must be 1 to 30 seconds");
  }

  private async configurationValue(): Promise<client.Configuration> {
    if (this.configuration === null) {
      const metadata: Partial<client.ClientMetadata> = {
        client_secret: this.options.clientSecret,
        response_types: ["code"],
        [client.clockTolerance]: this.options.clockToleranceSeconds
      };
      this.configuration = client.discovery(
        this.issuer,
        this.options.clientId,
        metadata,
        client.ClientSecretBasic(this.options.clientSecret),
        { timeout: this.options.timeoutSeconds }
      ).catch((cause: unknown) => {
        this.configuration = null;
        throw safeProviderError(cause);
      });
    }
    return this.configuration;
  }

  async authorize(request: OidcAuthorizationRequest): Promise<URL> {
    try {
      const configuration = await this.configurationValue();
      return client.buildAuthorizationUrl(configuration, {
        response_type: "code",
        redirect_uri: request.redirectUri,
        scope: request.scopes.join(" "),
        state: request.state,
        nonce: request.nonce,
        code_challenge: request.codeChallenge,
        code_challenge_method: request.codeChallengeMethod
      });
    } catch (cause: unknown) {
      throw safeProviderError(cause);
    }
  }

  async callback(request: OidcCallbackRequest): Promise<OidcIdentity> {
    try {
      const configuration = await this.configurationValue();
      const tokens = await client.authorizationCodeGrant(configuration, new URL(request.callbackUrl), {
        expectedState: request.expectedState,
        expectedNonce: request.expectedNonce,
        pkceCodeVerifier: request.pkceVerifier,
        idTokenExpected: true
      }, { redirect_uri: request.redirectUri });
      const idClaims = tokens.claims();
      const subject = requiredToken(idClaims?.sub);
      const accessToken = requiredToken(tokens.access_token);
      const claims = await client.fetchUserInfo(configuration, accessToken, subject);
      return {
        issuer: requiredToken(configuration.serverMetadata().issuer),
        subject,
        claims,
        refreshToken: requiredToken(tokens.refresh_token),
        tokenExpiresAt: tokenExpiry(tokens)
      };
    } catch (cause: unknown) {
      throw safeProviderError(cause);
    }
  }

  async refresh(request: OidcRefreshRequest): Promise<OidcIdentity> {
    try {
      const configuration = await this.configurationValue();
      const tokens = await client.refreshTokenGrant(configuration, request.refreshToken);
      const accessToken = requiredToken(tokens.access_token);
      const claims = await client.fetchUserInfo(configuration, accessToken, request.expectedSubject);
      return {
        issuer: requiredToken(configuration.serverMetadata().issuer),
        subject: request.expectedSubject,
        claims,
        refreshToken: typeof tokens.refresh_token === "string" && tokens.refresh_token !== "" ? tokens.refresh_token : null,
        tokenExpiresAt: tokenExpiry(tokens)
      };
    } catch (cause: unknown) {
      throw safeProviderError(cause);
    }
  }

  async logoutUrl(postLogoutRedirectUri: string): Promise<URL | null> {
    try {
      const configuration = await this.configurationValue();
      if (configuration.serverMetadata().end_session_endpoint === undefined) return null;
      return client.buildEndSessionUrl(configuration, { post_logout_redirect_uri: postLogoutRedirectUri });
    } catch (cause: unknown) {
      if (unavailable(cause)) throw new IdentityProviderUnavailableError();
      throw new IdentityProviderRejectedError();
    }
  }
}
