# Sprint 7 human acceptance script

## Acceptance status

Pending runtime identity provisioning, explicit deployment authorization, deployment verification, and human acceptance. Do not mark Sprint 7 deployed or accepted until every required section passes through the public TLS origin.

Run this only after the exact Cloudflare Access team domain and Workspace Monitor audience are approved, the Viewer/Operator/Administrator mapping file is provisioned, the candidate is explicitly deployed, and `deploy-lab-docker.sh verify` passes. Never capture Access assertions, authorization cookies, personal email claims, signing-key responses, mapping-file content, authentication database content, or raw audit payloads in tickets, chat, screenshots, recordings, or Git.

## Preconditions

1. Record the deployed `candidate-<sha256>` revision without recording identity data.
2. Confirm `https://monitor.jefferyhaynes.net/healthz` is healthy and the existing Cloudflare Access application remains active.
3. Confirm the role-mapping file contains exact dedicated Viewer, Operator, and Administrator identities plus that an approved negative-test identity is absent.
4. Confirm the API container can retrieve the approved team JWKS endpoint without printing its response.
5. Confirm CPQ Demo, CPQ Test, and both private Keycloak instances are unchanged.

## A. Anonymous and origin boundary

1. In a fresh private window, open `/`, `/incidents`, `/logs`, a known `/services/<id>` route, and a static asset URL through the public hostname.
2. Verify Cloudflare Access requires login before Workspace Monitor renders any shell or monitoring evidence.
3. From the lab host, run the repository `verify` command and confirm direct loopback requests to pages, APIs, logs, incidents, and Gatus tools return `401` while `/healthz` remains healthy.
4. Confirm the obsolete `/auth/login` and `/auth/callback` application routes are unavailable and no Keycloak redirect occurs.

Expected: Cloudflare performs login; the origin independently requires a valid signed assertion; neither private Keycloak instance participates.

## B. Viewer role

1. Sign in through Cloudflare Access as the dedicated Viewer and confirm the operator menu shows the configured display name and **Viewer**.
2. Visit Overview, Deployments, Infrastructure, Performance, Incidents, Logs, Settings, and one service detail route.
3. Confirm the Viewer can read live or honestly partial evidence and incident history.
4. Open an incident and confirm acknowledge, declare, silence, and resolve controls are absent while read-only runbook, evidence, audit, and investigation links remain available.
5. Attempt a direct incident declaration and transition from a same-origin browser request without adding actor or role fields.
6. Open `/api/v1/auth/audit?limit=10`.

Expected: reads succeed; incident mutations and authentication-audit access return `403`; the incident remains unchanged; the denial is available to the Administrator audit test.

## C. Operator role and authenticated attribution

1. Use **Sign out** and confirm the browser enters `/cdn-cgi/access/logout`.
2. Sign in as the dedicated Operator and confirm the configured display name and **Operator**.
3. Declare a bounded test incident with a non-sensitive reason, then acknowledge and resolve it through the UI.
4. Inspect the incident audit and displayed assignee/declarer fields.
5. Attempt a separate mutation payload containing `actor`, `actorId`, `displayName`, or `role`.
6. Attempt a mutation without valid same-origin request evidence using an approved browser-testing method that does not expose the Access assertion or cookie.
7. Attempt `/api/v1/auth/audit?limit=10`.

Expected: approved incident actions succeed and use the Operator's configured display name and opaque `access:` actor ID; browser-selected identity fields and invalid origin evidence are rejected; authentication audit remains `403`.

## D. Administrator role and bounded audit

1. Sign out, sign in as the dedicated Administrator, and confirm the configured display name and **Administrator**.
2. Confirm the Administrator can perform existing incident actions but sees no unimplemented identity, provider, retention, integration, or user mutation.
3. Open `/api/v1/auth/audit?limit=10`.
4. Verify the response contains at most 10 events and includes bounded Viewer/Operator denials.
5. Request limits `0`, `101`, a duplicate limit, and an unknown parameter.

Expected: audit succeeds only for Administrator; invalid parameters return `400`; records contain no assertion, cookie, email, subject, signing key, provider response, or protected evidence.

## E. Mapping, expiry, key rotation, restart, and outage

Coordinate these tests with the Cloudflare and host operators. Do not change external configuration without a separately reviewed test step and rollback.

1. Sign in using an Access-authorized identity absent from the application mapping and verify Workspace Monitor denies evidence and mutations.
2. Atomically remove the Operator mapping during an approved window, restart only `inventory-api`, and verify the next request fails closed. Restore the mapping and restart afterward.
3. Restart only `inventory-api` without changing the mapping and confirm a valid Access browser session continues on its next signed request.
4. Wait for or use an approved short Access session to verify an expired assertion is rejected and Cloudflare reauthentication is required.
5. During an approved JWKS-unavailable exercise, confirm Workspace Monitor returns `503`, exposes no evidence, and never restores the Sprint 6 configured actor.
6. Allow ordinary Cloudflare signing-key rotation and verify newly signed assertions continue to validate through the remote JWKS set.

Expected: mapping loss, expired or malformed assertions, and signing failures fail closed; restart does not create a fallback identity; JWKS transport failure is explicit.

## F. Regression, privacy, and accessibility

1. Complete the Sprint 6 logs/events regression for one mapped service and ERPNext's intentionally unmapped state.
2. Verify monitoring evidence appears only after `/api/v1/session` succeeds and live mode never falls back to fixtures.
3. Use keyboard navigation through the operator menu, Cloudflare logout, Viewer evidence, and Operator incident controls.
4. Verify visible focus, screen-reader names, and understandable `401`, `403`, and identity-validation-unavailable messages.
5. Inspect ordinary browser console and bounded network summaries without opening assertion or cookie values; confirm application errors expose no personal identity claims or upstream details.
6. Confirm Grafana, Prometheus, Gatus, CPQ, OAuth/Keycloak, Mailpit, ERPNext, and Portfolio remain available according to their existing boundaries.

## Acceptance record

Record only pass/fail, candidate revision, date/time, the non-secret Access team identifier and application audience fingerprint, tested role names, browser/OS versions, and bounded failure codes. Do not record role-mapping identities, assertions, cookies, email claims, subjects, signing keys, SQLite content, or protected monitoring evidence.
