# Sprint 9 Cloud Operations Discovery and Decision Record

Status: Sprint 9 decision and architecture phase in progress; no infrastructure or persistent-data mutation is authorized.

Date: 2026-08-18

## Review gate

Sprint 8 is not complete. Its disabled foundation is implemented, tested, and deployed, but live identities, adapters, persistent replay/restart safety, schedules, and mutations are not implemented or accepted.

Decision accepted 2026-08-18: defer Sprint 8 live activation from Sprint 9 cloud certification while keeping Sprint 8 open as a separately governed backlog item. Cloud certification must prove that disabled journeys remain isolated and do not affect existing monitoring. It must not create identities, credentials, schedules, provider adapters, persistence, or live data.

This explicit deferral satisfies the preceding-sprint review gate and allows Sprint 9 to enter its decision and architecture phase. It does not authorize infrastructure or persistent-data mutation.

## Decision log

| ID | Date | Decision | Status | Effect |
| --- | --- | --- | --- | --- |
| S9-D001 | 2026-08-18 | Defer Sprint 8 live journey activation from Sprint 9 while keeping Sprint 8 open and all journeys disabled | Accepted | Sprint 9 may proceed; journey identities, credentials, adapters, persistence, schedules, mutations, deployment, and acceptance remain separately governed Sprint 8 work |
| S9-D002 | 2026-08-18 | Keep CPQ Demo and Test PostgreSQL permanently cluster-only; use an on-demand encrypted tunnel for DBVisualizer | Accepted | Demo `LoadBalancer` exposure must be removed in a separately verified change; future cloud DB Manager access must be in-cluster or through approved private networking |
| S9-D003 | 2026-08-19 | Use a disposable local `kind` cluster with dedicated Lima runtime storage on the external T7 SSD; test/fix/retest to green, then completely tear down before Test/Demo promotion | Accepted | Store heavyweight state in a grow-on-demand APFS disk image on the exFAT T7 without reformatting it; retain only versioned artifacts and redacted certification evidence after teardown |
| S9-D004 | 2026-08-19 | Set the T7 validation APFS disk image maximum capacity to 200 GiB | Accepted | The image grows with actual use up to 200 GiB and is deleted with the disposable environment; no T7 reformat or unrelated-file change is allowed |
| S9-D005 | 2026-08-19 | Use AWS as the future managed-cloud certification target | Accepted | AWS is the planned future target, but this does not authorize or require an AWS environment in the current sprint |
| S9-D006 | 2026-08-19 | Keep Docker Compose as the independent primary lab profile after Sprint 9 | Accepted | AWS is additive; lab operation, deployment, data, monitoring, identity, rollback, and recovery cannot depend on AWS or AWS credentials/connectivity |
| S9-D007 | 2026-08-19 | Set the current AWS out-of-pocket limit to absolute $0 and defer EKS certification to a future-work bucket | Accepted | Sprint 9 creates no AWS account or billable resource; local T7-backed validation remains in scope, while EKS certification requires a later cost review, explicit budget authorization, and separate infrastructure approval |
| S9-D008 | 2026-08-19 | Separate the Workspace Monitor application chart from the optional observability composition chart | Accepted | Application upgrades and rollbacks own only portal/API resources and approved application persistence; Prometheus, Grafana, Alertmanager, Blackbox, Gatus, exporters, and external monitored applications remain outside that release boundary |
| S9-D009 | 2026-08-19 | Manage Gatus and each environment's PostgreSQL exporter as independent Helm releases | Accepted | A versioned installer coordinates clean deployment while preserving separate credentials, persistence, health gates, upgrade/rollback histories, and failure boundaries for Gatus, Demo exporter, Test exporter, and the core observability release |
| S9-D010 | 2026-08-19 | Publish approved Workspace Monitor images and Helm packages as public GHCR artifacts | Accepted | Use an ephemeral T7-backed local registry for iteration and public GHCR for approved immutable releases; artifacts contain no secrets or lab data, deployments select digests rather than mutable tags, and AWS ECR is not a lab dependency |

## Measurable discovery success criteria

