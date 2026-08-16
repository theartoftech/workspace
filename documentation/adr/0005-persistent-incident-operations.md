# ADR 0005: Persistent alert and incident operations

- Status: Accepted, deployed, and user-verified on 2026-08-14
- Date: 2026-08-14
- Sprint: 5 — Alerts and incident operations

## Context

The portal's session-only incident interactions could not survive reloads, coordinate stale operators, or preserve an audit history. Sprint 5 must turn live monitoring evidence into bounded incidents without treating missing evidence as healthy, exposing infrastructure credentials, accepting arbitrary alert queries, or inventing notification destinations and secrets.

## Decision

Use Node's built-in SQLite driver and a versioned, server-owned schema. The Docker lab profile bind-mounts one dedicated runtime directory into the unprivileged API container. Incident state, per-source evidence, bounded silences, and audit records are written inside `BEGIN IMMEDIATE` transactions with foreign keys, WAL journaling, full synchronous writes, and a busy timeout. Unsupported or empty schema metadata fails startup explicitly.

A server-owned evaluator reads the existing aggregate inventory at startup and every 30 seconds. It creates one incident for each stable service-health fingerprint, groups repeated evidence with occurrence counts, and records severity changes, recovery, recurrence, and reopening. Recovery clears active alert evidence but never resolves the incident; resolution is an explicit operator transition. Evaluator failure produces a partial incident response and preserves previously valid incidents.

The API provides bounded, `no-store` routes:

- `GET|HEAD /api/v1/incidents?environment=<all|demo|test|portfolio>&status=<active|resolved|all>`
- `POST /api/v1/incidents`
- `GET|HEAD /api/v1/incidents/<INC-id>`
- `POST /api/v1/incidents/<INC-id>/transitions`

Lists return at most 100 incidents, detail returns at most 100 audit records and 20 evidence sources, command bodies are limited to 16 KiB, and silence durations are restricted to 15, 60, 360, or 1440 minutes. Declaration and transition payloads reject unknown fields. Each transition requires a printable reason and expected version; stale, repeated, invalid, and out-of-order transitions fail without partial mutation. Read routes never trigger evaluation, expire silences, or otherwise mutate state.

The deployed Sprint 6 runtime still uses one configured lab operator identity and does not trust an actor supplied by the browser or query parameters. [ADR 0007](0007-enterprise-identity-access.md) supersedes this identity boundary in the locally tested Sprint 7 candidate by cryptographically validating the Cloudflare Access application assertion and applying exact server-side roles.

Notification delivery is explicitly `unconfigured` in every incident envelope. Sprint 5 stores no destination, webhook, SMTP credential, or delivery secret. Selecting channels, credential storage, retries, silencing semantics for delivery, and delivery audit events requires a separate approved design.

## Consequences

- Acknowledgement, declaration, silence, expiration, resolution, evidence, runbooks, and audit history survive process and repository restarts.
- Operator declarations are tied to catalog services and receive catalog-derived runbooks and ownership.
- Active silences are visible lifecycle records; because notification delivery is absent, they do not claim to suppress a destination.
- The same host still contains both alert evidence and incident storage, so it is not an independent failure domain.
- SQLite backup/restore, retention, and schema migration beyond version 1 require operational certification before cloud or production use.
- Per-user attribution and role enforcement are implemented in the Sprint 7 candidate described by ADR 0007; deployment and human acceptance remain pending.
