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
| Enterprise controls | 7–8 | SSO/RBAC, PostgreSQL observability, and safe synthetic business journeys |
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
| 5 | Alerts and incident operations | Complete, deployed, and user-verified | Persist, triage, acknowledge, silence, declare, and resolve alert-driven incidents |
| 6 | Logs and event correlation | Complete, deployed, and user-verified | Move from a failed service to relevant logs and Kubernetes events |
| 7 | Enterprise identity and access | Deployed and automatically verified; human acceptance in progress | Validate Cloudflare Access identity and verify role-scoped actions and audit records |
| 7.1 | PostgreSQL observability | Complete, deployed, and user-verified | Diagnose database availability, saturation, contention, and growth without exposing PostgreSQL publicly |
| 8 | Safe synthetic journeys | Foundation deployed; live activation explicitly deferred | Keep the disabled foundation isolated while separately tracking live identities, adapters, persistence, schedules, and acceptance |
| 9 | Cloud-ready operations | In progress; decision and architecture phase | Install, upgrade, back up, restore, and roll back in an isolated target |

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

Complete, deployed, automatically verified, and human-tested in the lab on 2026-08-14. Human acceptance confirmed persistent operator incident creation, live source and identity disclosure, audit evidence, and stale-version conflict handling that rejected a conflicting silence without saving it. Notification delivery remains explicitly unconfigured. The deployed Sprint 6 runtime still uses one server-configured lab operator identity; the locally tested Sprint 7 candidate replaces it with validated Cloudflare Access identity and continues to reject browser-selected actor fields.

### Objective

Provide a focused operational workflow for active problems without becoming a full ticketing system.

### Deliverables

- Persistent incident storage and a bounded incident API.
- Live alert ingestion or server-owned alert evaluation with explicit source health.
- Active and resolved alert inbox.
- Active/resolved, environment, severity, and text triage controls with service, owner, source, start time, and evidence context.
- Persistent acknowledgement, declaration, resolution, and bounded silence workflows.
- Runbook associations and an append-only audit history.
- Incident timeline assembled from monitoring events, state transitions, and operator annotations.
- An explicit unconfigured notification state; destination selection, delivery, and credential storage require a separate approved design.

### Acceptance criteria

- An acknowledged, declared, or resolved incident and its audit history survive an application restart without duplication or loss.
- Every state change validates the current state, requires confirmation, actor identity, and reason, and writes exactly one timestamped audit record.
- Invalid, repeated, stale, or out-of-order transitions fail explicitly and do not partially mutate incident or audit state.
- Silence scope and expiration are shown before submission; expired silences stop suppressing alerts without erasing their history.
- Duplicate alerts are grouped without losing per-source evidence, and a failed alert source cannot produce a false resolved or healthy state.
- Missing notification configuration is explicit. If delivery is later approved, delivery failure remains visible and never marks an incident resolved.
- Representative alert, acknowledgement, silence-expiry, declaration, resolution, restart, duplicate-delivery, malformed-input, and partial-source sequences pass deterministic tests.
- Server coverage remains at least 90%, including persistence failures and invalid transition branches.

### Local verification

- Alert evaluation groups a repeated service-health fingerprint while preserving per-source evidence and occurrence counts.
- Recovery remains active for operator review; later alert recurrence and post-resolution evidence produce audited recurrence or reopening transitions.
- Declarations and acknowledgement, declaration, silence, expiration, and resolution transitions commit incident state and exactly one audit record in one SQLite transaction.
- Optimistic versions reject stale operators; unsupported, repeated, malformed, oversized, and out-of-order commands do not partially mutate state.
- Incident reads are non-mutating. Evaluation runs at startup and on a non-overlapping bounded interval.
- Server coverage is 99.21% statements/lines, 92.78% branches, and 98.54% functions across 81 tests.

### Post-sprint operational follow-up

