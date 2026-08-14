# Development Lab Monitor — Detailed Sprint Plan

## Planning assumptions

- Sprint length: two weeks.
- Delivery model: one reviewable increment at the end of every sprint.
- Review boundary: implementation may be prepared and validated locally, but no lab or cloud deployment occurs without an explicit deploy decision.
- Product direction: an enterprise operations console using the approved Relay Studio-like density and the existing fall color direction; it is an application, not a marketing site.
- Initial deployment: one Docker Compose stack on the existing CPQ lab server. This is an accepted upskilling-only co-location exception.
- Lab ingress: a user-managed Cloudflare tunnel for `monitor.jefferyhaynes.net`; tunnel credentials and policy remain outside this repository.
- Vantage limitation: the lab's public-path probe checks public URLs from the CPQ host and must never be described as independent external monitoring.
- Cloud intent: every application component must remain portable to managed Kubernetes or a comparable container platform.
- Quality gate: test-driven development, strict types, explicit failures, no committed credentials, and at least 90% coverage for server code.
- Scope discipline: a sprint does not begin until the preceding sprint's review findings are accepted, fixed, or explicitly deferred.

## Release milestones

| Milestone | Sprints | Reviewable outcome |
| --- | --- | --- |
| Monitoring foundation | 0 | Catalog, telemetry stack, probes, and guarded deployment automation |
| Enterprise monitoring MVP | 1–3 | Application shell, lab portal deployment, live deployment inventory, and traffic/performance dashboards |
| Operations workspace | 4–6 | Infrastructure topology, incident operations, and correlated logs/events |
| Enterprise controls | 7–8 | SSO/RBAC and safe synthetic business journeys |
| Cloud-ready release | 9 | Reproducible cloud deployment, backups, upgrades, and operational certification |

## Sprint portfolio

| Sprint | Name | Status | Demonstration at review |
| ---: | --- | --- | --- |
| 0 | Foundation and delivery guardrails | Complete and deployed | Render the stack, validate probes, and show deployment plans without mutating a target |
| 1 | Enterprise application shell | Deployed with Sprint 1.1 | Navigate the approved enterprise shell using fixture data |
| 1.1 | Portal packaging and lab deployment | Deployed and user-verified | Build and run the hardened fixture portal beside the monitoring stack, then review the reversible Cloudflare cutover |
| 2 | Live deployment inventory | Deployed and user-verified | See current status for CPQ, OAuth, Mailpit, and ERPNet from one screen |
| 3 | Traffic and performance | Complete, deployed, and user-verified | Inspect real request rate, errors, saturation, and latency graphs |
| 4 | Infrastructure topology | Complete, deployed, and user-verified | Drill from an environment into workloads, nodes, and dependencies |
| 5 | Alerts and incident operations | Planned | Persist, triage, acknowledge, silence, declare, and resolve alert-driven incidents |
| 6 | Logs and event correlation | Planned | Move from a failed service to relevant logs and Kubernetes events |
| 7 | Enterprise identity and access | Planned | Sign in through OIDC and verify role-scoped actions and audit records |
| 8 | Safe synthetic journeys | Planned | Run non-destructive CPQ/OAuth/Mailpit/ERPNet journeys and see step diagnostics |
| 9 | Cloud-ready operations | Planned | Install, upgrade, back up, restore, and roll back in an isolated target |

## Sprint 0: Foundation and delivery guardrails

### Status

Complete, deployed as the current lab monitoring foundation, and verified.

### Objective

Establish a dependable monitoring substrate and a guarded, repeatable path for reviewing and deploying it.

### Deliverables

- Strict service catalog and JSON Schema.
- Pinned Docker Compose stack for Prometheus, Grafana, Blackbox Exporter, node-exporter, cAdvisor, and two Gatus processes.
- Pinned `kube-prometheus-stack` Helm chart retained as the future cloud deployment path.
- One direct CPQ demo Prometheus scrape.
- Internal Gatus checks and a clearly labeled same-host public-path simulation.
- Status and metrics collection without a mandatory notification integration; delivery remains deferred until its destinations and credential workflow are explicitly approved.
- Single-host Docker, Kubernetes, and independent Gatus deployment scripts with plan, preflight, deploy, status, and verify boundaries.
- Environment and secret preparation runbook.

### Acceptance criteria

