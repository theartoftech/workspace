# Development Lab Observability

This standalone repository is the first reviewable monitoring slice for the CPQ development lab. Its primary upskilling profile is a single Docker Compose stack on the CPQ server. It defines the service catalog, one direct CPQ Prometheus scrape, host/container telemetry, internal checks, and a same-host public-path simulation. The Kubernetes Helm stack remains the future cloud path. Nothing deploys automatically.

Development is organized as reviewable two-week increments in the [detailed sprint plan](documentation/detailed-sprint-plan.md). Sprint 0 covers this monitoring foundation and deployment guardrails; Sprint 1 begins the enterprise web application shell.

## Foundation scope

| Capability | Included in this slice |
| --- | --- |
| Service catalog | Strict JSON contract for CPQ demo/test, OAuth, Mailpit, and ERPNet |
| Primary lab monitoring | Docker Compose with Prometheus, Grafana, Blackbox Exporter, node-exporter, cAdvisor, and Gatus |
| Future cloud monitoring | `kube-prometheus-stack` Helm chart with Prometheus, Grafana, Alertmanager, and Kubernetes metrics |
| Synthetic probe support | Prometheus Blackbox Exporter plus dedicated Gatus nodes |
| Direct application metrics | CPQ demo `/api/actuator/prometheus` through one `ServiceMonitor` |
| Internal reachability | CPQ demo/test, OAuth demo/test, Mailpit, and ERPNet from the CPQ server |
| Public-path simulation | Public CPQ demo and ERPNet URLs, including TLS expiry, from the same CPQ server—not an independent external vantage |
| Alert delivery | Deferred until notification destinations and credential handling are selected |

The enterprise portal, SSO for monitoring tools, safe transaction journeys, log aggregation, additional application scrapes, and deployment automation remain intentionally outside this foundation slice.

## Repository layout

- `catalog/services.json` — operator-readable source of truth for monitored services and probes.
- `catalog/schema.json` — portable JSON Schema for editors and future integrations.
- `src/lab_observability/catalog.py` — strict runtime validation with explicit errors.
- `deploy/helm/lab-observability` — pinned umbrella Helm chart for the k3s monitoring namespace.
- `deploy/compose/lab-observability` — primary single-host Docker lab stack.
- `deployment/scripts` — guarded plan, preflight, deploy, status, and verification commands.
- `deployment/ENVIRONMENTS.md` — target topology, secret preparation, and operator workflow.
- `probes/internal` — Gatus node intended to run inside the lab network.
- `probes/external` — Gatus node intended to run on an independent public host.
- `tests` — catalog, drift, security-default, and infrastructure contract tests.
- `web/src` — Sprint 1 enterprise monitoring shell, typed fixture provider, reusable components, and UI tests.
- `documentation/adr` — architecture decisions for review before later live-data integration.

## Review the Sprint 1 enterprise shell

Sprint 1 is a local, fixture-backed review build. It does not query or modify Prometheus, Gatus, Grafana, Kubernetes, Docker, or the CPQ server.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The persistent amber banner identifies every value as fixture data. Navigate with the left rail or press `/` to open command search.

Run the complete frontend quality gate with:

```sh
npm test
npm run test:coverage
npm run test:a11y
npm run typecheck
npm run lint
npm run build
```

The approved route set is Overview, Deployments, Infrastructure, Performance, Incidents, and Settings. Live provider adapters, authentication, and deployment of this shell remain later-sprint work.

## Acceptance criteria

The slice is ready to deploy when all of these are true:

1. `python3 scripts/validate_catalog.py` reports five services, six internal probes, and two external probes.
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

For Sprint 0, route the user-managed `monitor.jefferyhaynes.net` Cloudflare tunnel to `http://localhost:3000` on the CPQ server and protect it with Cloudflare Access. Tunnel credentials stay outside Git.

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
- Credentials, sensitive query keys, invalid URLs, and TLS checks on plain HTTP are rejected.
- Probe timeout must remain shorter than its interval.
- Gatus endpoint IDs, groups, and URLs must exactly match the catalog.
- Container tags are pinned; the process has a read-only root filesystem, no added capabilities, and `no-new-privileges`.
- Prometheus retention and storage are bounded to prevent unplanned disk exhaustion.
- The CPQ scrape selects only the known demo workload labels in the `default` namespace.

## Operational caveats

The Docker lab stack shares the CPQ server's CPU, memory, disk, Docker daemon, network, and power. A host failure therefore removes both the application and its monitoring. cAdvisor also receives privileged, read-only host visibility; that exception is appropriate only for this controlled lab. The public-path Gatus process is not an independent external monitor. The cloud path must use separate failure domains, replicated storage, backups, and independent probes before it is called production-grade.