- Confirm the host-mounted database remains intact across a subsequent container replacement and restart.
- Define and test a recoverable SQLite backup/restore procedure before treating the lab incident database as durable operational recordkeeping.
- Keep notification delivery unconfigured until destinations, credentials, retry semantics, and failure disclosure are explicitly approved.

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

### Status

Complete, deployed, and user-verified on 2026-08-15. The namespace-bounded `pods/log` rule was reviewed and applied separately to the existing inventory service account; the deployment script did not apply or change RBAC. Deployment verification and the Sprint 6 human acceptance script passed after correcting k3s pod-log content negotiation.

### Objective

Add bounded log search and correlate application, probe, and Kubernetes evidence around a failure.

### Deliverables

- Selected log backend and collection architecture.
- Time-bounded service/pod log viewer.
- Search by environment, service, pod, severity, and correlation ID.
- Kubernetes event stream and links from metrics/alerts into the relevant time window.
- Downloadable redacted diagnostic bundle.

### Implemented architecture

- Uses the Kubernetes Pod Log API as the bounded lab source; no durable log aggregation or retention backend is implied.
- Resolves catalog `Deployment` mappings to pods through server-read selectors and resolves catalog `Pod` mappings by exact name. The browser cannot select namespaces, arbitrary resource paths, label selectors, or Kubernetes query parameters.
- Restricts windows to 15 minutes, 1 hour, 6 hours, or 24 hours; caps pods at 8, current/previous container streams at 16, returned lines at 500, relevant events at 5 per object and 50 overall, each upstream log body at 64 KiB, and Kubernetes concurrency at 4 by default.
- Retrieves previous logs only for containers with observed restarts. One stream or event-source failure produces an explicit partial result and omission instead of erasing successful evidence.
- Redacts credential URLs, bearer values, sensitive headers, common key/value secrets, and common JSON secret fields before the browser response or diagnostic export is assembled.
- Links service details, performance correlation, and selected incidents to `/logs` while preserving the selected global range in the URL.
- Generates diagnostic JSON only from a server response that declares redaction. The bundle retains sources, omissions, filters-applied flags, caps, and truncation metadata.

### Acceptance criteria

- An operator can move from a failed health probe to relevant logs without rebuilding the time filter.
- Queries have enforced time, row, and concurrency limits.
- Secret and token patterns are redacted before UI display or export.
- Log-backend failure does not break health and metrics screens.
- Diagnostic bundles declare included sources, omissions, and redactions.

### Failure modes to test

- The Kubernetes token is missing, empty, expired, or lacks `pods/log` while ordinary inventory and events remain readable.
- A Deployment selector is missing or malformed, maps no current pods, or maps more pods than the server cap.
- A pod has multiple containers, a restarted container has no previous log, or one container returns unauthorized, timeout, oversized, or malformed text.
- Log lines omit timestamps, use nanosecond timestamps, exceed the per-line display bound, contain JSON secrets, or contain credentials in headers, URLs, and key/value forms.
- Search text, correlation IDs, pod names, environment/service relationships, ranges, severities, duplicate parameters, and unsupported parameters are invalid or oversized.
- Events are missing timestamps, outside the selected window, unrelated to the mapped workload, over the event cap, or unavailable while log streams remain valid.
- A result contains zero matching lines because of filters; the UI must distinguish that from an unavailable source and never display missing evidence as zero activity.
- Browser diagnostic export is unavailable or receives evidence without the required redaction declaration.

### Non-goals

- Durable, multi-node log aggregation, indexing, retention, backup, or deleted-pod history.
- Arbitrary Kubernetes log access, shell access, exec, attach, watch, mutation, or cluster-wide namespace enumeration.
- Notification destinations, notification credentials, enterprise identity, or application RBAC.

## Sprint 7: Enterprise identity and access

### Status

Implemented, deployed, and automatically verified on 2026-08-16. Cryptographic validation of the existing Cloudflare Access application assertion, exact host-provisioned roles, authenticated incident attribution, browser role awareness, authentication audit, reverse-proxy protection, and deployment guardrails are complete. Public-browser acceptance confirmed Cloudflare login, the configured Operator identity, and the corrected logout flow. Viewer and Administrator role-matrix checks remain open before Sprint 7 can be marked fully accepted. No repository-managed Cloudflare configuration was changed.

