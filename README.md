# Development Lab Observability

This standalone repository is the operational monitoring application for the development lab. Its primary profile is a single Docker Compose stack on the CPQ server. Sprints 0 through 6 are complete, deployed, and user-verified: the portal combines live service inventory, internal and public-path reachability, bounded Prometheus performance queries, read-only Kubernetes topology, persistent alert-driven incident operations, and bounded Kubernetes log and event correlation.

Development is organized as reviewable increments in the [detailed sprint plan](documentation/detailed-sprint-plan.md). Sprint 6 logs and event correlation completed deployment verification and human acceptance on 2026-08-15. Sprint 7 enterprise identity and access is implemented and tested locally; its Cloudflare Access runtime identity mapping, deployment, and human role acceptance remain explicitly pending.

## Foundation scope

| Capability | Included in this slice |
| --- | --- |
| Service catalog | Strict JSON contract for CPQ demo/test, OAuth, Mailpit, ERPNet, and the public portfolio |
| Primary lab monitoring | Docker Compose with the enterprise portal, read-only inventory API, Prometheus, Grafana, Blackbox Exporter, node-exporter, cAdvisor, and Gatus |
| Future cloud monitoring | `kube-prometheus-stack` Helm chart with Prometheus, Grafana, Alertmanager, and Kubernetes metrics |
| Synthetic probe support | Prometheus Blackbox Exporter plus dedicated Gatus nodes |
| Direct application metrics | CPQ demo `/api/actuator/prometheus` through one `ServiceMonitor` |
| Portfolio request metrics | Private Nginx exporter sidecar with selected-window request totals and request rate |
| Internal reachability | CPQ demo/test, OAuth demo/test, Mailpit, and ERPNet from the CPQ server |
| Public-path simulation | Public CPQ demo and ERPNet URLs, including TLS expiry, from the same CPQ server—not an independent external vantage |
| Incident operations | Deployed persistent SQLite incidents, inventory-health alert evaluation, bounded silences, state transitions, runbooks, and audit history |
| Log correlation | Deployed direct Kubernetes pod-log and event correlation with fixed windows, server-side redaction, partial-source disclosure, and diagnostic JSON export |
| Identity and access | Locally implemented Cloudflare Access JWT validation, exact host-provisioned Viewer/Operator/Administrator mappings, same-origin mutation protection, and bounded authentication audit |
| Alert delivery | Explicitly unconfigured until notification destinations and credential handling are selected |

Overview, deployments, service detail, infrastructure topology, and incident evaluation use live inventory. Performance uses live Prometheus range queries. Incidents persist acknowledgement, declaration, silence, resolution, evidence, runbooks, and audit history in a server-side SQLite database. Sprint 6 adds direct, ephemeral Kubernetes pod logs rather than a durable aggregated log store. The Sprint 7 candidate protects application pages, APIs, and proxied tools by cryptographically validating the existing Cloudflare Access application assertion and derives every incident actor from an exact host-provisioned role mapping. CPQ Demo, CPQ Test, and their private Keycloak instances remain independent. Settings remains a preview. Notification delivery, durable log aggregation/retention, safe transaction journeys, and additional application scrapes remain later-sprint work.

## Repository layout

- `catalog/services.json` — operator-readable source of truth for monitored services and probes.
- `catalog/schema.json` — portable JSON Schema for editors and future integrations.
- `src/lab_observability/catalog.py` — strict runtime validation with explicit errors.
- `deploy/helm/lab-observability` — pinned umbrella Helm chart for the k3s monitoring namespace.
- `deploy/compose/lab-observability` — primary single-host Docker lab stack.
- `deploy/portal` — digest-pinned multi-stage portal image and hardened Nginx runtime.
- `deploy/inventory-api` — digest-pinned, unprivileged Node image for the read-only inventory API.
- `deploy/kubernetes/inventory-reader-rbac.yaml` — namespace-bounded, read-only Kubernetes topology and pod-log RBAC.
- `server/src` and `shared` — typed upstream adapters, aggregation/API logic, and browser/server contracts.
- `deployment/scripts` — guarded plan, preflight, deploy, status, and verification commands.
- `deployment/PORTAL_ROLLBACK.md` — independent portal-image and Cloudflare-origin rollback procedures.
- `documentation/adr/0004-kubernetes-topology-architecture.md` — bounded topology API, issue taxonomy, UI scaling, and RBAC decision.
- `documentation/adr/0005-persistent-incident-operations.md` — incident persistence, evaluation, mutation, identity, and notification boundaries.
- `documentation/adr/0006-kubernetes-log-correlation.md` — selected lab log source, query bounds, redaction, partial-failure, export, and RBAC boundaries.
- `documentation/adr/0007-enterprise-identity-access.md` — validated Cloudflare Access identity, exact role enforcement, failure behavior, and deployment decision gates.
- `documentation/sprint-7-human-test-script.md` — pending public-origin Viewer/Operator/Administrator acceptance and privacy-safe evidence record.
- `deployment/ENVIRONMENTS.md` — target topology, secret preparation, and operator workflow.
- `probes/internal` — Gatus node intended to run inside the lab network.
- `probes/external` — Gatus node intended to run on an independent public host.
- `tests` — catalog, drift, security-default, and infrastructure contract tests.
- `web/src` — enterprise shell, live and fixture providers, service detail, reusable components, and UI tests.
- `documentation/adr` — architecture decisions for review before later live-data integration.

