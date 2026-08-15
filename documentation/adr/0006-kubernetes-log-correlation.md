# ADR 0006: Bounded Kubernetes log and event correlation

- Status: Accepted, deployed, and user-verified
- Date: 2026-08-14
- Sprint: 6 — Logs and event correlation

## Context

Operators could see a failed probe, incident, performance signal, or Kubernetes resource but could not inspect the relevant container output without leaving Workspace Monitor and reconstructing service, pod, and time context. A lab solution must remain read-only, namespace-bounded, safe for the browser, explicit about missing evidence, and independent of the health and metrics APIs.

## Decision

The lab implementation reads current and, when a restart is observed, previous container logs directly from the Kubernetes Pod Log API. It is an ephemeral diagnostic source, not a durable log backend. A future cloud or production design must separately select aggregation, indexing, retention, storage, backup, and failure-domain behavior.

`GET /api/v1/logs` accepts one catalog service, an operator environment, one of four fixed ranges, and optional exact pod, severity, text, and correlation filters. The server derives namespaces and workloads only from the catalog, resolves Deployment selectors itself, and constructs every Kubernetes path and query parameter. Browser input cannot supply a namespace, label selector, arbitrary Kubernetes path, tail size, byte limit, or concurrency value.

The reader caps discovery at 8 pods, current/previous container reads at 16 streams, upstream text at 64 KiB per stream, returned lines at 500, events at 5 per Kubernetes object and 50 overall, list calls at 200 pods/100 events, and concurrency at 4 by default. The existing upstream deadline applies through each response body. Results declare the enforced limits and truncation.

Each log message and Kubernetes event is redacted server-side before response assembly. Credential-bearing URLs, bearer tokens, authorization/cookie/API-key headers, common secret query/key-value forms, and common JSON secret fields use the visible `[REDACTED]` replacement. Raw search and correlation values are not echoed into the response; only applied/not-applied flags are returned. The diagnostic JSON exporter refuses evidence without the server redaction declaration and preserves source, omission, cap, and redaction metadata.

Service detail, performance correlation, and incident detail link to the log workspace with service and global time range preserved. The UI presents log-source and event-source availability independently, plus loading, empty, partial, unavailable, capped, and export-error states.

## Access boundary

The existing service account gains only `get` for the `pods/log` subresource through the ClusterRole already RoleBound in `default`, `cpq-test`, and `public-site`. It does not gain exec, attach, create, update, patch, delete, or watch. Cluster-level permissions do not change. The protected token and CA stay mounted only in the server container and never enter an environment variable, archive, browser response, diagnostic bundle, or command output.

The deployment script never applies RBAC. An operator must separately review and apply the manifest and verify positive `pods/log` plus negative mutation/exec/attach checks before deployment.

## Failure behavior

An inaccessible container stream becomes a generic omission while successful streams and events remain visible. A total log failure returns a typed partial response rather than breaking inventory, performance, incidents, topology, or server health. Missing mappings and zero current pods are explicit unavailable evidence. Missing lines after filters are described as no matching evidence, never zero activity. Unexpected errors are replaced with generic API diagnostics so upstream URLs or authorization values cannot leak.

## Consequences

- The lab gains a short, safe path from failure evidence to relevant pod output and events.
- Evidence disappears with Kubernetes log rotation or pod deletion; this limitation is visible and accepted for Sprint 6.
- Multi-line application stack traces are represented as bounded individual Kubernetes log lines.
- Applying the reviewed `pods/log` permission is a required separate deployment prerequisite.
- Durable aggregation and cloud-grade log operations remain unapproved future work.