- Catalog validation reports six services, seven internal probes, and three external probes.
- Unit tests and strict type checking pass.
- Helm dependency resolution, lint, and template rendering pass with locked versions.
- Internal and external Compose files render successfully.
- The single-host lab Compose model passes both Compose v2 plugin and standalone `docker-compose` validation.
- The pinned Gatus image accepts both configurations while running as a non-root user.
- The CPQ metrics endpoint returns Prometheus text successfully.
- Deployment commands refuse mutation without exact target confirmation.
- Remote synchronization excludes `.env`, credentials, runtime databases, and Git metadata.
- `plan`, `preflight`, and `status` are non-mutating.

### Review gate

Approve or revise retention, resource limits, the cAdvisor host-access exception, secret ownership, Cloudflare Access policy, and loopback exposure rules before executing any deploy command. Kubernetes storage remains a separate cloud-path review.

## Sprint 1: Enterprise application shell

### Status

Implemented and tested locally. Fixture mode is enabled; no monitoring backend or lab deployment was changed.

### Objective

Turn the approved mockup direction into a responsive enterprise web application shell without coupling it to live monitoring systems yet.

### Deliverables

- Frontend architecture decision record and scaffold.
- Fall-color enterprise design tokens with accessible contrast.
- Left navigation, environment selector, global time range, command/search surface, alert indicator, and operator menu.
- Overview, Deployments, Infrastructure, Performance, Incidents, and Settings routes.
- Reusable cards, status badges, tables, chart frames, empty states, errors, skeletons, and stale-data indicators.
- Fixture-driven demo and visual regression baseline.

### Work items

- Convert the approved mockups into a canonical desktop shell at 1440×900 and a usable tablet layout.
- Define typography, spacing, density, semantic health colors, focus states, and chart palette.
- Add keyboard navigation, skip links, landmark structure, and reduced-motion support.
- Define frontend test, coverage, accessibility, lint, type-check, and production-build gates.
- Add a typed data-provider boundary so fixtures can be replaced by live APIs in Sprint 2.

### Acceptance criteria

- A reviewer can navigate every primary route without a backend.
- The result reads as an enterprise operations console rather than a landing page or slide.
- Loading, empty, partial failure, stale, unauthorized, and no-data states are visible and testable.
- No fixture can be mistaken for live data; fixture mode is labeled globally.
- Keyboard and automated accessibility checks pass for primary navigation.
- The production bundle builds reproducibly.

### Non-goals

- Live Prometheus, Gatus, Kubernetes, or log queries.
- Authentication or role enforcement.
- Production packaging and deployment to the lab; this is explicitly owned by Sprint 1.1.

## Sprint 1.1: Portal packaging and lab deployment

### Status

Implemented, deployed, tested, and user-verified before Sprint 2 began. The production image, Compose service, guarded deployment path, automated verification, and rollback runbook remain the Sprint 2 deployment baseline.

### Objective

Package the fixture-backed enterprise portal as a hardened container, add it to the existing CPQ-server Docker Compose profile, and provide a guarded, reversible transition of `monitor.jefferyhaynes.net` from Grafana to the portal.

### Target topology

| Component | Container port | Host binding | Public exposure after cutover |
| --- | ---: | --- | --- |
| Enterprise portal | 8080 | `127.0.0.1:3100` | `monitor.jefferyhaynes.net` through the user-managed Cloudflare tunnel and Access policy |
| Grafana | 3000 | `127.0.0.1:3000` | No longer the root destination; remains internal until a separate hostname is reviewed |
| Prometheus and other operator tools | Existing ports | Loopback | No change |

The portal remains fixture-backed in this increment. Its global fixture banner must remain visible after deployment.

### Deliverables

- Multi-stage portal Dockerfile that builds the tested Vite bundle and serves only production assets from a pinned, unprivileged web-server image.
- Web-server configuration with SPA fallback, `/healthz`, compression, immutable caching for hashed assets, no-cache handling for `index.html`, and reviewed security headers.
- `portal` service in the primary lab Compose stack with a read-only root filesystem, dropped capabilities, `no-new-privileges`, bounded CPU/memory, tmpfs runtime paths, and loopback-only port `3100`.
- Existing guarded lab deployment script extended to synchronize the portal build context and support `plan`, `preflight`, `deploy`, `status`, `verify`, and `logs` without weakening exact-confirmation behavior.
- Automated contract tests for the Docker build, Compose service, port isolation, health check, security controls, remote synchronization exclusions, and deployment-script command surface.
- Cloudflare cutover and rollback runbook. Tunnel credentials, account identifiers, and Access policies stay outside Git and remain user-managed.
- Image/build provenance recorded from the Git commit so an operator can identify and reproduce the deployed portal.

### Work items

