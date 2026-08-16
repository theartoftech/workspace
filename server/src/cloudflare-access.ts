import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey
} from "jose";

import {
  IdentityAssertionRejectedError,
  IdentityProviderUnavailableError,
  type CloudflareAccessIdentity,
  type CloudflareAccessVerifier
} from "./auth";

export interface CloudflareAccessJwtVerifierOptions {
  readonly teamDomain: string;
  readonly audience: string;
  readonly clockToleranceSeconds: number;
  readonly maxTokenLifetimeSeconds: number;
  readonly timeoutSeconds: number;
  readonly clock?: () => Date;
  readonly keyResolver?: () => JWTVerifyGetKey;
}

function printable(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

function safeTeamDomain(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloudflare Access team domain must be an HTTPS cloudflareaccess.com origin");
  }
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || !url.hostname.endsWith(".cloudflareaccess.com")) {
    throw new Error("Cloudflare Access team domain must be an HTTPS cloudflareaccess.com origin");
  }
  return url;
}

function transportFailure(cause: unknown): boolean {
  return cause instanceof TypeError || cause instanceof errors.JWKSTimeout;
}

export class CloudflareAccessJwtVerifier implements CloudflareAccessVerifier {
  private readonly options: CloudflareAccessJwtVerifierOptions;
  private readonly keys: JWTVerifyGetKey;
  private readonly clock: () => Date;

  constructor(options: CloudflareAccessJwtVerifierOptions) {
    const teamDomain = safeTeamDomain(options.teamDomain);
    if (!/^[A-Za-z0-9_-]{16,256}$/u.test(options.audience)) throw new Error("Cloudflare Access audience must be a safe non-empty identifier");
    if (!Number.isInteger(options.clockToleranceSeconds) || options.clockToleranceSeconds < 0 || options.clockToleranceSeconds > 120) {
      throw new Error("Cloudflare Access clock tolerance must be 0 to 120 seconds");
    }
    if (!Number.isInteger(options.maxTokenLifetimeSeconds) || options.maxTokenLifetimeSeconds < 60 || options.maxTokenLifetimeSeconds > 2_592_000) {
      throw new Error("Cloudflare Access maximum token lifetime must be 60 to 2592000 seconds");
    }
    if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > 30) {
      throw new Error("Cloudflare Access JWKS timeout must be 1 to 30 seconds");
    }
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.keys = options.keyResolver?.() ?? createRemoteJWKSet(
      new URL("/cdn-cgi/access/certs", teamDomain),
      { timeoutDuration: options.timeoutSeconds * 1000 }
    );
  }

  async verify(assertion: string): Promise<CloudflareAccessIdentity> {
    try {
      const currentDate = this.clock();
      if (!Number.isFinite(currentDate.getTime())) throw new IdentityAssertionRejectedError();
      const result = await jwtVerify(assertion, this.keys, {
        algorithms: ["RS256"],
        issuer: this.options.teamDomain,
        audience: this.options.audience,
        clockTolerance: this.options.clockToleranceSeconds,
        currentDate
      });
      const { payload } = result;
      if (payload.type !== "app" || payload.service_token_id !== undefined || !printable(payload.sub, 512) || !printable(payload.email, 254)) {
        throw new IdentityAssertionRejectedError();
      }
      if (!/^[^\s@]+@[^\s@]+$/u.test(payload.email) || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) {
        throw new IdentityAssertionRejectedError();
      }
      const issuedAt = payload.iat as number;
      const expiresAt = payload.exp as number;
      const nowSeconds = Math.floor(currentDate.getTime() / 1000);
      if (issuedAt > nowSeconds + this.options.clockToleranceSeconds || expiresAt <= issuedAt || expiresAt - issuedAt > this.options.maxTokenLifetimeSeconds) {
        throw new IdentityAssertionRejectedError();
      }
      return {
        issuer: this.options.teamDomain,
        subject: payload.sub,
        email: payload.email,
        issuedAt: new Date(issuedAt * 1000).toISOString(),
        expiresAt: new Date(expiresAt * 1000).toISOString()
      };
    } catch (cause: unknown) {
      if (cause instanceof IdentityProviderUnavailableError || transportFailure(cause)) throw new IdentityProviderUnavailableError();
      throw new IdentityAssertionRejectedError();
    }
  }
}