### Objective

Reuse the existing Cloudflare Access login boundary, validate its signed identity at the origin, and enforce least-privilege operator roles.

### Deliverables

- RS256 validation of the exact Cloudflare Access team issuer and Workspace Monitor application audience through rotating remote JWKS.
- Explicit rejection of malformed, expired, premature, excessive-lifetime, wrong-issuer, wrong-audience, wrong-type, organization, and service assertions.
- Exact host-only email-to-display-name Viewer, Operator, and Administrator mappings with no wildcards or domain grants.
- Server-side authorization for every incident mutation and the administrator-only authentication-audit API.
- Same-origin mutation checks, bounded assertion lifetime and clock skew, Access logout, and fail-closed signing-key retrieval.
- Safe same-origin identity endpoint plus browser read-only behavior for Viewers without treating UI hiding as authorization.
- Authentication and authorization audit records with bounded, secret-free metadata; authenticated incident audit attribution for successful operations.
- Nginx authentication enforcement for pages, assets, monitoring APIs, and proxied source tools while retaining only public `/healthz`.
- Deployment preflight for the mandatory team domain, audience, persistent audit storage, and an individually mounted UID/GID `10001`, mode-`0400` role-mapping file.

### Acceptance criteria

- Anonymous requests cannot access protected pages, assets, monitoring APIs, incident data, or proxied source tools.
- Authenticated Viewers can read monitoring evidence but cannot declare, acknowledge, silence, or resolve incidents.
- Operators can run only the existing approved incident commands; Administrators add only the authentication-audit read capability.
- Every mutation derives actor ID, display name, and role from the newly validated Access assertion; browser actor or role fields are rejected.
- Expired, malformed, incorrectly signed, wrong-audience, wrong-issuer, wrong-type, service, organization, or unmapped assertions fail closed.
- Signing-key endpoint failure returns an explicit unavailable state and never falls back to the configured lab actor or grants access.
- Authorization failures reveal no assertions, cookies, raw claims, signing keys, upstream details, or protected evidence.
- Authentication audit records actor, action, outcome, reason code, and bounded metadata; incident audit records the authenticated actor for successful mutations.
- Server coverage remains at least 90%; automated deployment verification proves anonymous fail-closed behavior and human acceptance proves all three configured roles.

### Failure modes to test

- Missing, malformed, oversized, expired, premature, wrong-key, wrong-algorithm, wrong-issuer, or wrong-audience assertions.
- Organization and service tokens, invalid subjects/emails/timestamps, and clock skew outside the approved tolerance.
- The remote Access JWKS endpoint is unavailable, times out, rotates keys, or returns no matching key.
- The role mapping is missing, corrupt, incorrectly owned, too permissive, duplicated, wildcarded, empty, oversized, or does not contain the identity.
- Viewer and anonymous clients call every mutation directly; browser payloads add actor/role fields; origin/fetch-site headers are missing or cross-site.
- Authentication and authorization errors attempt to place assertions, cookies, personal claims, signing keys, provider details, or unbounded values in responses and audit records.

### Deployment decisions still required

- Approve the exact existing Cloudflare Access team domain and Workspace Monitor application audience.
- Approve exact individual Viewer, Operator, and Administrator email/display-name mappings with no wildcard grants.
- Approve secure role-file transfer, atomic replacement, emergency removal, audit-database backup, and API restart procedures.
- Confirm Cloudflare configuration remains outside this repository and neither CPQ nor Keycloak requires a change.
- Identify human test users for all three roles and explicitly authorize deployment after the mapping file is provisioned.

See [ADR 0007](adr/0007-enterprise-identity-access.md) for the complete architecture and failure contract.

## Sprint 7.1: PostgreSQL observability

### Status