- Write failing infrastructure-contract tests before adding the Dockerfile, web-server configuration, Compose service, and script changes.
- Build the portal image locally and on the deployment path; verify that development dependencies and source files are absent from the runtime image.
- Serve `/`, every primary SPA route, static assets, and `/healthz` directly from the container.
- Add remote preflight checks for Docker/Compose capacity, port `3100` availability, required source files, and the existing monitoring runtime configuration.
- Extend verification to check container health, the loopback portal URL, fixture disclosure, representative deep-link routing, existing Grafana health on `3000`, and all monitoring containers.
- Document the explicit Cloudflare sequence: deploy and verify on `3100`, change the tunnel origin, verify public TLS/Access/application behavior, then retain the old Grafana origin as the immediate rollback value.
- Document container and tunnel rollback separately. Application rollback restores the prior portal image; tunnel rollback points `monitor.jefferyhaynes.net` back to `http://localhost:3000`.

### Acceptance criteria

- `docker compose config --quiet` and the repository's standalone-Compose compatibility checks pass.
- A clean production image builds reproducibly from the reviewed commit and starts healthy without root privileges.
- `curl -fsS http://127.0.0.1:3100/healthz` succeeds on the CPQ server.
- Direct requests to `/`, `/deployments`, `/infrastructure`, `/performance`, `/incidents`, and `/settings` return the portal rather than a web-server 404.
- The deployed UI visibly states that data is fixture-backed and does not imply live monitoring.
- Grafana remains healthy on loopback port `3000`; Prometheus, Gatus, exporters, CPQ, OAuth, Mailpit, and ERPNet are not interrupted by the portal deployment.
- The portal stays within its reviewed CPU and memory limits during startup and representative navigation.
- Deployment still requires `--confirm-deploy lab-docker`; plan, preflight, status, verify, and logs remain non-mutating.
- Remote synchronization excludes `.env`, secrets, runtime databases, coverage output, `node_modules`, and local build artifacts.
- The Cloudflare cutover occurs only after local verification and an explicit operator decision. Public verification confirms TLS, Access protection, fixture disclosure, and primary-route navigation.
- Both container rollback and tunnel-origin rollback are documented and exercised in a non-destructive review.

### Failure modes to test

- Port `3100` is occupied or unavailable.
- The portal image fails to build, start, or become healthy within the bounded timeout.
- A deep link returns 404 because SPA fallback is missing.
- The portal becomes public before Cloudflare Access is active.
- The tunnel is changed before local verification completes.
- Grafana is accidentally stopped, exposed publicly, or overwritten by the portal service.
- A partial deployment leaves an unhealthy new container while the existing monitoring stack is still running.
- Rollback references a missing image or an undocumented prior tunnel origin.

### Review gate

Approve the portal port, resource limits, base-image pin, web security headers, Cloudflare Access policy, Grafana disposition, and rollback procedure before running the mutating deployment command or changing the tunnel origin.

### Non-goals

- Live monitoring data or a server API; Sprint 2 owns those integrations.
- Portal authentication or role enforcement; Cloudflare Access is the temporary lab boundary until Sprint 7.
- A public Grafana hostname.
- Kubernetes deployment, registry promotion, multi-host availability, or independent failure domains; Sprint 9 owns cloud operational hardening.

## Sprint 2: Live deployment inventory

Status: implemented and tested locally on 2026-08-12, then deployed, automatically verified, and human-tested through the production UI on 2026-08-13. The initial accepted deployment operated in explicit partial mode. The current deployment has catalog, both Gatus collectors, Kubernetes inventory, and Prometheus evidence available; all six catalog services were healthy during final Sprint 4 acceptance.

### Objective

Replace overview fixtures with a trustworthy, read-only deployment inventory and health model.

### Deliverables

- Typed server/API adapter for the catalog, Gatus, and Kubernetes health summaries.
- Environment and deployment overview with current state, last check, version, endpoint, and ownership.
- Internal-versus-external reachability comparison.
- Data freshness, source attribution, and partial-source failure indicators.
- Service detail summary with direct links to source tools.

### Work items

- Define normalized health states: healthy, degraded, failing, unknown, paused, and stale.
- Preserve source timestamps instead of manufacturing a current timestamp in the UI.
- Add request deadlines, bounded concurrency, and explicit upstream error mapping.
- Redact credentials and sensitive headers from diagnostics.
- Add contract tests using representative Gatus, Kubernetes, and catalog responses.

### Acceptance criteria

