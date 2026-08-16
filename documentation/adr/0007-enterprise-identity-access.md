# ADR 0007: Direct OIDC identity and server-side role enforcement

- Status: Accepted and implemented locally; provider registration, deployment, and human acceptance pending
- Date: 2026-08-16
- Sprint: 7 — Enterprise identity and access

## Context

Workspace Monitor previously relied on Cloudflare Access as an external perimeter and attributed every incident mutation to one configured lab actor. That model could not prove which person performed an operation, distinguish read-only users from operators, or enforce application roles at the API boundary. Cloudflare configuration and identity-provider administration are outside this repository, and unvalidated forwarding headers must not become application identity.

## Decision

Workspace Monitor uses direct OIDC Authorization Code flow with PKCE S256. The Node operations API performs discovery, authorization, callback validation, token refresh, UserInfo retrieval, session validation, and logout. It validates state, nonce, the exact callback URI, the PKCE verifier, issuer, subject, token expiry, and the configured role and display-name claims. It requires a refresh token so that a long-running browser session can revalidate identity and role rather than trusting stale claims.

The provider registration must support:

- exact redirect URI `https://monitor.jefferyhaynes.net/auth/callback`;
- post-logout return URI `https://monitor.jefferyhaynes.net/` when provider logout is supported;
- Authorization Code flow, PKCE S256, `client_secret_basic`, ID tokens, refresh tokens, and UserInfo;
- the explicitly approved `openid`-including scope set;
- an explicitly selected display-name claim and a group-valued role claim.

No issuer, client registration, scope set, claim path, or group name is inferred. The runtime must provide distinct exact mappings for Viewer, Operator, and Administrator. If multiple approved groups are present, the highest matching role wins. An identity with no approved group is denied.

## Authorization model

| Role | Server-authorized capability |
| --- | --- |
| Viewer | Read protected monitoring evidence and incident history |
| Operator | Viewer access plus approved incident declarations and transitions |
| Administrator | Operator access plus the bounded authentication-audit API |

There are no general settings, identity, retention, integration, or user-administration mutations in Sprint 7. Administrator does not implicitly authorize an operation that the server has not implemented. Every incident mutation receives its actor ID, display name, and role from the validated session. Browser-supplied actor or role fields are rejected, and UI hiding is only a usability affordance.

## Session and key management

The browser receives only an opaque `__Host-` session cookie. OIDC tokens, provider claims, refresh tokens, state, nonce, and PKCE verifier remain server-side. Authentication transactions and sessions are stored in a dedicated SQLite database using AES-256-GCM encrypted payloads and keyed hashes for opaque identifiers. The database persists across container replacement and restart; it is separate from incident history and is forced to mode `0600`.

The session keyring is a host-provisioned, mode-`0400`, UID/GID `10001` file. It contains one active 32-byte key and, during rotation, at most one previous key. New records use the active key; retaining the immediately previous key permits existing sessions and transactions to survive a controlled rotation and restart. Retiring a key invalidates records encrypted or hashed with it. The default bounds are:

- login transaction: 10 minutes and one use;
- idle session: 60 minutes;
- absolute session: 12 hours;
- OIDC clock tolerance: 60 seconds;
- authentication audit: 180 days and 100,000 records, whichever cap is reached first.

Identity is refreshed when the current provider token lifetime expires. Refresh-token rotation is persisted atomically for the session, and concurrent refreshes for one session are coalesced in-process. A rejected refresh, subject/issuer mismatch, expired response, or lost role revokes the session. Provider unavailability returns `503` and never extends the session or restores the old configured actor.

## Browser and reverse-proxy boundary

All pages, assets, monitoring APIs, and same-origin Gatus proxy routes are protected. `/healthz`, `/auth/login`, `/auth/callback`, and the local logout command are the only authentication bootstrap exceptions. Anonymous pages redirect to login; protected data and tool endpoints return `401` without evidence. The safe session endpoint exposes only the derived user ID, display name, role, and bounded expiry timestamps.

