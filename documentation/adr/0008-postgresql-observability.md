# ADR 0008: Private least-privilege PostgreSQL observability

- Status: Accepted, deployed, and human-tested
- Date: 2026-08-16
- Sprint: 7.1 — PostgreSQL observability

## Context

CPQ Demo and CPQ Test each run PostgreSQL 17 as a private Kubernetes `ClusterIP` service named `database-postgresql`. Demo is in `default`; Test is in `cpq-test`. The services are reachable from the Docker-hosted Prometheus process through the existing k3s cluster DNS, but neither PostgreSQL service is exposed on a host or public port. ERPNext uses MariaDB and is outside this sprint. The two Keycloak instances use their own persistent embedded storage and are not PostgreSQL targets.

Application Hikari metrics show only the application's view of its pool. They cannot distinguish a database outage, exporter failure, server-wide connection pressure, lock waits, deadlocks, long transactions, or database growth. Direct SQL, browser database tooling, query capture, and a public exporter would create unnecessary operational and privacy risk.

## Decision

Deploy one `postgres_exporter` instance beside each approved PostgreSQL service, using the same namespace and a separate credential per environment. Each exporter exposes only a private `ClusterIP` metrics service. Docker Prometheus resolves the two services over cluster DNS and scrapes them directly. No public hostname, `NodePort`, `LoadBalancer`, ingress, Cloudflare route, host port, or portal proxy is created.

The exporter image is `v0.20.1`, pinned to the immutable multi-architecture digest recorded in the manifest. It runs as UID/GID `65534`, without a Kubernetes API token, Linux capabilities, privilege escalation, or a writable root filesystem. Collection is capped at five seconds. CPU and memory are bounded. Liveness checks the exporter process; `pg_up` separately represents the database connection.

The exporter reads URI, username, and password from individually mounted Secret files. Credentials are never environment values, command arguments, Git content, deployment archives, portal payloads, diagnostic exports, or logs. Each namespace has a Secret with the same name but independent content. Secret creation and rotation remain explicit cluster-administration steps.

Upstream `postgres_exporter` removes the password but logs its internal endpoint, fixed monitoring-role name, and connection options at error level when a scrape cannot connect. Those bounded logs remain administrator-only Kubernetes evidence: the exporter workload is not a catalog log target, and its logs are never returned by the portal or included in a diagnostic export. The fixed role/service names are non-secret. This known behavior must be rechecked on exporter upgrades; a password or other credential in the log is a deployment blocker.

## Collection and privacy boundary

Enabled built-in collectors are limited to database size, locks, long-running transaction age, numeric settings, and database counters. The built-in activity collector is disabled because its username, application, and wait-event labels cannot be dropped without collapsing distinct series. One repository-owned fixed query returns only an aggregate count of sessions waiting on a lock; it emits no labels or SQL/session content. Arbitrary query files, replication, table, index, WAL, statement, archiver, background-writer, and vacuum-progress collectors are disabled. `pg_stat_statements` and query-text collection remain explicitly disabled.

Prometheus applies a second allowlist before ingestion. It retains only exporter health, approved database counters, connection counts, lock counts, transaction age, maximum connections, and database size. Database-specific series are restricted to the approved `cpq` database. Labels containing database IDs/names, usernames, application names, server addresses, and individual wait-event names are dropped before storage. Prometheus supplies only catalog IDs (`cpq-demo`, `cpq-test`) and environment IDs (`demo`, `test`) to the portal.

The portal executes fixed, aggregated PromQL templates. It returns values and timestamps only—never labels, hosts, connection strings, SQL, usernames, schema/table identifiers, or query text. Missing series remain `no-data`; failed queries remain explicit panel errors; one failed metric does not discard valid evidence.

## Database role

Each PostgreSQL instance gets a local login role with the same non-sensitive role name and a unique password. The role:

