# Sprint 8 Safe Synthetic Journeys Threat Model

Status: active design and implementation boundary; live journeys are disabled.

## Scope and assets

Sprint 8 adds a server-side execution boundary for user-relevant checks while preserving the existing inventory, performance, topology, incident, log, identity, and PostgreSQL monitoring surfaces. The assets that must be protected are:

- CPQ Demo and Test records and their environment boundary;
- dedicated synthetic identities and future authentication material;
- Mailpit messages and correlation markers;
- ERPNext data and availability;
- journey evidence, cleanup state, and alert integrity;
- existing Workspace Monitor availability and its Cloudflare Access authorization boundary; and
- all current databases, persistent volumes, runtime data, and monitoring services.

The current repository implementation contains the versioned policy, strict independent controls, execution invariants, read-only evidence API, and browser evidence view. It does not contain an active external adapter, scheduler, identity, endpoint binding, or live-data mutation.

## Trust boundaries and assumptions

1. Browser to portal: the browser is untrusted. It receives only the bounded evidence contract through the authenticated same-origin API. It never selects an endpoint, method, payload, environment binding, cleanup target, identity, or authentication material.
2. Cloudflare Access to origin: Workspace Monitor continues to validate the Access assertion at the origin. Cloudflare configuration and assertions remain outside the repository and outside synthetic execution.
3. Journey policy to step driver: versioned definitions contain fixed operation enums. The driver may implement only the operation requested by the definition; there is no generic arbitrary-URL or arbitrary-method operation.
4. Runner to Demo/Test providers: every run has one immutable environment. All future provider bindings must be selected from that environment before a request is issued. A response claiming another environment is a failure.
5. Runner to persistent evidence: future retention remains undecided. Any repository must enforce unique execution keys, bounded records, bounded strings, and atomic run/cleanup transitions.
6. Runtime configuration: enable controls are operator-controlled, strictly parsed, and contain no inline authentication material. Storage, rotation, and restart behavior for future material remain an explicit decision.
7. Existing monitoring: inventory, performance, topology, incidents, and logs do not depend on the synthetic runner. Runner absence or disablement must not change their availability.

Attacker-controlled inputs include browser requests, provider responses, error bodies, response timing, duplicated scheduler deliveries, and any data found while searching for a synthetic marker. Operator-controlled inputs include enable controls and future reviewed endpoint/identity bindings. Developer-controlled inputs include versioned definitions and driver code.

## Security objectives and invariants

- A run identifier matches `run-[a-z0-9]{12}`. Its marker is derived by the server as `WSM_SYN_V1_<ENV>_<RUN_ID>`; callers cannot provide either value.
- An execution key is bounded and safe-character-only. Replaying the same definition, environment, and key returns the recorded result without executing another step.
- A run carries exactly one environment. Step drivers receive that immutable environment on every call.
- Normal steps execute sequentially. The first failed step stops normal execution, and later normal steps are not fabricated.
- Every reversible definition has a fixed cleanup operation. Cleanup runs after normal success and after every recoverable normal-step failure.
- Cleanup failure is distinct from the primary result. Only then may evidence contain the bounded server-generated marker as an orphan identifier.
- Unknown driver failures become fixed generic evidence. Explicit failure codes map to fixed safe messages; provider text is never copied into evidence.
- Browser response parsing rejects unknown fields, oversized collections, invalid timestamps, invalid identifiers, invalid durations, and inconsistent cleanup/orphan state.
- Definitions cannot express arbitrary URLs, HTTP methods, headers, or payloads. Destructive behavior is absent from normal operations and may occur only through a definition-owned cleanup operation.
- No active journey is inferred from missing configuration. The deployed foundation reports all journeys disabled.

## Failure taxonomy

| Class | Required classification |
| --- | --- |
| Authentication | `token_rejected`, `token_timeout`, `token_malformed`, or `token_expired` |
| Environment isolation | `wrong_environment` before any provider data is accepted |
| Provider transport | `provider_timeout`, `provider_rejected`, `provider_malformed`, or `provider_unavailable` |
| Cleanup | separate `cleanup_failed`, never folded into provider success |
| Duplicate/replay | return the already-claimed result; issue no second provider operation |
| Interrupted run | future persistent runner must recover the stored marker and attempt cleanup before another execution |
| Missing evidence | unavailable/disabled state; never a synthetic success |

## Attacker stories and controls

- A compromised browser attempts to choose a Demo cleanup target while viewing Test. The read-only API accepts no journey command, endpoint, or target fields.
- A provider returns authentication material in an error. Provider error text is discarded; the server records only a fixed classification and safe message.
- A scheduler replays a delivery after an ambiguous timeout. The execution key prevents a second in-process execution; persistent claim and restart recovery remain required before live activation.
- A malicious record collides with a marker. The marker format alone must never authorize cleanup. A future CPQ contract must also require dedicated ownership and exact environment fields.
- A compromised runner tries an arbitrary URL or method. The policy exposes fixed semantic operations only. A future driver must map them to pre-reviewed bindings and reject redirects or DNS/address changes outside those bindings.
- Mailpit accepts a message but confirmation never arrives. The confirmation step fails, cleanup still runs, and no later success is fabricated.
- Evidence disappears. Future alerting must use an explicit evidence-age signal; a missing series cannot remain healthy.

## Severity calibration

- Critical: cross-environment cleanup or mutation; exposure of reusable authentication material; arbitrary request execution with privileged identities; destruction or compromise of CPQ, PostgreSQL, Keycloak, ERPNext, or persistent volumes.
- High: a cleanup authorization bypass that can alter non-synthetic records; replay that creates unbounded records; a browser-accessible live-run API without an approved authorization model; silent provider failure reported as success.
- Medium: bounded orphan creation with no cross-user impact; stored sensitive provider content in evidence; missing/stale evidence that suppresses an operational alert.
- Low: incorrect display wording, a harmless disabled-state mismatch, or timing precision errors with no effect on execution, cleanup, authorization, or alert state.

## Activation blockers

Read-only discovery on 2026-08-17 confirmed that both private Keycloak instances advertise OAuth grants, but the current CPQ application validates only its own local `Bearer local:` sessions. It does not accept a Keycloak-issued access token. The planned OAuth-to-CPQ read therefore requires an explicit CPQ identity integration decision or a separately approved dedicated CPQ authentication contract.

Live activation also requires the user to decide:

- Test-only versus Test and Demo scope;
- identity, client, grant, scope, role, and CPQ permission model;
- approved CPQ read/create/update/cleanup routes and payload contract;
- marker, ownership field, TTL, orphan cap, and lookup semantics;
- cadence, timeout, concurrency, retry, replay, and maintenance behavior;
- runner placement and network policy;
- authentication-material storage, rotation, revocation, and restart behavior;
- Mailpit destination, trigger, correlation, retention, and cleanup;
- ERPNext endpoint, identity, environment classification, and read-only contract;
- persistent result retention and restart recovery;
- metric and alert thresholds and persistent-incident integration; and
- manual-run authorization, if manual execution is allowed at all.

Until those decisions are approved, all journeys remain independently disabled and the read-only evidence view reports no runs.
