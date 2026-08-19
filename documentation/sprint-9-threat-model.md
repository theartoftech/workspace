# Workspace Monitor Cloud Operations Threat Model

Status: Sprint 9 discovery supplement; no infrastructure or persistent-data mutation is authorized.

This repository-scoped model supplements, and does not replace or modify, the [Sprint 8 safe synthetic journeys threat model](sprint-8-threat-model.md). Sprint 8 remains in progress. This model covers the existing Workspace Monitor runtime plus the proposed cloud delivery, backup, restore, upgrade, rollback, and disaster-recovery surfaces.

## Overview

Workspace Monitor is an authenticated operational portal and same-origin API for a development lab. It aggregates a versioned service catalog, Gatus reachability evidence, Prometheus metrics, Kubernetes topology and bounded logs/events, persistent incident operations, Cloudflare Access identity and authorization audit, private PostgreSQL observability, and a disabled synthetic-journey foundation.

The current primary runtime is one Docker Compose deployment on the lab host. A pinned monitoring Helm dependency chart exists, but it does not deploy the portal/API and is not yet a certified cloud application release. Sprint 9 proposes a second, isolated Kubernetes deployment path while preserving the Docker Compose lab profile until an explicit replacement decision is made.

Assets requiring protection include:

- portal and monitoring availability, truthful source state, and alert integrity;
- the catalog, incident history, alert evidence, incident audit, and authentication audit;
- Cloudflare Access role mappings, Kubernetes credentials, database credentials, TLS material, external-secret references, signing keys, and workload identities;
- CPQ Demo and Test PostgreSQL data and PVCs, plus any approved Grafana, Prometheus, Gatus, and future journey evidence;
- immutable container and Helm artifacts, source provenance, SBOMs, signatures, attestations, promotion approvals, and rollback references;
- encrypted backups, backup manifests, restore authorization, retention locks, and off-site custody;
- cloud accounts, clusters, namespaces, registries, object stores, DNS/TLS configuration, billing controls, and audit logs; and
- the existing Docker Compose lab runtime while the cloud path is incomplete, unavailable, or disabled.

## Threat Model, Trust Boundaries, and Assumptions

### Trust boundaries

1. **Browser to Cloudflare Access and origin.** The browser is attacker-controlled. Cloudflare configuration remains external to this repository, and the origin must continue to validate the signed application assertion and enforce server-side roles. Ingress or TLS changes must not create a route around that validation.
2. **Developer workstation and source control to CI.** Pull requests, dependency metadata, build scripts, chart values, and generated artifacts are developer-controlled but must be treated as untrusted until tests and policy gates pass. CI runners must not inherit broad cloud or production credentials.
3. **CI to registry and chart repository.** A build may publish only immutable, content-addressed artifacts with provenance. A mutable tag is never sufficient promotion or rollback identity.
4. **Promotion controller to target cluster.** Cluster, account, region, namespace, release, environment, chart digest, and image digests are operator-controlled inputs that require exact preflight evidence and production-like confirmation. Kubeconfig defaults are not authorization to deploy.
5. **Ingress and network edge to portal/API.** Only the approved portal endpoint may be exposed. Grafana, Prometheus, Gatus, exporters, Kubernetes tools, databases, and backup endpoints remain private unless separately approved.
6. **Workloads to Kubernetes API and monitoring providers.** Each workload receives a dedicated service account with only required verbs, resources, and namespaces. A browser never chooses arbitrary Kubernetes resources, PromQL, URLs, methods, or log paths.
7. **Workloads to external-secret backend.** Kubernetes manifests contain references and policy, never secret values. Missing, stale, malformed, or unauthorized material must fail closed rather than produce empty credentials or a healthy status.
8. **Application to persistent storage.** Catalog/configuration is versioned. Incident and authentication SQLite databases, Gatus SQLite, Prometheus, Grafana, and any later journey ledger have different consistency and retention needs. An upgrade must declare schema compatibility before mounting existing data.
9. **Database backup tooling to CPQ PostgreSQL.** PostgreSQL backup credentials and operations require a separate least-privilege contract. A backup or restore must not restart, replace, expose, or mutate the current accepted database Pods/PVCs except within a separately approved maintenance and restore procedure.
10. **Backup producer to off-site custody.** Backup content and metadata cross into a higher-impact confidentiality boundary. Encryption keys must be independent of the cluster being protected, and restore authorization must be separate from routine backup execution.
11. **Restore controller to isolated target.** Restore targets are untrusted until exact identity, emptiness, isolation, and version compatibility are proven. The default restore target is a new isolated namespace or database, never the current live target.
12. **Cloud control plane to billing and teardown.** Provisioning, retention, teardown, and backup custody cross an availability and cost boundary. Teardown must not infer permission to delete retained data or backups.