## Run and verify the current workspace locally

Install dependencies and run the deterministic application and server quality gates:

```sh
npm install
npm test
npm run test:server:coverage
npm run test:coverage
npm run test:a11y
npm run typecheck
npm run lint
npm run build
npm run build:server
```

The live server intentionally refuses startup without an approved HTTPS public origin, Cloudflare Access team domain and audience, persistent incident and authentication-audit databases, and a separately provisioned exact identity-to-role mapping file. Use [the environment runbook](deployment/ENVIRONMENTS.md) rather than placing identity data in shell history. The browser never falls back to fixtures when live authentication or evidence fails.

The live route set includes Overview, Deployments, Infrastructure, Performance, Incidents, Logs, and `/services/<catalog-id>`. Settings remains a preview. Monitoring evidence routes accept only GET/HEAD. The incident surface adds strict, bounded POST commands for declarations and state transitions; it never accepts a browser-selected actor or role. Viewers are read-only, Operators can run approved incident commands, and Administrators additionally receive the bounded authentication-audit API. Topology and log evidence are server-capped and catalog-namespace bounded, performance queries are selected from server-owned templates, and the browser never receives Access assertions, identity claims, infrastructure credentials, arbitrary Kubernetes paths, or arbitrary PromQL access.

## Verification criteria

The deployed foundation remains acceptable only while all of these are true:

1. `python3 scripts/validate_catalog.py` reports six services, seven internal probes, and three external probes.
2. `python3 -m unittest discover -s tests -v` passes.
3. The primary lab Compose stack passes both plugin and standalone Compose validation.
4. Helm dependency build, lint, and template rendering pass with chart versions locked for the cloud path.
5. Each Gatus configuration starts successfully with the pinned image.
6. After deployment, Prometheus reports target `serviceMonitor/monitoring/cpq-demo/0` as `UP`.

## Review the primary Docker lab stack

The preferred lab workflow is documented in [deployment/ENVIRONMENTS.md](deployment/ENVIRONMENTS.md). Start with the remote plan, which does not start containers:

```sh
./deployment/scripts/deploy-lab-docker.sh plan \
  --host 192.168.86.246 --ssh-user jhaynes
```

After provisioning the remote runtime `.env` and Grafana password file, run preflight and deploy with exact confirmation:

```sh
./deployment/scripts/deploy-lab-docker.sh preflight \
  --host 192.168.86.246 --ssh-user jhaynes
./deployment/scripts/deploy-lab-docker.sh deploy \
  --host 192.168.86.246 --ssh-user jhaynes \
  --confirm-deploy lab-docker
```

The deploy command builds matching revision-tagged portal and inventory API images on the CPQ server and starts the portal on `127.0.0.1:3100`; the API is reachable only through the portal's same-origin proxy. Grafana remains on `127.0.0.1:3000`. The command does not modify Cloudflare. Verify the complete stack before any ingress change:

```sh
./deployment/scripts/deploy-lab-docker.sh verify \
  --host 192.168.86.246 --ssh-user jhaynes
```

After that verification and a separate operator decision, route the user-managed `monitor.jefferyhaynes.net` tunnel to `http://localhost:3100` on the CPQ server and retain `http://localhost:3000` as the immediate tunnel rollback value. Protect the hostname with Cloudflare Access. Tunnel credentials stay outside Git. Follow [the portal deployment and rollback runbook](deployment/PORTAL_ROLLBACK.md) for the cutover and both rollback paths.

## Review the future Helm stack

Prerequisites are Helm 3, Kubernetes 1.25 or newer, the `local-path` storage class, and a `monitoring` namespace. Chart dependencies are deliberately pinned in `Chart.yaml` and `Chart.lock`.

