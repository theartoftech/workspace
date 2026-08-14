# ADR 0003: Sprint 3 Prometheus performance architecture

- Status: Accepted, deployed, and user-verified on 2026-08-14
- Date: 2026-08-13

## Context

Sprint 3 must expose useful traffic and capacity telemetry without giving browsers a general Prometheus proxy. Long ranges, arbitrary PromQL, or unbounded parallel requests could overload the co-located lab monitor. A missing series must also remain distinct from a real zero.

## Decision

The inventory API owns a fixed catalog of PromQL templates for request rate, selected-window request totals, server error percentage, synthetic latency percentiles, process and system CPU, JVM and host memory, database-pool saturation, and pod restarts. Public callers may select only a catalog environment, catalog service, and one of `15m`, `1h`, `6h`, or `24h`; unknown parameters and arbitrary query text are rejected.

Each range has a fixed step and maximum point count. Queries use the existing upstream deadline and a bounded worker pool. A successful empty matrix becomes `no-data`, a real zero remains an `ok` sample with value zero, and an individual query failure becomes a redacted metric error while other series remain available. Server timestamps, query window, resolution, unit, legend label, and threshold metadata are returned in a typed response.

The same-origin frontend validates that response and renders explicit live, partial, loading, no-data, and query-error states. Environment, service, time range, and manual refresh are shared operator controls. The CPQ correlation panel places Prometheus signals beside the Sprint 2 workload evidence; it does not invent pod telemetry when kube-state metrics are absent.

## Consequences

- The browser cannot submit arbitrary PromQL or expand query cost beyond reviewed bounds.
- New metrics require a reviewed server template and typed contract change.
- Gatus duration gauges provide current synthetic latency percentiles because the lab application does not yet expose request-duration histogram buckets.
- Pod restarts correctly show no-data until kube-state metrics are available.
- Portfolio request totals come from a pinned Nginx exporter sidecar. Nginx status is bound to pod loopback and the exporter is exposed only through a cluster-private Service; it is never added to the public website LoadBalancer.
- Prometheus is reachable from the API only on the Compose network; the browser uses the portal proxy.