- CPQ demo/test, OAuth, Mailpit, and ERPNet appear from the catalog without hard-coded UI records.
- Internal and external probe disagreement is displayed as diagnostic information, not averaged away.
- One failed upstream does not erase healthy data from other sources.
- Stale or unavailable data can never appear healthy.
- Server code meets the 90% coverage gate, including timeout and malformed-upstream paths.
- The API and UI are read-only in this sprint.

## Sprint 3: Traffic and performance

### Status

Complete, deployed, automatically verified, and human-tested. The live performance workspace uses the bounded Prometheus adapter and includes Portfolio request totals and request rate.

### Objective

Add real Prometheus-backed traffic, error, latency, and resource visualizations.

### Deliverables

- Prometheus query adapter with allow-listed query templates.
- Global time range and refresh controls.
- Request rate, error rate, latency percentiles, JVM/process, CPU, memory, pod restart, and saturation panels.
- Service and environment filters.
- Graph legends, units, thresholds, tooltips, no-data states, and query-error states.

### Acceptance criteria

- Graphs use server timestamps and clearly show query windows and resolution.
- Traffic, latency, and error panels are backed by recorded or live Prometheus fixtures in tests.
- Arbitrary PromQL cannot be submitted through public API parameters.
- Expensive ranges are bounded and down-sampled.
- Zero traffic is distinguishable from missing telemetry.
- CPQ demo performance can be correlated to its pod/resource state.

## Sprint 4: Infrastructure topology

### Status

Complete, deployed, automatically verified, and human-tested on 2026-08-14. Acceptance covered three namespaces, one ready node, 14 healthy workloads, 38 returned resources, environment filtering, resource search and details, and service-to-workload deep links.

### Objective

Let operators understand how deployments map to clusters, namespaces, workloads, pods, nodes, storage, and dependencies.

### Deliverables

- Environment topology view.
- Node, namespace, deployment, StatefulSet, pod, service, PVC, and ingress inventory.
- Dependency edges for CPQ, OAuth, Mailpit, ERPNet, Prometheus, and probe nodes.
- Resource pressure, restart, scheduling, and storage-capacity indicators.
- Drill-down drawer with source labels and recent Kubernetes events.

### Acceptance criteria

- Operators can move from an unhealthy catalog service to its Kubernetes workload when a mapping exists.
- Missing mappings are shown explicitly and can be corrected in catalog metadata.
- Crash loops, pending pods, failed mounts, and node pressure have distinct explanations.
- Large inventories remain searchable and usable without rendering every object at once.
- Kubernetes access remains read-only, fixed-resource allow-listed, and namespace-bounded.

## Sprint 5: Alerts and incident operations

### Status

Planned; implementation requires explicit authorization. Incidents currently use session-only UI state and reset on reload. Notification destinations, credential storage, and the trusted source of operator identity remain design decisions rather than assumed integrations.

### Objective

Provide a focused operational workflow for active problems without becoming a full ticketing system.

### Deliverables

- Persistent incident storage and a bounded incident API.
- Live alert ingestion or server-owned alert evaluation with explicit source health.
- Active and resolved alert inbox.
- Severity, owner, environment, source, start time, duration, and related-service filters.
- Persistent acknowledgement, declaration, resolution, silence, maintenance-window, and annotation workflows.
- Runbook associations and an append-only audit history.
- Incident timeline assembled from monitoring events, state transitions, and operator annotations.
- Notification destination and credential-handling design; no delivery channel is assumed before approval.

### Acceptance criteria

- An acknowledged, declared, or resolved incident and its audit history survive an application restart without duplication or loss.
- Every state change validates the current state, requires confirmation, actor identity, and reason, and writes exactly one timestamped audit record.
- Invalid, repeated, stale, or out-of-order transitions fail explicitly and do not partially mutate incident or audit state.
- Silence scope and expiration are shown before submission; expired silences stop suppressing alerts without erasing their history.
- Duplicate alerts are grouped without losing per-source evidence, and a failed alert source cannot produce a false resolved or healthy state.
- Missing notification configuration is explicit. If delivery is later approved, delivery failure remains visible and never marks an incident resolved.
- Representative alert, acknowledgement, silence-expiry, declaration, resolution, restart, duplicate-delivery, malformed-input, and partial-source sequences pass deterministic tests.
- Server coverage remains at least 90%, including persistence failures and invalid transition branches.

### Failure modes to test