```sh
helm dependency build deploy/helm/lab-observability
helm lint deploy/helm/lab-observability --namespace monitoring
helm template lab-observability deploy/helm/lab-observability \
  --namespace monitoring > /tmp/lab-observability.yaml
```

The CPQ Service in namespace `default` must have labels `app: application` and `runtime: spring-boot-primary`, expose a port named `http`, and serve metrics at `/api/actuator/prometheus`.

Before a future install, create the Grafana bootstrap secret through your secret-management workflow. A manual lab-only example is:

```sh
kubectl --namespace monitoring create secret generic lab-observability-grafana-admin \
  --from-literal=admin-user=admin \
  --from-literal=admin-password='replace-with-a-generated-secret'
```

The future install command is deliberately documented but not run by this repository:

```sh
helm upgrade --install lab-observability deploy/helm/lab-observability \
  --namespace monitoring --create-namespace
```

The future cloud workflow uses the guarded Kubernetes script:

```sh
./deployment/scripts/deploy-monitoring-k8s.sh plan
./deployment/scripts/deploy-monitoring-k8s.sh preflight \
  --host 192.168.86.246 --ssh-user jhaynes
# Deploy only after approving both outputs:
./deployment/scripts/deploy-monitoring-k8s.sh deploy \
  --host 192.168.86.246 --ssh-user jhaynes \
  --confirm-deploy monitoring
```

## Review and run a Gatus node

Run these commands from either `probes/internal` or `probes/external`:

```sh
cp .env.example .env
# Replace every example.invalid or replace-me value, and set GATUS_UID/GATUS_GID
# to `id -u` and `id -g` for the Docker host before starting.
docker compose config --quiet
docker compose up -d
```

The internal example binds port 8080 to the LAN so the central stack can later scrape `/metrics`; firewall that port to the monitoring network. The external example binds only to loopback and expects a separately secured reverse proxy if its UI is exposed.

Sprint 0 Gatus nodes collect status and metrics without requiring notification integrations. Alert delivery will be added only after its destinations and credential workflow are reviewed. Gatus runs as the configured non-root host user so SQLite can persist under `./data` without granting container root access.

Use `deployment/scripts/deploy-gatus.sh` for guarded local or SSH-based plan, preflight, deploy, status, verification, and logs. Remote synchronization never copies `.env` or SQLite data.

## Failure modes guarded in this slice

- Duplicate service/probe identifiers and unsupported catalog fields are rejected.
- Missing, expired, or rejected Kubernetes credentials produce explicit partial inventory and never a false healthy state.
- Gatus and Kubernetes requests have deadlines; Kubernetes reads use bounded concurrency.
- Prometheus requests have deadlines and bounded concurrency; public inputs select only allow-listed query templates and fixed query windows.
- Incident lists, request bodies, silence durations, audit history, evaluator cadence, and state transitions are bounded and validated server-side.
- Repeated alert evidence is grouped; stale versions and invalid or repeated transitions fail atomically without partial audit writes.
- Missing notification configuration and failed live alert evaluation remain explicit and cannot produce a false resolution.
- Credentials, sensitive headers, URL userinfo, and secret query values are redacted from diagnostics.
- Pod-log streams, response lines, events, response bytes, concurrency, and time windows are bounded; one failed stream is disclosed without erasing valid evidence.
- Diagnostic JSON can be generated only from a response that declares server-side redaction and retains source, omission, and cap metadata.
- Credentials, sensitive query keys, invalid URLs, and TLS checks on plain HTTP are rejected.
- Probe timeout must remain shorter than its interval.
- Gatus endpoint IDs, groups, and URLs must exactly match the catalog.
- Container tags are pinned; the process has a read-only root filesystem, no added capabilities, and `no-new-privileges`.
- Prometheus retention and storage are bounded to prevent unplanned disk exhaustion.
- The CPQ scrape selects only the known demo workload labels in the `default` namespace.
- Portfolio Nginx status stays pod-local; only its exporter sidecar can read it, and Prometheus reaches the exporter through a cluster-private Service.

## Operational caveats

The Docker lab stack shares the CPQ server's CPU, memory, disk, Docker daemon, network, and power. A host failure therefore removes both the application and its monitoring. Incident SQLite data uses a host-mounted runtime directory, but lab backup and restore have not yet been operationally certified. Sprint 6 reads current and previous container logs directly from Kubernetes; it does not provide durable retention after pod deletion or log rotation. cAdvisor also receives privileged, read-only host visibility; that exception is appropriate only for this controlled lab. The public-path Gatus process is not an independent external monitor. The cloud path must use separate failure domains, replicated storage, backups, durable log architecture, and independent probes before it is called production-grade.