- Local `main`, `origin/main`, dirty-worktree contents, deployed image revision, and packaged candidate agree.
- Status, verify, unit/integration/deployment suites, lint, strict types, builds, server coverage, diff checks, Docker plan, and Helm lint/render are recorded.
- Every current persistent data path is classified by owner, consistency mechanism, capacity, recovery status, and approved mutation boundary.
- Existing chart ownership, images, RBAC, secret mounts, ingress/exposure, rollback behavior, CI, registry, signing, and backup capabilities are identified without printing secret values.
- Sprint 8 gate state, cloud threat model, recovery invariants, promotion model, failure taxonomy, acceptance criteria, and user decisions are explicit before implementation.

## Read-only evidence collected

### Source and deployed provenance

- Local branch: `main`; local `HEAD` and `origin/main`: `a72f285f06062ecd48a2e8d27348d0011f30a992`.
- The dirty worktree contains only the handed-off Sprint 8 modifications and eligible untracked files at the start of discovery. No file was reset, cleaned, excluded, or overwritten.
- Deployed and re-planned candidate: `candidate-bedf923ac6f6dae57266e745629578b35a3d3fc5ef76dab3c9030ff8d7a9382f`.
- Read-only Docker status and verify passed. Portal and inventory API were healthy; anonymous portal, monitoring API, and source-tool access failed closed.
- The Docker plan reproduced the deployed candidate exactly and validated the Compose model. No deploy command ran.

### Verification baseline

| Gate | Result |
| --- | --- |
| Application test suite | 185 passed |
| Server test suite | 130 passed |
| Python/deployment suite | 64 passed |
| Server statements/lines | 98.75% |
| Server branches | 90.87% |
| Server functions | 96.84% |
| Lint, type checking, browser build, server build | Passed |
| Git diff checks | Passed |
| Helm dependency resolution, lint, template | Passed in an isolated remote temporary directory; no cluster access |

The Node wire-body integration test requires a temporary loopback listener. Its first sandboxed run failed with `EPERM`; the permitted rerun passed. This was an execution restriction, not an application assertion failure.

### Runtime state and persistence

| Data/system | Current location and observation | Current recovery state |
| --- | --- | --- |
| Catalog/config | Versioned repository content copied into the API image | Rebuild from exact source/artifact; no independent catalog database |
| Incident state/audit | Host bind mount, `incidents.sqlite` with WAL, about 49 KiB main file | No approved backup or restore exercise |
| Authentication audit | Same host directory, `auth.sqlite` with active WAL, about 28 KiB main file | No approved encrypted backup or restore exercise |
| Gatus internal | Host bind mount, SQLite plus active WAL; directory about 4.4 MiB | No approved backup or restore exercise |
| Gatus public-path | Host bind mount, SQLite plus active WAL; directory about 4.3 MiB | No approved backup or restore exercise |
| Prometheus | Docker named volume, about 345.9 MiB, 30-day/25 GB configured limit | No backup or restore exercise; may be classified as rebuildable only by decision |
| Grafana | Docker named volume, about 49.6 MiB | No backup or restore exercise; Git provisioning is incomplete as a recovery substitute |
| CPQ Demo PostgreSQL | Standalone `postgres:17` Pod, 2 GiB `local-path` RWO PVC, no owner reference | No repository backup procedure or restore exercise |
| CPQ Test PostgreSQL | Standalone `postgres:17` Pod, 2 GiB `local-path` RWO PVC, no owner reference | No repository backup procedure or restore exercise |
| Synthetic journeys | Disabled in-process evidence only; no persistent ledger | No current journey data to back up; live activation remains Sprint 8 scope |

Both PostgreSQL Pods currently run image digest `sha256:2203e6282d9e7de7c24d7da234e2a744fb325df366a3fd8ed940e8abbee39527`, but their Pod specs use the mutable tag `postgres:17`. Each is Ready and has three recorded restarts. The cluster reports no `snapshot.storage.k8s.io/v1` API. The lab host has about 679 GB free, but no `sqlite3`, `pg_dump`, `pg_basebackup`, `restic`, `borg`, `rclone`, `velero`, or AWS CLI in the deployment user's `PATH`. Tool absence does not prove the PostgreSQL container lacks native clients; cluster `pods/exec` is intentionally unavailable to the read-only inventory identity, so that capability was not probed.

Docker retains many historical application images and about 1.91 GB of build cache. No cleanup occurred. Artifact/image/build-cache retention and rollback preservation need an explicit policy.