Complete, deployed, automatically verified, and human-tested on 2026-08-16. Independent PostgreSQL 17 services for CPQ Demo (`default`) and CPQ Test (`cpq-test`) now have separate `pg_read_all_stats`-only monitoring roles, namespace-local Secrets, hardened private exporters, allowlisted Prometheus evidence, recording and alert rules, and bounded portal panels. Both exporters were Ready with no restarts and reported `pg_up == 1`; the existing database pods remained available without replacement. Deployment verification passed, and public-browser acceptance confirmed current PostgreSQL evidence for both CPQ environments without adding PostgreSQL to the application service catalog. ERPNext/MariaDB and Keycloak storage remain out of scope.

### Objective

Add direct, least-privilege PostgreSQL health and performance evidence so operators can distinguish database failures from application and synthetic-journey failures.

### Deliverables

- A pinned PostgreSQL exporter deployed on private networking beside each explicitly approved PostgreSQL instance.
- A dedicated read-only monitoring database role with only the minimum exporter permissions and separately provisioned credentials.
- Private Prometheus scrape configuration with no public PostgreSQL, exporter, browser-tool, or Cloudflare tunnel exposure.
- Environment- and service-scoped metrics for exporter/database availability, connection utilization, transaction rate, lock waits, deadlocks, long-running transactions, database size/growth, and replication lag where replication exists.
- Bounded Workspace Monitor performance evidence and incident rules for the approved database signals, with honest unavailable, partial, stale, and no-data states.
- Deployment preflight, verification, rollback, and credential-rotation guidance that does not print connection strings or credentials.
- An explicit decision on whether `pg_stat_statements` is justified; it remains disabled unless its operational overhead and query-privacy implications are approved.

### Acceptance criteria

- Each approved PostgreSQL instance produces a current `pg_up` signal and the bounded metrics approved for its topology.
- Prometheus and the exporter reach PostgreSQL only over approved private paths; no new public hostname, LoadBalancer, tunnel, or browser route is created.
- The monitoring role cannot create, update, delete, truncate, execute application mutations, manage roles, or read application row data beyond explicitly required statistics views.
- Workspace Monitor identifies the affected environment and database dependency without exposing hosts, usernames, connection strings, queries, bind values, schema contents, or credentials.
- Connection saturation, sustained lock contention, deadlocks, unavailable exporters, unavailable databases, stale scrapes, and excessive metric cardinality have explicit and tested behavior.
- A missing or invalid monitoring credential fails only the affected database evidence and never causes live mode to use fixtures or treat the database as healthy.
- Existing PostgreSQL, CPQ, Keycloak, Grafana, Prometheus, Gatus, and portal workloads remain available during a guarded deployment and rollback exercise.
- Automated tests, lint, type checks, builds, deployment contracts, and accessibility checks pass; server coverage remains at least 90%.

### Failure modes to test

- PostgreSQL is unreachable, restarting, read-only, overloaded, or rejects the monitoring connection.
- The exporter is unavailable, times out, returns malformed metrics, or reports a stale scrape.
- Credentials are missing, expired, rotated, incorrectly owned, over-privileged, or accidentally included in a diagnostic path.
- One environment fails while other database evidence remains valid and clearly labeled partial.
- Metrics are absent because a feature such as replication or a statistics extension is not enabled.
- Lock, database, table, or query labels create unsafe cardinality or reveal sensitive identifiers.
- Alert thresholds flap during short maintenance windows or remain silently healthy after evidence disappears.

### Accepted deployment decisions

- CPQ Demo and CPQ Test are the complete initial PostgreSQL scope and remain independently credentialed and monitored.
- Each exporter is namespace-local and private. The existing trusted single-node lab transport uses explicitly accepted `sslmode=disable`; future TLS hardening must use verified certificates and `verify-full` rather than silently weakening validation.
- Each database role receives only `CONNECT`, `pg_read_all_stats`, bounded timeouts, and a connection limit of two. Credentials remain namespace-local and outside Git and deployment archives.
- Prometheus retains only the approved metric allowlist and catalog service/environment labels. Database, schema, host, username, connection, application, and query labels are not exposed to the portal.
- `pg_stat_statements`, query text, table/index/WAL collectors, and replication collectors remain disabled. Notification delivery and persistent incident ingestion of these alert rules remain unconfigured.
- Rotation, revocation, rollback, and any later PostgreSQL TLS work remain explicit operator procedures rather than deployment-script side effects.