- is `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, and `NOBYPASSRLS`;
- has a connection limit of two and short statement/idle-transaction timeouts;
- receives `CONNECT` only for the approved `cpq` database;
- receives only the built-in `pg_read_all_stats` role;
- receives no application schema, table, sequence, function-execution, ownership, or mutation grants.

`pg_monitor` is not granted because it additionally includes settings and table-scan privileges that are unnecessary for the approved initial collectors. `pg_read_all_stats` is still privileged operational metadata access, so it is isolated to one credential per environment and must be revoked promptly if an exporter is retired.

## Alert behavior

Prometheus records availability, connection saturation, transaction rate, waiting connections, oldest transaction age, and database size. It evaluates bounded alerts for:

- exporter unavailable for five minutes;
- database unavailable to the exporter for two minutes;
- connection utilization above 80% for ten minutes;
- one or more waiting connections sustained for five minutes;
- any deadlock observed within fifteen minutes;
- a transaction older than five minutes sustained for five minutes.

These rules are local operational evidence. Notification delivery remains unconfigured, and Sprint 7.1 does not silently add a destination. Persistent incident ingestion of Prometheus alerts requires its own test-first change; until then, operators correlate rule state from Prometheus with the portal's bounded database panels.

## Failure behavior

| Condition | Result |
| --- | --- |
| Exporter pod or service unavailable | Prometheus target `up=0`; availability panel reaches 0 when a target series exists; exporter alert fires after five minutes |
| PostgreSQL unavailable or credential rejected | Exporter remains reachable, `pg_up=0`, database alert fires after two minutes |
| Secret absent or malformed | Only that namespace's exporter fails to start or connect; the other environment remains independent |
| Collector exceeds five seconds | The collection is canceled; scrape failure/no-data is explicit rather than accumulating connections |
| An approved metric is absent | Its portal panel is `no-data`; absence is never converted to healthy or zero |
| A Prometheus query fails | The individual metric is `error`; valid panels remain and the snapshot is partial |
| Unexpected/high-cardinality metric or label appears | Metric/label relabeling drops it before Prometheus storage |
| Prometheus or cluster DNS is unavailable | Database panels become no-data/error and existing application/inventory evidence remains independent |

## Measurable acceptance criteria

- Both private exporter targets are current and `pg_up == 1` under normal operation.
- No PostgreSQL or exporter listener appears on a host/public interface, DNS hostname, Cloudflare tunnel, ingress, `NodePort`, or `LoadBalancer`.
- The two exporter Secrets contain different passwords and are absent from Git, archives, environment output, pod arguments, logs, browser responses, and diagnostics; failure logs contain `PASSWORD_REMOVED`, never the password.
- The monitoring role cannot create or alter roles/databases, mutate application data, or select application rows; it can read only the approved statistics needed by enabled collectors.
- Prometheus stores only the metric and label allowlists declared in `prometheus.yaml`; `pg_stat_statements`, query text, usernames, application names, database names, and server addresses are absent from stored metrics and portal evidence.
- The portal shows current database availability, connections, transaction rate, waits, deadlocks, long-transaction age, and size for CPQ Demo and CPQ Test and shows honest no-data for services without PostgreSQL mapping.
- A controlled credential rejection, exporter stop, and database connection failure each produce the documented isolated failure state without affecting the other environment.
- Local application/deployment tests, builds, lint, type checking, accessibility tests, Prometheus validation, and server coverage of at least 90% pass before deployment.

## Consequences

- Operators gain direct database evidence without making PostgreSQL a browser or public network dependency.
- Initial configuration uses the explicitly accepted private single-node lab transport with `sslmode=disable`; both PostgreSQL servers reported `ssl=off` during deployment. Enabling verified PostgreSQL TLS later requires server certificates and a separately mounted CA, followed by `sslmode=verify-full`, not `sslmode=require` without certificate validation.
- Exporter deployment is intentionally separate from the normal Docker deployment because it needs database-role and Kubernetes Secret preparation. Repository deployment scripts never create credentials, grant database roles, apply Kubernetes resources implicitly, or remove them.
- ERPNext/MariaDB, Keycloak storage, backups, restore testing, database logs, automatic remediation, and query analytics remain out of scope.

See [the Sprint 7.1 runbook](../../deployment/POSTGRESQL_OBSERVABILITY.md) for guarded provisioning, verification, rotation, and rollback, and the [human acceptance record](../sprint-7.1-human-test-script.md) for the deployed evidence.