The local T7 SSD is mounted at `/Volumes/T7` with about 896 GiB available. It is formatted as exFAT, which is unsuitable as Lima's direct runtime home because the runtime needs Unix filesystem semantics. The accepted local design stores a grow-on-demand APFS disk image with a 200 GiB maximum on the T7 and mounts that image for the dedicated Lima Docker runtime and `kind` cluster. It does not reformat the T7 or alter unrelated files.

## Urgent pre-existing exposure requiring separate authorization

The live Demo Service `default/database-postgresql` contradicts the supplied private-ClusterIP invariant:

- Kubernetes reports `type: LoadBalancer`, cluster IP `10.43.229.141`, NodePort `31319`, external traffic policy `Cluster`, no source-range restriction, and LoadBalancer ingress `192.168.86.246`.
- Connection-only checks from the workstation LAN succeeded on both `192.168.86.246:5432` and `192.168.86.246:31319`. No authentication or database query was attempted.
- The Service has no owner reference or managed-by label. Its recorded managers are client-side `kubectl apply`, `kubectl patch`, and k3s.
- Test `cpq-test/database-postgresql` remains `ClusterIP`.

This is a high-severity private-network exposure and would become critical if routed beyond the lab or paired with compromised credentials. Sprint 9 discovery did not patch, recreate, or delete the Service and did not touch either PostgreSQL Pod or PVC.

Decision S9-D002 accepted 2026-08-18: both Demo and Test PostgreSQL must be permanently cluster-only. DBVisualizer access from the laptop will use an on-demand encrypted tunnel, and a future cloud DB Manager must run in-cluster or use approved private networking. Converting the Demo Service to `ClusterIP`, closing both LAN ports, documenting the tunnel workflow, and verifying CPQ/exporter health remain a separate test-first implementation step with an exact manifest owner and rollback record.

## Foundation gaps

1. The existing `lab-observability` Helm chart owns kube-prometheus-stack, Alertmanager, Grafana, and Blackbox Exporter only. It does not package portal/API, Gatus, inventory RBAC, PostgreSQL exporters, Ingress, TLS, external secrets, or application persistence.
2. Helm values are lab-specific: `local-path`, fixed namespace assumptions, single-cluster ServiceMonitor selection, and no environment overlay schema.
3. There are no NetworkPolicies, application PodDisruptionBudgets, autoscaling policies, application service accounts, external-secret resources, application Ingress, or Pod Security Admission namespace labels.
4. There is no repository CI workflow, container/OCI registry contract, artifact signature, attestation, SBOM, vulnerability promotion gate, or retention policy.
5. Docker deployment builds directly on the target and identifies a credential-free source archive. It does not build once, scan once, sign once, then promote an immutable registry artifact.
6. Helm keeps ten revisions and uses `--atomic`, but there is no schema compatibility declaration or certified data-preserving upgrade/rollback exercise.
7. SQLite uses WAL and explicit schema version 1. Copying the main file alone is inconsistent; no backup API, checkpoint/quiesce boundary, integrity check, encryption, or restore harness exists.
8. PostgreSQL uses standalone single-node local-path Pods/PVCs. There is no controller ownership, native backup schedule, WAL/archive policy, off-site custody, or isolated restore target.
9. No first cloud target, account, region, budget, owner, teardown behavior, or billing alert is selected.

## Recommended cloud-ready architecture

### Release ownership

Use separate lifecycle boundaries:

1. `workspace-monitor` application chart owns portal, API, internal Services, one operations-data PVC, service accounts/RBAC, NetworkPolicies, PodDisruptionBudget where meaningful, Pod Security settings, external-secret references, and the single approved Ingress.
2. `workspace-monitor-observability` remains an optional environment composition chart for pinned Prometheus/Grafana/Alertmanager/Blackbox dependencies and approved Gatus/exporter integrations. Do not make application upgrade/rollback depend on replacing the monitoring substrate.
3. CPQ, Keycloak, Mailpit, ERPNext, Portfolio, PostgreSQL databases/PVCs, Cloudflare, DNS, and the external-secret backend remain external dependencies unless a later ADR explicitly transfers ownership.

Keep a base values schema plus reviewed overlays such as `lab-docker` documentation, `local-validation`, and one exact managed-cloud environment. Overlays contain non-secret references only. Validate values and rendered manifests against JSON Schema and policy tests.

### Application availability and persistence

Run portal statelessly with at least two replicas only after the target availability decision. Run API as one replica while it owns SQLite, with a PDB that does not pretend one replica is highly available. Either accept that boundary with a tested restore RTO or separately migrate operational state to a managed transactional database before enabling multiple API writers.