Incident mutations require both an authenticated Operator-or-higher session and exact same-origin browser evidence: `Origin` must equal the configured public origin and `Sec-Fetch-Site` must be `same-origin`. Session cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, use the `__Host-` prefix, and cannot be selected by browser payloads. Successful login rotates from the one-use transaction cookie to a new session identifier. Return paths are limited to known Workspace Monitor routes and service-detail paths, which rejects absolute, scheme-relative, backslash, encoded, fragment, and unknown-route redirects.

Nginx disables callback access logging and raises callback error logging to critical so authorization codes do not enter local proxy logs. The external Cloudflare request-log policy is outside this repository and must be reviewed before deployment because the OIDC response uses a callback query string.

Cloudflare Access remains an independently managed perimeter. Workspace Monitor does not consume or trust Cloudflare Access identity headers, and the repository does not modify Access policy, tunnel, DNS, or provider configuration.

## Failure behavior

| Condition | Result |
| --- | --- |
| No, malformed, revoked, retired-key, idle-expired, or absolute-expired session | `401`, no protected evidence |
| Valid user without the required role | `403`, authorization denial audited |
| Missing or cross-site mutation origin evidence | `403`, authorization denial audited |
| Invalid/replayed state, nonce, PKCE, callback, issuer, subject, or signature | `401`, login/session fails closed |
| Provider timeout, discovery outage, or temporary provider error | `503`, no fallback identity |
| Missing/invalid issuer, client, mapping, secret, keyring, or persistent database configuration | API startup or deployment preflight fails explicitly |
| Provider logout unavailable | Local session is still revoked and the cookie is cleared |

Errors use bounded application codes and messages. They do not expose tokens, cookies, provider responses, client secrets, claims, state, nonce, PKCE values, upstream URLs, or raw authorization failures. Authentication audit records contain the derived actor, action, outcome, reason code, and capped safe metadata only. Incident audit remains the authoritative history for successful incident state changes.

## Measurable acceptance criteria

- Anonymous requests cannot access any page, static asset, monitoring evidence API, incident API, or proxied source tool.
- Authenticated Viewers can read evidence and cannot invoke incident mutations.
- Operators can perform only the existing approved incident mutations.
- Administrators can perform Operator actions and read the bounded authentication audit; no unimplemented administrative power is implied.
- Every incident mutation derives actor identity and role from a validated session; actor/role payload fields are rejected.
- Expired, revoked, malformed, replayed, incorrectly signed, wrong-subject, wrong-issuer, and retired-key sessions fail closed.
- State, nonce, PKCE, callback, and safe return-path tampering is rejected.
- Provider outage never grants access, refreshes expiry, or restores the legacy configured actor.
- Authentication and authorization failures are audited without secrets; successful incident mutations retain authenticated attribution in incident audit.
- The server test suite covers representative and adversarial identity paths and retains at least 90% coverage.
- Deployment verification proves anonymous fail-closed behavior, and human acceptance separately proves each configured role through the public origin.

## Required deployment decisions

Implementation does not authorize deployment. Before preflight or deploy, the user must approve and provision, outside Git:

1. the exact OIDC provider and HTTPS issuer;
2. the client registration, client ID, client secret, redirect/logout URIs, and required provider capabilities;
3. the exact scope set, display-name claim, group claim, and three distinct group mappings;
4. ownership of key generation, secure transfer, rotation, retirement, emergency revocation, database backup, and provider-client-secret rotation;
5. external callback-query logging behavior at Cloudflare and the provider;
6. the human acceptance identities used to prove Viewer, Operator, and Administrator behavior.

The client secret and session keyring must be installed as individual runtime files owned by UID/GID `10001` with mode `0400`. They must never enter Git, deployment archives, environment variables, browser responses, screenshots, audit metadata, or command output.

## Consequences

- Workspace Monitor now has a fail-closed application identity boundary independent of the external perimeter.
- Persistent sessions survive normal restarts and controlled one-key rotation, while explicit revocation and role loss take effect server-side.
- Provider availability becomes a dependency for login and periodic identity revalidation.
- Exact provider, mapping, key custody, callback-log, deployment, and human-acceptance decisions remain operator gates rather than repository defaults.