### Actors and controlled inputs

- External attackers control unauthenticated HTTP requests, DNS traffic, public TLS handshakes, provider responses, timing, and denial-of-service pressure.
- Authenticated Viewers, Operators, and Administrators control only the actions already authorized by the origin-enforced role model. Administrator does not imply cluster, secret, backup, restore, or cloud-account authority.
- A compromised browser may attempt direct API calls, cross-site mutations, evidence poisoning, or source-tool access.
- Developers control source changes and proposed dependency versions but do not automatically control promotion.
- CI jobs and third-party actions are partially trusted execution environments and potential supply-chain attackers.
- Deployment operators control reviewed environment selections and confirmations. They may still make mistakes, use a stale context, or act on misleading output.
- Cluster workloads and providers may be compromised and return malformed, oversized, stale, sensitive, or cross-environment data.
- Backup and restore operators may have access to restricted application and identity data but do not automatically have authorization to overwrite live systems.

### Assumptions and open boundaries

- No cloud provider, account, region, Kubernetes service, registry, CI provider, secret backend, ingress controller, TLS issuer, storage class, backup destination, budget, RPO/RTO, or DR target is approved yet.
- The current Cloudflare Tunnel, Access, DNS, and public routing remain outside repository ownership.
- The Docker Compose lab profile remains supported and available during cloud-path work.
- The existing Sprint 8 journeys remain independently disabled. Their live identities, persistence, schedules, and mutations are outside Sprint 9 unless explicitly added to cloud certification.
- The initial Kubernetes application release should run one API replica while it uses SQLite. Horizontal API replicas require an approved shared-data architecture or a database migration; a shared RWO SQLite PVC is not an HA design.
- Cluster snapshots alone are not assumed to be application-consistent PostgreSQL backups.
- Missing evidence, missing credentials, failed backups, failed scans, and failed policy checks are explicit failures and never healthy or promotable states.

### Security and recovery invariants

- Exactly one immutable release identity binds source revision, image digests, chart digest, SBOM, vulnerability result, signature, attestation, and tested configuration.
- Production-like deployment accepts no floating image tag, unverified chart dependency, or registry tag as a rollback identity.
- Rendered manifests, diffs, diagnostics, CI output, evidence APIs, metrics labels, and support bundles contain no secret value or reusable assertion.
- Every deploy or restore preflight prints non-secret target identity and refuses ambiguity. Mutation requires exact environment and release confirmation distinct from a plan command.
- Restore defaults to a new isolated target, verifies that it is empty, and cannot overwrite a live namespace, PVC, or database without a separate destructive confirmation and maintenance boundary.
- Backup success requires a complete manifest, encryption, checksum verification, consistency evidence, bounded retention classification, and a successfully exercised restore. File creation alone is not success.
- SQLite backup captures a consistent database state through an approved online-backup or quiesced procedure; copying only the main file while WAL writes continue is prohibited.
- PostgreSQL backup uses a version-compatible native logical or physical procedure with explicit consistency and WAL requirements. PVC file copying is not accepted as a database backup.
- Rollback preserves all approved persistent data and validates schema compatibility before mounting it. An application rollback may be blocked when a forward-only schema migration has occurred.
- Network policy denies unapproved ingress and egress. Required monitoring and identity traffic is allowlisted and tested for both availability and isolation.
- External-secret failure prevents the dependent workload from becoming Ready. Empty substitution or use of a previous untracked value is prohibited.
- Teardown deletes only resources labeled with the exact approved ephemeral environment identity and never deletes retained backups, shared DNS, shared registries, or unrelated namespaces.
- The cloud path cannot stop, replace, reconfigure, or become a dependency of the current Docker lab profile before separate acceptance.

## Attack Surface, Mitigations, and Attacker Stories

### Software supply chain and promotion

Relevant attacks include dependency substitution, compromised CI actions, untrusted pull-request code stealing credentials, tag drift, unsigned artifacts, promotion of a different digest than the tested artifact, and rollback to an unavailable or vulnerable image. Existing mitigations include locked npm dependencies, digest-pinned Docker base images, locked Helm dependency versions, strict tests, content-derived Docker lab candidates, and exact deploy confirmation. There is currently no CI workflow, OCI promotion contract, SBOM, signature, attestation, registry retention policy, or automated vulnerability gate.