See [ADR 0008](adr/0008-postgresql-observability.md), the [Sprint 7.1 operator runbook](../deployment/POSTGRESQL_OBSERVABILITY.md), and the [human acceptance record](sprint-7.1-human-test-script.md).

### Non-goals

- Public database or exporter access, a Cloudflare database tunnel, or browser query tooling.
- Query execution, schema browsing, row inspection, database administration, or automatic remediation.
- Backup, restore, disaster recovery, storage migration, or production data retention; Sprint 9 owns those capabilities.
- Durable database log aggregation or unrestricted slow-query capture.

## Sprint 8: Safe synthetic journeys

Status: in progress. The versioned disabled-by-default execution policy, cleanup/replay invariants, read-only evidence API, and `/journeys` view are implemented. Live identities, endpoint bindings, persistence, schedules, and application mutations remain blocked on the decisions in [ADR 0009](adr/0009-safe-synthetic-journey-foundation.md) and the [Sprint 8 threat model](sprint-8-threat-model.md).

Review-gate decision recorded 2026-08-18: the remaining live-activation work is explicitly deferred from Sprint 9. Sprint 8 remains open and incomplete, all four journeys remain independently disabled, and Sprint 9 must not create journey identities, credentials, provider adapters, persistence, schedules, or live mutations.

Deferred Sprint 8 scope remains tracked as:

- approved dedicated identities and authentication contracts;
- environment-bound CPQ, Mailpit, ERPNext, and OAuth adapters;
- persistent execution claims, restart recovery, evidence retention, and orphan handling;
- scheduler, cadence, concurrency, retry, alerting, and any manual-run authorization; and
- live activation plus separate automated and human acceptance.

Re-entering this work requires its own decisions, test-first implementation, deployment authorization, and acceptance record. The deferral satisfies the preceding-sprint review gate for starting Sprint 9 but does not mark Sprint 8 complete.

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

Status: in progress at the decision and architecture phase. The Sprint 8 review gate was satisfied by the explicit dated deferral above; Sprint 8 remains open. No cloud, Kubernetes, secret, backup, restore, DNS/TLS, CI-credential, or persistent-data mutation is authorized. See the [Sprint 9 discovery and decision record](sprint-9-cloud-operations-plan.md) and [cloud-operations threat model](sprint-9-threat-model.md).

Accepted network decision as of 2026-08-18: CPQ Demo and Test PostgreSQL must both be permanently cluster-only. Laptop investigation uses an on-demand encrypted tunnel for DBVisualizer; a future cloud DB Manager must use in-cluster or approved private-network access. The live Demo `LoadBalancer` remediation is tracked as a separate test-first implementation step and has not yet been applied.

Accepted local-validation decision as of 2026-08-19: the first isolated target is a disposable `kind` cluster backed by a dedicated Lima container runtime. All heavyweight VM, container, cluster, volume, and generated test-data storage must live in a grow-on-demand APFS disk image with a 200 GiB maximum, stored on the external T7 SSD; the existing exFAT T7 volume must not be reformatted. Implementation repeats the test, diagnose, fix, and full-retest loop until every approved gate passes. Before Test/Demo promotion, the disposable cluster, runtime, virtual disks, volumes, networks, temporary credentials, and generated data are deleted, while only versioned source/artifacts and redacted certification evidence are retained.

