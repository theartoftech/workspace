# ADR 0002: Sprint 2 live inventory architecture

- Status: Accepted, deployed, and user-verified on 2026-08-13
- Date: 2026-08-12

## Context

The Sprint 1 portal deliberately used deterministic fixtures. Sprint 2 must show catalog-defined service state from Gatus and Kubernetes without letting an unavailable source erase valid evidence or allowing stale data to look healthy. The browser must not receive Kubernetes credentials or call infrastructure APIs directly.

## Decision

Add a read-only Node inventory API behind the portal's same-origin Nginx boundary. The API loads `catalog/services.json`, queries the two Gatus status APIs, and optionally queries only the catalog-mapped Kubernetes Deployments and Pods. It normalizes evidence into `healthy`, `degraded`, `failing`, `unknown`, `paused`, and `stale` states while preserving source timestamps.

Each upstream has a three-second deadline. Gatus collectors run concurrently, and Kubernetes workload reads use a bounded worker pool. Aggregation uses `Promise.allSettled`, so a failed source becomes an explicit `unavailable` source record while successful observations remain visible. Diagnostics pass through credential, token, URL-userinfo, query-secret, and sensitive-header redaction.

The inventory evidence surface exposes only `GET` and `HEAD` routes. Operator-facing environment selections are `demo`, `test`, `portfolio`, and `all`; `shared` remains an internal catalog classification whose services are included in applicable scopes rather than a separate operator environment.

- `/api/v1/inventory?environment=all|demo|test|portfolio`
- `/api/v1/services/<catalog-service-id>`
- `/healthz`

All other inventory methods return `405`. Responses use `no-store`. The browser's live provider has its own five-second deadline, validates the response shape, and never falls back to fixtures. Overview, deployment, service-detail, performance, infrastructure, and incident screens now use live evidence. ADR 0005 defines the separate, strict incident POST command surface; Settings remains a preview.

Kubernetes access uses a token file mounted from the host, never an environment variable. ADR 0004 expanded the checked-in RBAC to namespace-bounded `get`/`list` access for a fixed topology allow-list in `default`, `cpq-test`, and `public-site`, plus narrowly scoped read access for Nodes and named Namespaces. When that token is absent, unreadable, empty, expired, or rejected, the API stays available in `partial` mode and Kubernetes-mapped services cannot appear healthy solely from missing workload evidence.

## Consequences

- Catalog, Gatus, and Kubernetes response contracts can evolve behind typed adapters.
- Internal/public-path disagreement remains first-class diagnostic evidence.
- The API container is an additional bounded Compose service and must roll back with the matching portal revision.
- The public-path Gatus collector still shares the CPQ host and is not an independent external failure domain.
- Kubernetes token rotation currently requires restarting the inventory API; automated credential rotation is deferred to cloud hardening.