Required controls include workload-identity federation rather than long-lived CI credentials; build-once/promote-by-digest semantics; pinned CI actions; least-privilege registry repositories; independent approval for production-like promotion; signed image and chart verification; artifact retention that preserves the current and rollback releases; and negative tests proving an untested or mismatched digest cannot deploy.

Attacker story: a compromised build step pushes benign content to a tested tag and later replaces the same tag with malicious content. Digest-bound promotion and admission verification reject the changed artifact.

### Deployment target confusion and partial upgrade

Relevant attacks and operator failures include using the wrong kube-context, account, namespace, release, or values overlay; Helm hooks changing data before readiness fails; and an atomic application rollback mounting a now-incompatible database. Existing scripts validate names, require exact confirmation, use Helm `--atomic`, and deliberately omit uninstall/PVC deletion. They do not yet bind confirmation to an account/cluster UID, artifact digest, values digest, or schema compatibility contract.

Attacker story: a poisoned kubeconfig changes the current context while a production confirmation still matches the namespace string. The guarded deploy must compare the approved cluster identity, account, namespace, and release tuple before mutation and reject the mismatch.

### Ingress, TLS, RBAC, and network policy

Relevant attacks include exposing internal tools or databases, bypassing Cloudflare Access, trusting the wrong issuer or hostname, granting cluster-wide list/watch/mutation, lateral movement from the portal/API, and blocking required monitoring traffic so unavailable evidence appears healthy. Existing origin authorization, loopback-only Compose bindings, bounded Kubernetes RBAC, private PostgreSQL exporters, read-only containers, dropped capabilities, and explicit no-data behavior reduce impact.

Required controls include one approved ingress surface, verified TLS hostname and issuer, no public source-tool Services, namespace-scoped service accounts, default-deny ingress and egress, explicit DNS/identity/provider/monitoring egress, NetworkPolicy tests from allowed and denied Pods, Pod Security Admission labels, seccomp, non-root execution, read-only roots, bounded resources, and disruption/availability settings consistent with storage.

Attacker story: an innocent values override changes Grafana to `LoadBalancer`. Schema validation, rendered-manifest policy, and exposure tests block the release before it reaches a cluster.

### Secrets and identity

Relevant attacks include secret values in values files, rendered manifests, CI logs, shell tracing, image layers, diagnostics, metrics, backup manifests, or Terraform/Helm state; an external-secret outage becoming an empty password; and a cloud administrator silently gaining application Administrator privileges. Existing file-mounted lab secrets, strict ownership/mode checks, secret-free archives, bounded Access role mappings, and response redaction are strong local controls.

Required controls include an approved external-secret backend and workload identity, environment-specific secret references, policy checks that render with placeholders but never values, rotation/revocation procedures, fail-closed readiness, separate backup-key custody, and tests that inject missing, malformed, stale, and unauthorized references.

Attacker story: a troubleshooting command renders all Helm values and uploads the output. The design must make value rendering secret-free by construction, and diagnostics must redact secret identifiers when even their names are sensitive.

### Persistent data, backup, restore, and disaster recovery

Relevant attacks and failures include inconsistent SQLite copies, PostgreSQL backups without required WAL, unencrypted or incomplete backups, ransomware or cluster compromise reaching both data and keys, restore into the wrong target, malicious backup content, version incompatibility, retained sensitive data after teardown, and an untested backup that cannot restore. Existing SQLite WAL/full-synchronous settings and explicit schema-version failures protect runtime integrity but are not backup procedures. No restore has been exercised.

Required controls include per-data-class RPO/RTO, encrypted and checksummed backup manifests, independent retention/custody, native consistency mechanisms, restore-only credentials where possible, a new isolated target by default, network isolation, malware and schema validation before use, timed restore exercises, application-level evidence verification, and separate authorization for teardown and backup deletion.

Attacker story: an operator selects the Demo backup but the current context points to Test. The restore preflight must compare backup environment identity, target cluster/namespace/database identity, and an explicit restore ticket before any write.

### Availability, observability, and cost

Relevant failures include single-node local storage loss, API SQLite preventing horizontal replicas, network policies hiding evidence, alerting depending on the component it monitors, exhausted PVCs, runaway image/build cache, forgotten cloud environments, and teardown deleting shared data. Existing bounded resources and retention, partial-source semantics, disabled-by-default journeys, and separation of monitoring sources limit cascading failure.

Required controls include capacity alerts, backup-age and restore-age evidence, artifact and cloud-resource retention, expiry labels, billing alerts, automated non-destructive inventory, explicit teardown approval, independent health evidence where justified, and a documented degraded lab fallback.

