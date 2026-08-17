# Sprint 7.1 human acceptance record

## Acceptance status

Passed on 2026-08-16. The guarded database and Kubernetes provisioning, normal lab deployment verification, and public-browser database-evidence review completed successfully for CPQ Demo and CPQ Test.

Deployed candidate:

```text
candidate-6e74b98ba240a16aecabe33c4eb1661d984e9a25f0a569f5c3574e6a55e9fd1e
```

This record contains no database password, Kubernetes Secret value, connection assertion, identity mapping, application row data, query text, or protected monitoring payload.

## Accepted evidence

- The reviewed Kubernetes diff added only two ConfigMaps, two exporter Deployments, and two private `ClusterIP` Services across `default` and `cpq-test`; it did not modify either PostgreSQL pod, PVC, service, application workload, or database Secret.
- Each PostgreSQL instance received an independently passworded `workspace_monitor_postgresql` role. The privileged role flags were false, the connection limit was two, `pg_read_all_stats` membership was present, and `pg_monitor` membership was absent.
- Both namespace-local exporter Secrets were `Opaque` with exactly three keys. Secret content was not printed, copied into the repository, or included in the deployment candidate.
- Both PostgreSQL servers reported `ssl=off`. The operator explicitly accepted `sslmode=disable` for this trusted private single-node lab path; no public PostgreSQL hostname, ingress, tunnel, `NodePort`, `LoadBalancer`, or host port was added.
- Both exporter Deployments became Ready with one replica, zero restarts, and private `ClusterIP` Services. Both returned `pg_up 1` through bounded Kubernetes service-proxy checks.
- The existing CPQ Demo and CPQ Test PostgreSQL pods remained Running and were not restarted or replaced during exporter provisioning.
- The normal Docker deployment completed for the recorded candidate. Repository verification confirmed the Compose contract, Cloudflare Access role-mapping metadata, anonymous fail-closed behavior, and the running monitoring stack.
- Through the public TLS origin, the authenticated Operator confirmed that the Performance view displayed PostgreSQL evidence for CPQ Demo and CPQ Test. PostgreSQL intentionally remained a dependency of those services rather than a seventh application-catalog row.

## Automated and non-production evidence retained from implementation

- The application, server, deployment, accessibility, build, lint, type-check, Compose, Prometheus, and alert-rule suites passed before deployment; server coverage remained above 90%.
- Ephemeral PostgreSQL 17 integration proved exporter success and rejected-connection behavior, the restricted role's inability to read application rows or create persistent tables, password-redacted exporter failure output, and Prometheus dropping unapproved metrics and sensitive labels.
- Live credential corruption, exporter interruption, and database interruption were not induced against the persistent CPQ databases during human acceptance. Their isolated failure contracts remain covered by automated and ephemeral integration tests.

## Continuing boundaries

- Direct PostgreSQL evidence is current and ephemeral; Sprint 7.1 does not provide database backup, restore, disaster recovery, storage migration, log retention, query analytics, or automatic remediation.
- `pg_stat_statements`, query text, table/index/WAL collectors, and public database or exporter access remain disabled.
- Notification delivery remains unconfigured. Prometheus database alerts are not yet ingested into persistent Workspace Monitor incidents.
- Verified PostgreSQL TLS is future hardening. It requires server certificates, separately mounted trust material, and `sslmode=verify-full`; the accepted lab configuration must not be described as TLS-protected.
- Sprint 7 Viewer and Administrator role-matrix acceptance remains separately open and is not closed by this Sprint 7.1 record.