Use a dedicated PVC for incident/authentication data with an approved storage class, encryption, expansion behavior, and retention annotation. Preserve exact UID/GID and mode requirements during restore. Do not co-mount Prometheus, Grafana, or backup credentials into the API.

### Network and ingress

Expose only portal Ingress. Keep API behind the same origin and internal Service. Default-deny ingress and egress, then allow DNS, the exact identity/JWKS origin, approved monitoring providers, approved Kubernetes API access, and portal-to-API traffic. Grafana, Prometheus, Gatus, exporters, database Services, and backup endpoints remain `ClusterIP` with no Ingress, LoadBalancer, NodePort, host port, or Cloudflare route.

Terminate TLS through the selected controller/issuer with hostname validation and explicit renewal evidence. Cloudflare Access remains an external prerequisite unless an ADR changes the identity boundary. Origin authorization tests remain mandatory even when edge Access is present.

### Secrets

Use an approved external-secret controller or CSI provider with workload identity. Helm contains only secret object names/keys and fails schema validation if literal sensitive values appear. Separate application, monitoring, backup, signing, and restore identities. Backup decryption authority must not be automatically available to ordinary application workloads or untrusted pull-request CI.

### Artifact and promotion model

Build portal/API images and the application chart once in a trusted CI job. Produce immutable digests, SBOMs, vulnerability results, source/build provenance, signatures, and an attestation that records the tested values/policy bundle. Store images and charts in an OCI registry.

Promotion stages:

1. Source tests: 185 application, 130 server, 64 deployment tests or their future supersets; server statements, branches, functions, and lines remain at least 90%.
2. Static gates: lint, strict types, builds, secret scanning, dependency/license policy, rendered-manifest policy, and chart schema/lint.
3. Build once: portal/API images and chart package receive immutable digests; produce SBOM/provenance/signatures.
4. Isolated install: clean namespace/cluster installation from versioned artifacts only; no source checkout or manual file editing.
5. Adversarial certification: target mismatch, missing secrets, denied egress, unavailable providers, storage full, upgrade failure, schema mismatch, rollback, backup failure, and wrong restore target.
6. Restore certification: restore generated non-production fixture data into a new isolated target, verify application-level invariants, record RPO/RTO, and destroy it only under separate scope.
7. Promotion: a trusted identity promotes the same digests after an explicit approval. No rebuild and no mutable-tag selection.
8. Production-like deploy: exact account/cluster/namespace/release/environment and digest confirmation, followed by bounded verification and evidence capture.

The current sprint proves lab independence without AWS credentials or connectivity. Future AWS promotion and teardown must repeat that gate: with the AWS validation environment fully deleted, the Docker Compose plan, preflight, verify, rollback contracts, portal, API, and existing monitoring sources continue to operate without configuration changes or data loss.

### Backup and recovery

- SQLite: use an application-aware online backup or an explicitly quiesced/checkpointed procedure; encrypt, checksum, and record schema/application version. Restore to a new PVC first and run SQLite integrity plus application-level audit/incident invariants.
- PostgreSQL: select a native logical or physical approach based on RPO/RTO and size. Physical recovery requires WAL/consistency design; logical recovery requires object/privilege/extension coverage and version testing. Never treat a raw PVC copy as sufficient. Do not use current lab data for the first exercise without explicit approval.
- Grafana: prefer Git-provisioned dashboards/data sources. Back up the Grafana database only for approved UI-managed state.
- Prometheus: recommend classifying raw metrics as rebuildable with optional snapshots and a longer RPO, while preserving rules/configuration in Git. The user must accept loss of historical metrics within the selected window.
- Gatus: recommend a 24-hour RPO unless history is declared operational record. Preserve configuration in Git and test whether SQLite history restoration is actually needed.
- Secrets: recover through the selected external backend's independent DR process. Application backups must not include secret values.

## Proposed RPO/RTO matrix requiring approval