- Incident storage is unavailable, read-only, full, corrupt, or at an unsupported schema version.
- The process stops between an incident transition and its audit write; recovery must not leave one without the other.
- The same alert is delivered repeatedly, or resolution arrives before firing evidence because of retry or clock skew.
- Two operators submit conflicting transitions from stale incident versions.
- Actor identity is absent, malformed, or supplied through an untrusted header.
- A silence is overbroad, has no bounded expiration, expires during downtime, or is evaluated with a skewed clock.
- One alert source times out or returns malformed or oversized data while other sources remain valid.
- Runbook metadata points to an unknown service, unsafe URL, missing target, or stale association.
- Notification configuration is absent, rejected, or unavailable; credentials or sensitive destination data must not enter API responses, logs, audit records, or committed files.
- Unsupported methods, oversized fields, invalid filters, and unbounded history requests are rejected without partial mutation.

## Sprint 6: Logs and event correlation

### Objective

Add bounded log search and correlate application, probe, and Kubernetes evidence around a failure.

### Deliverables

- Selected log backend and collection architecture.
- Time-bounded service/pod log viewer.
- Search by environment, service, pod, severity, and correlation ID.
- Kubernetes event stream and links from metrics/alerts into the relevant time window.
- Downloadable redacted diagnostic bundle.

### Acceptance criteria

- An operator can move from a failed health probe to relevant logs without rebuilding the time filter.
- Queries have enforced time, row, and concurrency limits.
- Secret and token patterns are redacted before UI display or export.
- Log-backend failure does not break health and metrics screens.
- Diagnostic bundles declare included sources, omissions, and redactions.

## Sprint 7: Enterprise identity and access

### Objective

Protect the console with OIDC and enforce least-privilege operator roles.

### Deliverables

- OIDC login/logout through the selected enterprise provider.
- Viewer, Operator, and Administrator roles.
- Server-side authorization for every non-read-only action.
- Session expiry, forbidden, provider-unavailable, and clock-skew states.
- Audit log for authentication and operational changes.

### Acceptance criteria

- Anonymous users cannot access monitoring data unless an explicitly approved public status view exists.
- UI hiding is never the only authorization control.
- Viewer cannot acknowledge or silence alerts.
- Operator cannot change identity, retention, or integration settings.
- Role and tenant/environment boundaries have negative-path tests.
- Authentication failures do not leak tokens or provider details.

## Sprint 8: Safe synthetic journeys

### Objective

Monitor user-relevant behavior without creating unsafe or accumulating test data.

### Deliverables

- Versioned journey definitions and runner isolation policy.
- OAuth token acquisition and CPQ authenticated-read journey.
- CPQ create/read/update/cleanup journey using dedicated synthetic records.
- Mailpit delivery confirmation journey.
- ERPNet read-only or explicitly approved reversible journey.
- Step duration, failure reason, cleanup status, and evidence views.

### Acceptance criteria

- Journeys use dedicated least-privilege identities and isolated data markers.
- Destructive or irreversible operations are prohibited by policy and tests.
- Cleanup runs after both success and recoverable failure.
- A cleanup failure raises a separate alert and records the orphan identifier.
- Secrets are unavailable to the browser and redacted from every artifact.
- Each journey can be disabled independently without editing application code.

## Sprint 9: Cloud-ready operations

### Objective

Turn the reviewed product into a reproducible, supportable deployment for the lab and future cloud environments.

### Deliverables

- Application Helm chart and environment value overlays.
- Ingress/TLS, external secret integration, network policies, resource limits, and pod security settings.
- CI build, scan, package, and promotion workflow.
- Database/volume backup and restore procedures.
- Upgrade, rollback, disaster-recovery, and version-compatibility runbooks.
- Isolated cloud validation environment and cost envelope.

### Acceptance criteria

- A clean environment can be installed from versioned artifacts without manual file editing.
- Production-like deployment requires exact environment and release confirmation.
- Upgrade and rollback complete without losing catalog, alert, or audit data.
- Backup restoration is exercised, timed, and documented.
- Secrets remain outside Git, images, rendered manifests, and CI logs.
- Security, availability, observability, and cost review findings are resolved or explicitly accepted.

## Cross-sprint definition of done

Every sprint must satisfy all applicable items:

- Acceptance criteria are automated where practical and manually demonstrated otherwise.
- Unit, integration, end-to-end, strict type, lint, accessibility, and build gates relevant to the increment pass.
- Server coverage is at least 90%; critical authorization and destructive-action branches receive explicit tests.
- Loading, empty, stale, partial failure, timeout, malformed data, forbidden, and oversized-input behavior are considered.
- Documentation, threat assumptions, deployment notes, and rollback guidance are updated.
- No credentials, tokens, `.env` files, generated databases, or diagnostic secrets are committed.
- The sprint review records approve, revise, or defer decisions before the next sprint begins.
