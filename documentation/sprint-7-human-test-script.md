# Sprint 7 human acceptance script

## Acceptance status

Pending provider registration, explicit deployment authorization, deployment verification, and human acceptance. Do not mark Sprint 7 deployed or accepted until every required section passes through the public TLS origin.

Run this only after the exact OIDC issuer/client, scopes, display claim, group claim, and Viewer/Operator/Administrator mappings are approved; the client-secret and keyring runtime files are provisioned; the candidate is explicitly deployed; and `deploy-lab-docker.sh verify` passes. Use dedicated test identities. Never capture tokens, cookies, authorization codes, callback URLs, provider claims, secret files, authentication database content, or raw audit payloads in tickets, chat, screenshots, recordings, or Git.

## Preconditions

1. Record the deployed `candidate-<sha256>` revision without recording credentials.
2. Confirm `https://monitor.jefferyhaynes.net/healthz` is healthy and Cloudflare Access remains active.
3. Confirm an anonymous private-browser request to a portal page enters the approved OIDC flow and an anonymous `/api/v1/session` request returns `401` without protected evidence.
4. Confirm the test identities have exactly the approved Viewer, Operator, and Administrator groups. Include one identity with no Workspace Monitor group for a negative test.
5. Confirm browser developer tools are configured not to preserve the network log across authentication redirects. Do not inspect or export callback query values.

## A. Anonymous and callback boundary

1. In a fresh private window, open `/`, `/incidents`, `/logs`, a known `/services/<id>` route, and a static asset URL.
2. Verify each request requires authentication and no page shell or monitoring evidence is rendered first.
3. Open `/api/v1/inventory?environment=all`, `/api/v1/incidents?environment=all&status=active`, `/api/v1/logs?environment=demo&service=cpq-demo&range=1h`, and both Gatus source-tool routes.
4. Verify data/tool requests fail with `401`; they must not redirect into HTML or reveal evidence.
5. Start login with a valid route return path and verify successful login returns only to that Workspace Monitor path.
6. Attempt login return paths representing an absolute URL, `//` path, encoded cross-origin path, backslash path, fragment, and unknown route.

Expected: anonymous access fails closed; valid local navigation survives login; unsafe or unknown return paths are rejected and never redirect off origin.

## B. Viewer role

1. Sign in as the dedicated Viewer and confirm the operator menu shows the expected display name and **Viewer**.
2. Visit Overview, Deployments, Infrastructure, Performance, Incidents, Logs, Settings, and one service detail route.
3. Confirm the Viewer can read live or honestly partial evidence and incident history.
4. Open an incident and confirm acknowledge, declare, silence, and resolve controls are absent while read-only runbook, evidence, audit, and investigation links remain available.
5. Attempt a direct incident declaration and transition request from a same-origin browser request without adding actor or role fields.
6. Open `/api/v1/auth/audit?limit=10`.

Expected: reads succeed; both incident mutations and authentication-audit access return `403`; the incident remains unchanged; the denial is available later to the Administrator audit test.

## C. Operator role and authenticated attribution

1. Sign out locally and verify the portal session cookie is cleared even if the provider omits or cannot complete federated logout.
2. Sign in as the dedicated Operator and confirm the expected display name and **Operator**.
3. Declare a bounded test incident with a non-sensitive reason, then acknowledge and resolve it using the ordinary UI.
4. Inspect the incident audit and displayed assignee/declarer fields.
5. Attempt a separate mutation payload containing `actor`, `actorId`, `displayName`, or `role`.
6. Attempt a mutation without valid same-origin request evidence using an approved browser-testing method that does not expose the session cookie.
7. Attempt `/api/v1/auth/audit?limit=10`.

Expected: approved incident actions succeed and are attributed to the authenticated Operator's display name and derived opaque actor ID; browser-selected identity fields are rejected; missing/cross-site origin evidence is rejected; authentication audit remains `403`.

## D. Administrator role and bounded audit

1. Sign out, sign in as the dedicated Administrator, and confirm the expected display name and **Administrator**.
2. Confirm the Administrator can perform the existing incident actions but sees no identity, provider, retention, integration, or user mutation that Sprint 7 did not implement.
3. Open `/api/v1/auth/audit?limit=10` in the authenticated browser.
4. Verify the response is versioned, contains at most 10 events, and includes the Viewer/Operator authorization denials with bounded actor, action, outcome, reason, and safe metadata.
5. Request limits `0`, `101`, a duplicate limit, and an unknown parameter.

Expected: bounded valid audit access succeeds only for Administrator; invalid parameters return `400`; records contain no token, cookie, secret, raw claim, code, state, nonce, PKCE verifier, provider response, or callback URL.

## E. Role loss, expiry, refresh, restart, and revocation

Coordinate these tests with the identity-provider and host operators. Do not change external configuration or runtime keys without a separately reviewed test step and rollback.

1. Sign in with the no-role identity and verify callback completion is denied with no application session.
2. For an approved short-lived test registration or controlled role change, remove the Operator's approved group and wait for identity refresh.
3. Verify the next protected request fails closed and the old role cannot mutate incidents.
4. Sign in again, restart only `inventory-api`, and verify the session survives with the same identity and role.
5. Rotate the keyring by adding a new active key while retaining the previous key, restart `inventory-api`, and verify the existing session survives.
6. Retire the previous key in the reviewed test window, restart, and verify a session tied to it is rejected.
7. Verify idle and absolute expiry produce the explicit signed-out state and do not silently reload evidence.
8. During an approved provider-unavailable exercise, verify login or required refresh returns the unavailable state, does not extend expiry, and never grants the legacy configured actor.

Expected: role loss, expiry, revocation, retired keys, and provider rejection return `401` or `403` as appropriate; transient provider outage returns `503`; restart and controlled current/previous rotation preserve only sessions that remain valid.

## F. Regression, privacy, and accessibility

1. Complete the Sprint 6 logs/events regression for one mapped service and ERPNext's intentionally unmapped state.
2. Verify monitoring evidence appears only after the session endpoint succeeds and no live request falls back to fixture data.
3. Use keyboard navigation through sign-in, the operator menu, local logout, Viewer incident evidence, and Operator incident controls.
4. Verify visible focus, screen-reader names, and understandable `401`, `403`, expired-session, and provider-unavailable messages.
5. Inspect ordinary browser console and network summaries without opening callback or cookie values; confirm no application error logs expose identity-provider details or sensitive claims.
6. Confirm Grafana, Prometheus, Gatus, CPQ, OAuth/Keycloak, Mailpit, ERPNext, and Portfolio remain available according to their existing boundaries.

## Acceptance record

Record only pass/fail, candidate revision, date/time, provider product name, approved non-secret claim-path and group-mapping identifiers, tested role names, browser/OS versions, and bounded failure codes. Do not record client credentials, session keys, cookies, tokens, callback URLs, authorization codes, provider responses, claim values containing personal or sensitive data, SQLite content, or protected monitoring evidence.