Current scope decision S9-D007 sets an absolute $0 AWS out-of-pocket ceiling and defers EKS certification. Sprint 9 therefore creates no AWS account or resource. The AWS threats and controls remain design requirements for the future-work bucket and must be re-evaluated against then-current services, prices, and authorization before provisioning.

## Data Classification

| Class | Workspace Monitor examples | Minimum handling |
| --- | --- | --- |
| Restricted | Database contents and dumps, credentials, tokens, role mappings, Access assertions/cookies, backup encryption keys, secret-backend values, copied real lab data | Encrypted in transit and at rest, least privilege, no logs/rendered manifests, independent restore authorization, bounded retention and audited deletion |
| Confidential | Authentication audit, incident audit/reasons, encrypted backup manifests, cluster/account topology, identity metadata, detailed administrative logs | Authenticated role-scoped access, encryption, bounded retention, no public exposure, redacted diagnostics |
| Internal | Catalog, sanitized monitoring evidence, low-cardinality metrics, bounded redacted logs/events, artifact metadata, cost estimates | Authenticated access unless explicitly approved, integrity checks, no secret or personal values |
| Public | `/healthz`, explicitly approved public documentation, published artifact signatures/SBOMs when policy allows | Must reveal no protected evidence, version-sensitive exploit detail, identity, or infrastructure secrets |

Backups inherit the highest classification of any included data. Encryption does not downgrade classification.

## Failure Taxonomy

| Class | Required behavior |
| --- | --- |
| Target identity failure | Refuse mutation; report the non-secret mismatch and require a new reviewed plan |
| Artifact identity/signature failure | Refuse build promotion, deployment, and rollback |
| Vulnerability/policy gate failure | Refuse promotion unless an explicit, scoped, expiring exception is recorded |
| Secret resolution failure | Workload remains unready; no empty value, fixture, or previous untracked fallback |
| Ingress/TLS/RBAC/network failure | Fail certification; preserve existing lab monitoring and expose no new endpoint |
| Partial Helm upgrade | Roll back only application resources when safe; preserve PVCs and report schema/rollback state explicitly |
| Schema incompatibility | Refuse startup or rollback before writing; require an approved migration/recovery path |
| Backup consistency/encryption/checksum failure | Mark backup failed and non-restorable; never promote it to retention custody |
| Restore target ambiguity or non-empty target | Refuse restore before any write |
| Restore validation failure | Keep the isolated target unavailable to users; preserve evidence for bounded review |
| Missing/stale backup or monitoring evidence | Explicit unavailable/stale state and alert; never healthy |
| Cost/expiry policy failure | Block new environment promotion and raise an ownership action; do not delete data implicitly |
| Teardown scope mismatch | Refuse teardown; retained backup and persistent-data deletion always requires separate authority |

## Severity Calibration (Critical, High, Medium, Low)

- **Critical:** unauthenticated public or cross-environment access to a database or backup; exposure of reusable cloud/cluster/database credentials; arbitrary cluster mutation from the portal; restore or teardown that destroys current CPQ/PostgreSQL/PVC data; supply-chain compromise that can promote a malicious artifact to a production-like target without an independent gate.
- **High:** a database, exporter, Prometheus, Grafana, Kubernetes tool, or secret endpoint exposed beyond its approved private boundary; wrong-cluster deployment or restore with restricted-data access; unsigned/tag-drifted promotion; backup encryption or authorization bypass; rollback that corrupts incident/authentication data; NetworkPolicy or RBAC that permits unintended lateral movement.
- **Medium:** bounded loss of monitoring history within an accepted RPO; stale backup or restore evidence; a failed external secret or monitoring source shown ambiguously but not as healthy; excessive artifact/cloud retention that creates material cost without data exposure; confidential operational metadata in an administrator-only diagnostic artifact.
- **Low:** inaccurate non-security cost estimates, cosmetic runbook defects, harmless label drift, or timing precision errors that do not affect target selection, authorization, data integrity, restore correctness, exposure, or alert state.

Severity rises when an issue crosses environment boundaries, reaches restricted data, changes persistent state, bypasses an independent approval, or affects the only viable recovery copy. It falls when exploitation requires already-approved cluster-admin and backup-deletion authority and no privilege, confidentiality, integrity, availability, recovery, or cost boundary is crossed.

Repository: https://github.com/theartoftech/workspace.git
Version: candidate-bedf923ac6f6dae57266e745629578b35a3d3fc5ef76dab3c9030ff8d7a9382f
