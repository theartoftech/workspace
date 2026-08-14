# ADR 0004: Bounded read-only Kubernetes topology

- Status: Accepted
- Date: 2026-08-14

## Decision

Workspace Monitor exposes `GET /api/v1/topology?environment=<all|demo|test|shared>`. The server derives the permitted namespaces from catalog workload mappings, reads a fixed allow-list of Kubernetes resource types, caps each upstream list and the assembled response, and never accepts arbitrary Kubernetes paths, selectors, or queries from the browser.

The response normalizes Nodes, Namespaces, Deployments, StatefulSets, Pods, Services, PersistentVolumeClaims, and Ingresses. It also attaches at most five recent events per object and emits catalog workload, dependency, observer, and pod scheduling edges. Crash loops, pending scheduling, failed mounts, restarts, node pressure, and unbound storage remain separate issue codes instead of collapsing into one degraded label.

The browser validates the typed response, limits rendering to 25 resources per page, and offers local text/kind filtering. A resource drawer shows the source label, direct evidence link, catalog mappings, operational explanation, and recent events. Missing catalog mappings are explicitly identified.

## Access boundary

Namespaced `get`/`list` permissions are granted through RoleBindings only in `default`, `cpq-test`, and `public-site`. Cluster access is limited to read-only Node inventory and `get` for those named Namespaces. Create, update, patch, delete, and watch permissions are absent. Credentials remain server-side in the existing protected token file.

## Failure behavior

Missing credentials produce a partial topology response with an explicit unavailable source. Malformed or rejected upstream responses fail without leaking credentials. The deployment verifier requires a Kubernetes source label and at least one Node so an apparently rendered but nonfunctional topology cannot pass verification.