| Data class | Classification | Recommended RPO | Recommended RTO | Proposed recovery method |
| --- | --- | ---: | ---: | --- |
| Catalog/config/policy | Internal | Zero after artifact publication | 30 minutes | Exact signed source/chart/image artifact |
| Incident SQLite and audit | Confidential | 15 minutes | 2 hours | Encrypted consistent SQLite backup to independent object storage; isolated restore test |
| Authentication audit SQLite | Confidential/personal | 15 minutes | 2 hours | Separate encrypted consistent SQLite backup with bounded retention and restricted restore |
| CPQ Demo PostgreSQL | Restricted | 15 minutes | 4 hours | Version-compatible native backup plus required WAL/consistency evidence; isolated restore |
| CPQ Test PostgreSQL | Restricted | 1 hour | 4 hours | Independent native backup and isolated restore; never infer coverage from Demo |
| Grafana approved state | Confidential/internal | 24 hours | 4 hours | Git provisioning plus encrypted database backup only for accepted UI state |
| Prometheus history | Internal | 24 hours, or explicitly no backup | 4 hours | Recreate from Git plus optional tested snapshot/object backup |
| Gatus history | Internal | 24 hours | 4 hours | Consistent per-store SQLite backup or accepted history loss |
| External-secret material | Restricted | Backend-defined, target 15 minutes | 2 hours | Secret-backend DR under independent identity and key custody |
| Synthetic journey evidence | Not currently persistent | Not applicable | Not applicable | Decide in Sprint 8 before activation |

These are recommendations for a small development lab, not accepted objectives. Final values must be paired with retention, encryption, off-site custody, owner, restore-test cadence, and budget.

## Restore invariants

1. A restore plan is read-only and identifies backup ID, content digest, encryption/key reference, source environment, data classification, schema/application version, creation/verification time, and expected RPO.
2. Preflight proves exact cloud account, cluster UID, namespace, release, storage class, database/PVC identity, and that the target is new and empty.
3. Restore mutation requires an exact restore-specific confirmation. Deploy confirmation is not restore authority.
4. Live overwrite is unsupported by default. It requires a separate destructive authorization, maintenance window, current backup, rollback boundary, and evidence that the selected source is correct.
5. The target starts network-isolated with no public Ingress, LoadBalancer, NodePort, external DNS, notification delivery, or synthetic mutations.
6. Secret values are resolved only inside the approved target and never enter restore plans, CI logs, shell history, rendered manifests, or evidence bundles.
7. SQLite consistency/integrity and PostgreSQL native recovery checks pass before the application reads restored data.
8. Application verification proves catalog count/version, incident state and audit linkage, authentication-audit bounds, role enforcement, source-health honesty, and absence of duplicate or fabricated records.
9. RPO and RTO are measured from recorded timestamps. A missed objective fails the exercise rather than being rounded away.
10. Promotion from isolated restore to any user-facing target is a separate decision. Teardown is also separate and never deletes retained backups implicitly.

## Failure taxonomy and required tests

| Failure | Test and acceptance behavior |
| --- | --- |
| Hidden manual dependency | Clean install in an empty target from OCI artifacts and non-secret references; no source editing or shell-created manifest |
| Secret in artifact/render/log | Seed canary secret patterns; build/render/diagnostics must fail before publication and contain zero canaries |
| Wrong account/cluster/namespace/release | Alter one identity field at a time; every mutation refuses before API write |
| Tag drift or artifact mismatch | Move a test tag; digest/signature verification rejects it |
| Vulnerable/unsigned/untested promotion | Remove each gate receipt; promotion refuses explicitly |
| Partial upgrade or incompatible schema | Inject readiness and migration failures; data remains intact and rollback state is explicit |
| Rollback loses or forks data | Create representative incident/auth records, upgrade, rollback, and compare application-level invariants |
| SQLite copy is inconsistent | Exercise active WAL writes; unsafe file copy is rejected and approved method restores consistently |
| PostgreSQL backup incomplete | Omit required roles/extensions/WAL or corrupt an object; verification rejects the backup before custody |
| Wrong or non-empty restore target | Test namespace/PVC/database mismatch and existing-data marker; restore performs zero writes |
| External secret missing/stale | Dependent Pod remains unready and no empty/fallback credential is used |
| Network policy over/under-permits | Probe every required allowed flow and representative denied flows from separate test Pods |
| Ingress exposes internal service | Render and live-scan Services/Ingress/ports; only the approved portal endpoint is reachable |
| TLS issuer/hostname mismatch | Wrong CA, SAN, expiry, and renewal failure all fail certification |
| Backup/monitoring evidence missing | Evidence becomes unavailable/stale and alerts; never healthy |
| Teardown exceeds scope | Unrelated namespace/shared resource/retained backup canaries survive; command refuses ambiguous labels |
| Cost controls fail | TTL/budget/owner labels and billing alert checks block promotion; no implicit data deletion |
| Docker lab regression | Docker plan/status/verify and representative portal flows pass throughout cloud development |

