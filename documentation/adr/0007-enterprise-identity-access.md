# ADR 0007: Validated Cloudflare Access identity and server-side role enforcement

- Status: Accepted and implemented locally; deployment and human acceptance pending
- Date: 2026-08-16
- Sprint: 7 — Enterprise identity and access

## Context

Cloudflare Access already authenticates users before the `monitor.jefferyhaynes.net` tunnel sends requests to the loopback-only portal. CPQ Demo and CPQ Test have separate Keycloak instances for their own applications; they are not Workspace Monitor identity providers and remain private to those environments.

The deployed Sprint 6 application still attributes incident commands to one configured lab actor. Trusting an unsigned forwarding header would not establish an individual identity or role, but creating a second direct-OIDC login would duplicate the existing Access login and require an unnecessary public Keycloak endpoint.

## Decision

Workspace Monitor consumes the `Cf-Access-Jwt-Assertion` header added by Cloudflare Access and validates it cryptographically on every protected request. The Node API:

- downloads rotating signing keys only from `https://<approved-team>.cloudflareaccess.com/cdn-cgi/access/certs`;
- accepts only `RS256` application tokens;
- validates the exact approved issuer and Workspace Monitor application audience;
- validates signature, expiry, not-before time, bounded clock skew, issue time, and maximum token lifetime;
- requires non-empty `sub` and verified `email` claims;
- rejects organization tokens, service tokens, malformed assertions, and unsupported algorithms;
- never uses the `CF_Authorization` cookie, a browser payload, or an unvalidated forwarding field as identity.

Cloudflare authentication lifecycle, session cookies, policy, tunnel, DNS, and identity-provider configuration remain external. Workspace Monitor implements no OIDC callback, client secret, refresh token, application session cookie, or Keycloak dependency. `/auth/logout` validates the current Access assertion and same-origin browser evidence, audits the action, and redirects to `/cdn-cgi/access/logout`.

## Authorization model

The validated email is matched case-insensitively against one exact entry in a host-provisioned role-mapping file. Wildcards, domain-wide grants, duplicate emails, unknown roles, and unmapped users are rejected. The mapping also supplies a bounded non-sensitive display name. The public actor ID is an opaque hash derived from the validated Access issuer and subject; raw subject and email claims are not returned to the browser or written to audit.

| Role | Server-authorized capability |
| --- | --- |
| Viewer | Read protected monitoring evidence and incident history |
| Operator | Viewer access plus existing approved incident declarations and transitions |
| Administrator | Operator access plus the bounded authentication-audit API |

Administrator does not imply unimplemented identity, settings, integration, retention, or user-management powers. Every mutation derives actor and role from the newly validated request assertion. UI hiding remains only a usability affordance.

## Runtime and audit state

The role mapping is a regular file owned by UID/GID `10001` with mode `0400`, mounted individually at `/run/secrets/cloudflare_access_roles`. It is excluded from Git and deployment archives because it contains personal identity mappings and security policy. The non-secret Access team domain and application audience are stored in the host runtime `.env`.

Authentication and authorization audit history persists in `auth.sqlite`, separate from incident state. It records the opaque actor, configured display name, action, outcome, bounded reason code, and safe metadata. It never records assertions, cookies, email claims, subjects, signing keys, raw provider errors, or protected evidence. Repeated requests using one assertion produce one in-process validation-success audit record; denials, logout, and authorization failures remain explicit. Audit is capped by age and record count.

## Reverse-proxy boundary

Nginx explicitly forwards `Cf-Access-Jwt-Assertion` to the API and its internal authentication subrequest. Pages, static assets, APIs, incident data, and proxied Gatus tools require a validated assertion. `/healthz` remains the only public origin route. The loopback verifier proves missing assertions fail with `401`; through the public hostname Cloudflare Access normally intercepts anonymous users before the origin.

Incident mutations additionally require `Origin` to equal `https://monitor.jefferyhaynes.net` and `Sec-Fetch-Site` to equal `same-origin`. The tunnel remains bound to `127.0.0.1:3100`, limiting direct-origin access. JWT validation is still mandatory and prevents a local caller from gaining identity by fabricating the header.

## Failure behavior

| Condition | Result |
| --- | --- |
| Missing assertion | `401`, no protected evidence |
| Malformed, expired, premature, incorrectly signed, wrong-issuer, wrong-audience, wrong-type, or excessive-lifetime assertion | `401`, bounded error |
| Service or organization assertion | `401`, invalid identity |
| Valid user assertion without an exact role mapping | `403`, role not authorized |
| Signing-key endpoint timeout or transport failure | `503`, no fallback identity |
| Viewer incident mutation or non-administrator audit request | `403`, authorization denial audited |
| Missing or cross-site mutation origin evidence | `403`, authorization denial audited |
| Missing/invalid team domain, audience, mapping file, or audit database configuration | preflight or API startup fails explicitly |

Failures never expose JWTs, cookies, signing keys, claim values, upstream URLs, provider bodies, or protected monitoring evidence. Provider unavailability never restores the Sprint 6 configured actor.

## Measurable acceptance criteria

- Anonymous direct-origin requests cannot access pages, assets, monitoring APIs, incidents, logs, or proxied tools.
- A correctly signed Access application JWT for the exact issuer and audience yields only the configured display name, opaque actor ID, role, and expiry.
- Wrong-key, wrong-audience, wrong-issuer, expired, premature, oversized, service, organization, malformed, and unmapped assertions fail closed.
- Viewers can read evidence and cannot mutate incidents; Operators can perform only existing incident commands; Administrators additionally read bounded authentication audit.
- Every successful incident mutation is attributed to the validated Access identity; browser actor and role fields remain rejected.
- Access signing-key rotation is handled through the remote JWKS set; key-fetch failure returns `503` rather than using stale untrusted identity.
- Cloudflare, CPQ Demo, CPQ Test, and both Keycloak instances remain unmodified.
- Server coverage remains at least 90%, deployment verification proves anonymous fail-closed behavior, and public human acceptance proves the three role mappings.

## Required deployment decisions

Before preflight or deploy, approve and provision outside Git:

1. the exact Cloudflare Access team domain and existing Workspace Monitor application audience tag;
2. exact Viewer, Operator, and Administrator email-to-display-name mappings, with dedicated acceptance identities;
3. ownership, secure transfer, replacement, rollback, and emergency removal of the role-mapping file;
4. the maximum accepted Access token lifetime aligned with the existing application session policy;
5. encrypted backup and retention handling for `auth.sqlite`;
6. explicit deployment authorization and public human acceptance.

Repository scripts do not read Cloudflare credentials and never create or modify Access applications, policies, tunnels, DNS, identity providers, CPQ, or Keycloak.

## Consequences

- Workspace Monitor reuses the existing login boundary without exposing either Keycloak instance or adding another hostname.
- Role changes require an atomic role-mapping replacement and `inventory-api` restart; the next request then uses the new mapping.
- Access availability and its signing-key endpoint are authentication dependencies.
- Cloudflare owns login/session/revocation behavior, while Workspace Monitor owns cryptographic validation, role enforcement, incident attribution, and bounded application audit.
