# Development Lab Observability

This standalone repository is the reviewable monitoring application for the CPQ development lab. Its primary profile is a single Docker Compose stack on the CPQ server. Sprint 3 adds bounded, read-only Prometheus performance queries and live traffic, error, latency, and saturation graphs to the Sprint 2 inventory portal. Sprint 2 was deployed and passed automated verification and human UI acceptance on 2026-08-13; Sprint 3 is implemented locally and deployment remains an explicit operator action.

Development is organized as reviewable increments in the [detailed sprint plan](documentation/detailed-sprint-plan.md). Sprint 0 covers the monitoring foundation, Sprint 1 and 1.1 provide the portal and guarded lab deployment, and Sprint 2 implements live deployment inventory.

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
| Alert delivery | Deferred until notification destinations and credential handling are selected |

Overview, deployments, and service detail use live inventory. Performance uses live Prometheus range queries. Infrastructure, incidents, and settings remain explicitly labeled fixture previews until their planned sprints. SSO, safe transaction journeys, log aggregation, and additional application scrapes remain later-sprint work.

## Repository layout

- `catalog/services.json` — operator-readable source of truth for monitored services and probes.
- `catalog/schema.json` — portable JSON Schema for editors and future integrations.
- `src/lab_observability/catalog.py` — strict runtime validation with explicit errors.
- `deploy/helm/lab-observability` — pinned umbrella Helm chart for the k3s monitoring namespace.
- `deploy/compose/lab-observability` — primary single-host Docker lab stack.
- `deploy/portal` — digest-pinned multi-stage portal image and hardened Nginx runtime.
- `deploy/inventory-api` — digest-pinned, unprivileged Node image for the read-only inventory API.
- `deploy/kubernetes/inventory-reader-rbac.yaml` — namespace-bounded, get-only Kubernetes RBAC.
- `server/src` and `shared` — typed upstream adapters, aggregation/API logic, and browser/server contracts.
- `deployment/scripts` — guarded plan, preflight, deploy, status, and verification commands.
- `deployment/PORTAL_ROLLBACK.md` — independent portal-image and Cloudflare-origin rollback procedures.
- `deployment/ENVIRONMENTS.md` — target topology, secret preparation, and operator workflow.
- `probes/internal` — Gatus node intended to run inside the lab network.
- `probes/external` — Gatus node intended to run on an independent public host.
- `tests` — catalog, drift, security-default, and infrastructure contract tests.
- `web/src` — enterprise shell, live and fixture providers, service detail, reusable components, and UI tests.
- `documentation/adr` — architecture decisions for review before later live-data integration.

## Review the Sprint 3 performance workspace

Build and run the read-only API against the already deployed lab Gatus endpoints:

```sh
npm install
npm run build:server
GATUS_INTERNAL_API_URL=http://192.168.86.246:8085/api/v1/endpoints/statuses \
GATUS_PUBLIC_PATH_API_URL=http://192.168.86.246:8186/api/v1/endpoints/statuses \
PROMETHEUS_API_URL=http://192.168.86.246:9090 \
  node dist-server/server/src/main.js
```

In another console, start the portal:

```sh
npm run dev
```

Vite proxies `/api` to the local API on port `3001`; the deployed Compose profile provides the equivalent same-origin proxy. Open `/performance` to inspect bounded 15-minute through 24-hour ranges, filter by environment or service, and refresh every live view. The persistent data banner distinguishes live, partial, and test-fixture states. Navigate with the left rail or press `/` to open command search.

Run the complete frontend quality gate with:

```sh
npm test
npm run test:server:coverage
npm run test:coverage
npm run test:a11y
npm run typecheck
npm run lint
npm run build
```

The live route set includes Overview, Deployments, Performance, and `/services/<catalog-id>`. Infrastructure, Incidents, and Settings retain explicit preview data. The API accepts only GET/HEAD; performance queries are selected from server-owned templates, ranges are bounded and down-sampled, and the browser never receives infrastructure credentials or arbitrary PromQL access.

## Acceptance criteria

The slice is ready to deploy when all of these are true:

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
- Credentials, sensitive headers, URL userinfo, and secret query values are redacted from diagnostics.
- Credentials, sensitive query keys, invalid URLs, and TLS checks on plain HTTP are rejected.
- Probe timeout must remain shorter than its interval.
- Gatus endpoint IDs, groups, and URLs must exactly match the catalog.
- Container tags are pinned; the process has a read-only root filesystem, no added capabilities, and `no-new-privileges`.
- Prometheus retention and storage are bounded to prevent unplanned disk exhaustion.
- The CPQ scrape selects only the known demo workload labels in the `default` namespace.
- Portfolio Nginx status stays pod-local; only its exporter sidecar can read it, and Prometheus reaches the exporter through a cluster-private Service.

## Operational caveats

The Docker lab stack shares the CPQ server's CPU, memory, disk, Docker daemon, network, and power. A host failure therefore removes both the application and its monitoring. cAdvisor also receives privileged, read-only host visibility; that exception is appropriate only for this controlled lab. The public-path Gatus process is not an independent external monitor. The cloud path must use separate failure domains, replicated storage, backups, and independent probes before it is called production-grade.