## Test-first implementation sequence

1. Accept or reject the Sprint 8 deferral recommendation and resolve the urgent Demo PostgreSQL exposure separately.
2. Create the accepted 200 GiB-maximum T7-backed disposable Lima/`kind` target only after the remaining architecture decisions and implementation authorization are approved. Add failing contract tests for values schema, exact target confirmation, secret-free rendering, resource/security contexts, Service exposure, NetworkPolicy, and immutable digests.
3. Implement the `workspace-monitor` application chart and local-validation overlay only. Prove clean install, disabled-journey isolation, explicit provider failures, and Docker Compose non-regression.
4. Define registry and CI trust boundaries. Add failing promotion-policy tests before workflows; then build, scan, SBOM, sign, attest, package, and promote by digest.
5. Implement generated-fixture SQLite backup and isolated restore. Exercise WAL activity, corruption, missing key, wrong target, version mismatch, integrity checks, timing, and retention metadata.
6. Approve PostgreSQL backup tooling and an isolated empty restore target. Test with generated non-production data before considering copied lab data. Do not change current PostgreSQL Pods/PVCs as part of this step.
7. Add external-secret references and workload identity for the selected backend. Test missing, stale, revoked, wrong-environment, and unauthorized material.
8. Add default-deny NetworkPolicies, namespace/service-account/RBAC policy, resource limits, Pod Security settings, Ingress/TLS, and exposure tests for the selected target.
9. Implement upgrade, compatibility, rollback, DR, and teardown runbooks; exercise representative data across at least one forward upgrade and supported rollback boundary.
10. Package the EKS certification design, tests, cost model, and authorization checklist as future work. Do not create an AWS account or resource in Sprint 9.

## Future work bucket: AWS EKS certification

This bucket preserves AWS as the planned managed-cloud target without making it a current lab dependency or cost. It is explicitly outside the present Sprint 9 implementation scope.

Future work includes:

- Select or create a dedicated non-production AWS account, region, EKS version, registry, workload identity, secret backend, ingress/TLS path, storage classes, and AWS backup services.
- Re-estimate control-plane, compute, public IPv4, load-balancer, NAT/data-transfer, storage, logging, registry, backup, and tax costs using then-current prices.
- Require an exact out-of-pocket ceiling, funding or verified credit coverage, billing alerts, owner tags, TTL, orphan detection, and immediate teardown procedure.
- Create only an ephemeral EKS certification environment after separate infrastructure authorization; run clean-install, security, failure, upgrade, rollback, restore, observability, cost, and lab-independence gates.
- Repeat the test, diagnose, fix, and full-retest loop until all approved gates pass, then delete all disposable AWS resources and verify both zero unintended retained resources and continued lab health.
- Retain only approved redacted evidence and deliberately retained artifacts or backups; deletion of any retained data requires separate authority.

Re-entry requires all of the following:

1. The user explicitly resumes this future-work bucket.
2. A current AWS estimate demonstrates either $0 out of pocket through verified credits or a newly approved non-zero ceiling.
3. Exact account, region, ownership, billing-alert, TTL, and teardown decisions are recorded.
4. Registry, CI trust, secrets, ingress/TLS, network, storage, backup/restore, and data-use decisions are accepted.
5. A reviewed plan names every resource to be created and proves that the existing Docker Compose lab remains independent.

## Decisions and explicit authorizations required

No implementation should infer answers from defaults. Record each accepted value in an ADR or environment contract.