Accepted cloud, cost, and coexistence decision as of 2026-08-19: AWS is the future managed-cloud certification target, but the EKS certification environment is deferred to the Sprint 9 future-work bucket. The current AWS out-of-pocket ceiling is absolute $0, and Sprint 9 creates no AWS account or billable AWS resource. The AWS path remains additive and independently deployable; Docker Compose is the primary lab profile and must operate normally when AWS is unavailable, unconfigured, unauthenticated, or fully torn down. Sprint 9 must not make lab startup, deployment, monitoring, identity, storage, rollback, or recovery depend on AWS, must not automatically copy lab data into AWS, and must not replace the lab profile without a later explicit decision.

Accepted Helm ownership decision as of 2026-08-19: use separate release boundaries. The `workspace-monitor` application chart owns the portal, API, approved application persistence, application Services, service accounts/RBAC, NetworkPolicies, Pod Security settings, and approved portal Ingress. Prometheus, Grafana, Alertmanager, Blackbox, Gatus, exporters, and monitored applications remain outside application upgrade and rollback, with an optional observability composition chart providing independently managed integration.

Accepted supporting-release decision as of 2026-08-19: Gatus, the Demo PostgreSQL exporter, and the Test PostgreSQL exporter are independently managed Helm releases rather than embedded dependencies of the application or core observability release. A versioned installation workflow coordinates them without merging credentials, persistent data, health gates, Helm revision histories, or rollback boundaries.

Accepted artifact-registry decision as of 2026-08-19: iterative local validation uses an ephemeral registry backed by the T7 validation environment, while approved Workspace Monitor images and Helm OCI packages are published publicly through GHCR. Published artifacts must contain no credentials, environment configuration, or lab data and must be selected by immutable digest rather than mutable deployment tags. The lab does not depend on AWS ECR.

### Objective

Turn the reviewed product into a reproducible, supportable deployment for the lab and future cloud environments.

### Deliverables

- Application Helm chart and environment value overlays.
- Ingress/TLS, external secret integration, network policies, resource limits, and pod security settings.
- CI build, scan, package, and promotion workflow.
- Database/volume backup and restore procedures.
- Upgrade, rollback, disaster-recovery, and version-compatibility runbooks.
- Local isolated Kubernetes validation and a versioned future AWS/EKS certification plan with cost and authorization gates.

### Acceptance criteria

- A clean environment can be installed from versioned artifacts without manual file editing.
- Production-like deployment requires exact environment and release confirmation.
- Upgrade and rollback complete without losing catalog, alert, or audit data.
- Backup restoration is exercised, timed, and documented.
- Secrets remain outside Git, images, rendered manifests, and CI logs.
- Security, availability, observability, and cost review findings are resolved or explicitly accepted.
- Docker Compose lab plan, preflight, deployment, verification, rollback, and persistent-data behavior remain supported and pass regression testing without AWS credentials or connectivity.
- The current sprint completes without AWS credentials, connectivity, accounts, or resources, and the lab portal and all existing monitoring evidence remain available and unchanged.

### Deferred future work: AWS EKS certification

Actual EKS provisioning and certification are not Sprint 9 completion requirements. Re-entry requires the user's explicit authorization, a current cost estimate covered by verified credits or a newly approved spending ceiling, exact account/region/ownership and teardown decisions, and accepted registry, CI, secret, ingress/TLS, network, storage, backup/restore, and data-use contracts. The future exercise must be ephemeral, repeat the test/fix/full-retest loop to green, delete all disposable AWS resources, verify no unintended billable resources remain, and prove the Docker Compose lab stayed independent and healthy.

## Cross-sprint definition of done

Every sprint must satisfy all applicable items:

- Acceptance criteria are automated where practical and manually demonstrated otherwise.
- Unit, integration, end-to-end, strict type, lint, accessibility, and build gates relevant to the increment pass.
- Server coverage is at least 90%; critical authorization and destructive-action branches receive explicit tests.
- Loading, empty, stale, partial failure, timeout, malformed data, forbidden, and oversized-input behavior are considered.
- Documentation, threat assumptions, deployment notes, and rollback guidance are updated.
- No credentials, tokens, `.env` files, generated databases, or diagnostic secrets are committed.
- The sprint review records approve, revise, or defer decisions before the next sprint begins.
