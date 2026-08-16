# Sprint 7.1 PostgreSQL observability runbook

This runbook is a guarded operator procedure for CPQ Demo (`default`) and CPQ Test (`cpq-test`). It does not apply automatically through `deploy-lab-docker.sh`. Do not continue unless the database role, private transport mode, credential custody, and maintenance window are approved.

Never paste passwords, connection strings, Secret YAML, tokens, or database output into Git, tickets, screenshots, chat, shell history, or deployment logs.

## 1. Confirm the private topology

Run read-only checks on the lab host with the administrator's normal `sudo k3s kubectl` workflow:

```bash
sudo k3s kubectl get service database-postgresql -n default
sudo k3s kubectl get service database-postgresql -n cpq-test
sudo k3s kubectl get pod database-postgresql -n default
sudo k3s kubectl get pod database-postgresql -n cpq-test
```

Both services must remain `ClusterIP`. Stop if either database name, namespace, service type, port, or pod label differs from ADR 0008.

## 2. Provision one least-privilege role per database instance

Open `psql` interactively inside each namespace's PostgreSQL pod using the existing database-administration procedure. Do not put an administrator password on a command line. Run the following SQL separately in Demo and Test:

```sql
CREATE ROLE workspace_monitor_postgresql
  LOGIN
  INHERIT
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  CONNECTION LIMIT 2;

ALTER ROLE workspace_monitor_postgresql SET statement_timeout = '5s';
ALTER ROLE workspace_monitor_postgresql SET lock_timeout = '2s';
ALTER ROLE workspace_monitor_postgresql SET idle_in_transaction_session_timeout = '5s';
GRANT CONNECT ON DATABASE cpq TO workspace_monitor_postgresql;
GRANT pg_read_all_stats TO workspace_monitor_postgresql;
```

Then use psql's interactive `\password workspace_monitor_postgresql` command. Generate a different high-entropy password in each environment. Do not reuse the CPQ application credential.

Before leaving psql, confirm the role is not a superuser, role/database creator, replication role, or row-security bypass role. Confirm it is a member of `pg_read_all_stats` but not `pg_monitor`. Connect as the monitoring role and confirm application-table `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, and persistent schema/table creation are denied. Stop and revoke the role if any succeeds. PostgreSQL commonly grants temporary-table creation through `PUBLIC`; temporary objects are session-local and are not treated as application-data mutation, but the exporter never creates them.

## 3. Create namespace-local Kubernetes Secrets

On the lab host, create a mode-`0700` temporary directory with `mktemp -d`. In that directory create three files with mode `0600` and no trailing diagnostic output:

- `uri`: the approved private `database-postgresql:5432/cpq` connection URI options, including a three-second connect timeout and the reviewed `sslmode`;
- `username`: `workspace_monitor_postgresql`;
- `password`: that environment's unique password.

The current database manifests do not configure PostgreSQL TLS. Using `sslmode=disable` therefore requires explicit acceptance of the existing namespace-local plaintext transport. If verified TLS is enabled later, use `sslmode=verify-full` plus a separately mounted CA; do not use `sslmode=require` as a substitute for certificate verification.

For each namespace, create or rotate the Secret without printing its generated YAML:

```bash
set -o pipefail
sudo k3s kubectl create secret generic workspace-monitor-postgresql-exporter \
  --namespace <default-or-cpq-test> \
  --from-file=uri=<secure-directory>/uri \
  --from-file=username=<secure-directory>/username \
  --from-file=password=<secure-directory>/password \
  --dry-run=client -o yaml | sudo k3s kubectl apply -f -
```

Securely delete the temporary drafts through the host's approved secret-handling procedure. Do not add their directory to the Workspace Monitor runtime tree or deployment archive.

## 4. Deploy and verify the exporters

Apply the manifest explicitly; the Docker deployment script will never do this:

```bash
sudo k3s kubectl apply -f deploy/kubernetes/postgresql-exporters.yaml
sudo k3s kubectl rollout status deployment/workspace-monitor-postgresql-exporter -n default
sudo k3s kubectl rollout status deployment/workspace-monitor-postgresql-exporter -n cpq-test
```

Verify both Services are `ClusterIP`, both pods run as non-root, no Kubernetes API token is mounted, and no host, node, ingress, or load-balancer port exists. Inspect only bounded exporter status; never print pod environment or Secret content. A failed database connection must appear as `pg_up 0`. The upstream exporter may log a password-redacted internal endpoint and fixed monitoring-role name; `PASSWORD_REMOVED` must appear in place of the password, and these administrator-only logs must never be copied into browser evidence or diagnostics.

## 5. Deploy the Docker monitoring candidate

Only after both exporters are ready, run the normal plan, preflight, deploy, and verify workflow. This reloads the pinned Prometheus configuration and the portal's bounded database panels. Do not modify Cloudflare.

Verify in Prometheus that both `postgresql` targets are current, rule evaluation succeeds, and only the metric/label allowlist from `prometheus.yaml` is stored. Verify the portal as an authenticated Viewer or higher:

- CPQ Demo and CPQ Test show database availability and current bounded metrics;
- other services show no-data rather than fabricated database health;
- no host, database name, username, query, table/schema name, or connection string appears in API/browser evidence;
- stopping one exporter makes only its environment unavailable;
- a controlled invalid credential produces `pg_up == 0`, then returns to `1` after restoration.

## 6. Rotate credentials

Rotate one environment at a time. Set a new password interactively in that database, atomically replace only that namespace's Secret, restart only that exporter Deployment, and wait for `pg_up == 1`. Retain the previous password only through the approved short rollback window, then invalidate it. A failed rotation must not modify the other environment.

## 7. Roll back

First restore the previously deployed Docker monitoring candidate so Prometheus no longer expects the exporter targets or rule file. Then scale or delete only the two exporter Deployments/Services through an explicit reviewed command. Retain namespace Secrets during the immediate rollback window unless credential exposure is suspected.

After confirming no exporter uses the roles, revoke `pg_read_all_stats`, revoke database `CONNECT`, and drop the two local roles interactively. Secret deletion and role removal are destructive and are never automated by repository scripts.
