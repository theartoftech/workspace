# ADR 0009: Safe Synthetic Journey Foundation

- Status: Proposed; foundation implemented, activation decisions open
- Date: 2026-08-17

## Context

Workspace Monitor needs user-path evidence that is more meaningful than reachability checks without creating unsafe or accumulating data. The first discovery pass found public metadata for both private Keycloak instances, a read-only ERPNext ping, Mailpit status, and authenticated CPQ routes. It also found that CPQ currently uses local application sessions and does not validate Keycloak-issued access tokens.

The identity, endpoint, data ownership, cadence, placement, custody, retention, and alerting decisions required for live operation have not been supplied. Repository work therefore must not create identities, store authentication material, activate schedules, or touch live application data.

## Recommended architecture

The recommended initial deployment is a dedicated, least-privilege runner boundary close to its target environment, with Workspace Monitor ingesting bounded evidence. The final placement remains an operator decision. Whether the runner is separated later or hosted in the monitoring API initially, it must use the same contracts:

1. Versioned definitions map a fixed journey ID to fixed semantic operations.
2. Strict controls enable each definition independently without source-code changes.
3. A scheduler produces a bounded execution key. A persistent unique claim prevents duplicate execution.
4. The runner derives an opaque run ID and isolated marker, then executes normal steps sequentially.
5. Reversible journeys execute definition-owned cleanup in a `finally` boundary.
6. A persistent ledger records only bounded step timing, safe failure classification, cleanup state, and a marker only when cleanup fails.
7. Low-cardinality metrics contain fixed journey/environment/status labels only. Run IDs, markers, user data, URLs, and error text never become labels.
8. Workspace Monitor exposes evidence through its authenticated read-only API. Existing monitoring never depends on runner availability.

## Implemented foundation

- `shared/synthetic.ts` defines the browser-safe evidence contract.
- `server/src/synthetic.ts` defines four versioned journey templates and fixed operation enums.
- The execution engine stops after the first normal failure, always executes cleanup for reversible templates, maps explicit failure codes to fixed safe messages, classifies unexpected failures generically, and deduplicates concurrent or completed replay in-process.
- The strict independent-control parser rejects missing, duplicate, unknown, or inline extra fields and prohibits enabled journeys while the runner is globally disabled.
- `GET /api/v1/journeys` and `HEAD /api/v1/journeys` expose evidence; writes and query parameters are rejected.
- The browser validates the complete response shape and rejects unknown fields or inconsistent evidence.
- `/journeys` displays runner state, each independently controlled definition, and bounded run/cleanup evidence.
- The runtime wires a disabled service only. No external request adapter or scheduler exists yet.

## Required implementation sequence after approval

1. Add persistent claim/evidence storage with the approved retention and orphan bounds; test uniqueness, restart recovery, corruption, and pruning.
2. Add environment binding validation and a transport policy that rejects redirects, address drift, arbitrary methods, arbitrary payloads, and cross-environment origins.
3. Implement the approved authentication contract and CPQ authenticated read; test rejected, malformed, expired, and wrong-environment tokens.
4. Implement the CPQ lifecycle adapter against the approved routes and ownership contract; test ambiguous completion, replay, multiple marker matches, permission loss, TTL, and cleanup after every failure point.
5. Implement Mailpit send/confirm/cleanup using the approved destination and correlation contract.
6. Implement the approved ERPNext read-only journey.
7. Add low-cardinality metrics, evidence-age behavior, cleanup/orphan alerts, and any approved persistent-incident integration.
8. Add the approved scheduler and optional manual-run authorization; keep manual execution absent if no role is approved.
9. Run the complete automated baseline, adversarial failure matrix, deployment plan/preflight/verify, and separate human acceptance before enabling Demo.

## Measurable activation criteria

- 100% of definition operations are fixed enums; zero generic URL/method/payload execution paths.
- 100% of reversible failure injection points demonstrate cleanup invocation.
- Replaying the same execution key performs zero additional provider mutations.
- Test and Demo binding tests issue zero requests to the other environment.
- Evidence contains zero authentication values, provider bodies, message content, user content, or browser-supplied identifiers.
- Cleanup failures produce a separate state and exactly one bounded marker; successful cleanup produces no orphan marker.
- Disabling the runner leaves inventory, performance, topology, incidents, logs, and health checks passing.
- Server statement, line, function, and branch coverage remain at least 90%.

## Consequences

The portal gains a reviewable, testable evidence contract before live risk is introduced. The disabled state is honest and deployable. Sprint 8 is not complete until persistent replay/restart safety and approved provider adapters are implemented and human-tested. No live mutation or identity work is authorized by this ADR.