1. **Sprint 8 gate — accepted 2026-08-18 (S9-D001):** live activation is deferred from Sprint 9 certification; Sprint 8 remains open and all journeys remain disabled.
2. **PostgreSQL network boundary — accepted 2026-08-18 (S9-D002):** Demo and Test remain cluster-only; Demo must be changed from `LoadBalancer` to `ClusterIP` without restarting or replacing its Pod/PVC, and DBVisualizer uses an on-demand encrypted tunnel.
3. **First isolated target — accepted 2026-08-19 (S9-D003 and S9-D004):** use a disposable local `kind` cluster with a dedicated Lima runtime whose heavyweight state is stored in a grow-on-demand APFS disk image with a 200 GiB maximum on `/Volumes/T7`; repeat test/fix/full-retest to green, then delete the environment before Test/Demo promotion while retaining only versioned artifacts and redacted evidence.
4. **Cloud provider and cost boundary — accepted 2026-08-19 (S9-D005 and S9-D007):** AWS is the future managed-cloud certification target, but EKS certification is deferred. The current out-of-pocket ceiling is absolute $0, Sprint 9 creates no AWS account or resource, and future re-entry requires a current estimate plus explicit budget and infrastructure authorization.
5. **Lab coexistence — accepted 2026-08-19 (S9-D006):** Docker Compose remains the independent primary lab profile; AWS is additive and cannot become a lab dependency or receive lab data automatically.
6. **Registry — accepted in part 2026-08-19 (S9-D010):** use an ephemeral T7-backed local registry for iterative validation and public GHCR for approved portal/API images and Helm OCI packages. Release artifacts contain no credentials, environment configuration, or lab data and are deployed by immutable digest. Exact repository names, retention, rollback count, signing/attestation technology, vulnerability/license thresholds, and promotion approvals remain pending.
7. **CI:** provider, runner isolation, untrusted pull-request behavior, workload identity, protected environments, approval gates, CI-log retention, and emergency access.
8. **Chart ownership — accepted 2026-08-19 (S9-D008 and S9-D009):** `workspace-monitor` owns portal, API, approved application persistence, application Services, service accounts/RBAC, NetworkPolicies, Pod Security settings, and the approved portal Ingress. The core observability stack, Gatus, Demo PostgreSQL exporter, and Test PostgreSQL exporter are independent Helm releases coordinated by a versioned installer. Each keeps separate credentials, persistence, health gates, revision history, and rollback scope; none is implicitly upgraded or rolled back with the application or another release.
9. **Ingress/TLS:** DNS name, controller, issuer/cert-manager, origin reachability, Cloudflare relationship, certificate renewal evidence, and whether any source tool has a separate private access path.
10. **Secrets:** external backend, controller/CSI choice, workload identity, namespace policy, rotation/revocation, bootstrap, audit, DR, and key custody.
11. **Namespaces/RBAC/network:** namespace model, service accounts, allowed Kubernetes resources, cluster-scope exceptions, default-deny policy, required egress destinations, and test sources.
12. **Availability:** portal/API replicas, zones/nodes, PDBs, autoscaling, failure domains, maintenance behavior, and the accepted single-writer SQLite boundary or migration decision.
13. **Storage:** storage classes, encryption, sizes, expansion, access modes, reclaim policy, snapshot support, retention, and ownership for every PVC.
14. **Backup scope:** CPQ PostgreSQL, incident/auth SQLite, Gatus, Prometheus, Grafana, configuration, future journey evidence, and any external volumes; explicitly accept excluded data loss.
15. **Recovery objectives:** final RPO/RTO, retention generations, encryption, off-site custody, backup/restore identities, restore-test cadence, and on-call ownership for each data class.
16. **PostgreSQL:** logical versus physical tooling, WAL/archive behavior, consistency/quiescence, version compatibility, monitoring impact, and maintenance boundary.
17. **Restore data:** whether any exercise may use copied real lab data; if yes, approve classification, sanitization, isolation, retention, authorized operators, and destruction evidence.
18. **Upgrade/rollback:** application and database schema ownership, supported version window, forward-only migration policy, Helm rollback boundary, and data downgrade strategy.
19. **DR:** target region/cluster/account, recovery ownership, failover/failback behavior, DNS/Access decisions, degraded operation, exercise cadence, and evidence retention.
20. **Notifications:** destinations, credentials, retry/failure semantics, incident ownership, and whether backup/restore/cost alerts enter persistent Workspace Monitor incidents.
21. **Current cost — accepted 2026-08-19 (S9-D007):** absolute $0 out of pocket and no AWS resources in Sprint 9. A future EKS exercise must separately decide its per-exercise ceiling, estimator assumptions, verified credit treatment, required tags, orphan detection, alert thresholds, overrun authority, and teardown retention.

Explicit authorization remains required before creating accounts, registries, credentials, cloud resources, Kubernetes resources, backups, snapshots, restore targets, DNS/TLS, CI secrets, or any persistent-data mutation.
