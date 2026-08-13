# Monitoring deployment environments

The primary upskilling deployment is one Docker Compose stack on the same Ubuntu server that runs CPQ. This is intentionally simpler than the target cloud architecture. The Helm and independent Gatus profiles remain available for later separation.

| Profile | Runtime | Default location | Persistent state | Exposure |
| --- | --- | --- | --- | --- |
| Primary lab profile | Docker Compose | `192.168.86.246` beside CPQ | Docker volumes plus `runtime/lab-docker/data` | Loopback only through the user-managed Cloudflare tunnel |
| Future cloud profile | Helm on Kubernetes | Namespace `monitoring` | Prometheus, Alertmanager, and Grafana PVCs | Defined during cloud hardening |
| Future independent probes | Docker Compose | Separate internal/external hosts | Per-host SQLite data | Deferred until independent hosts exist |

## Safety model

- `plan` renders or validates configuration without target access.
- `preflight` is read-only and verifies prerequisites and secrets.
- `deploy` is the only mutating command and requires an exact `--confirm-deploy` value.
- `status`, `verify`, and `logs` are read-only.
- There is deliberately no uninstall, purge, PVC deletion, or secret-generation command in Sprint 0.
- Remote Kubernetes synchronization contains only the deployment script and Helm chart.
- Remote Gatus synchronization contains only its script, Compose/config files, and non-secret example environment file.
- Runtime `.env` files and SQLite databases are never transferred from the workstation or committed to Git.
- Kubernetes bearer tokens are read only from a host-mounted runtime file; they are never placed in Compose environment variables or synchronized archives.

## Primary single-host lab profile

The CPQ server currently has Docker 29.1.3 and standalone `docker-compose` 5.3.1. The script detects either standalone `docker-compose` or the Docker Compose plugin. The stack uses these loopback ports and does not conflict with CPQ, Keycloak, Mailpit, or ERPNet:

| Service | Host port |
| --- | ---: |
| Enterprise portal | 3100 |
| Inventory API | No host binding; proxied at portal `/api/` |
| Grafana | 3000 |
| Prometheus | 9090 |
| Blackbox Exporter | 9115 |
| Internal Gatus | 8085 |
| Public-path Gatus simulation | 8186 |

Run the remote, non-mutating plan first:

```sh
./deployment/scripts/deploy-lab-docker.sh plan \
  --host 192.168.86.246 --ssh-user jhaynes
```

The plan synchronizes only credential-free sources. On the server, prepare runtime state separately:

```sh
ssh jhaynes@192.168.86.246
mkdir -p "$HOME/workspace-monitor/runtime/lab-docker/secrets"
mkdir -p "$HOME/workspace-monitor/runtime/lab-docker/data"
mkdir -p "$HOME/workspace-monitor/runtime/lab-docker/data/runtime-secrets"
chmod 700 "$HOME/workspace-monitor/runtime/lab-docker/secrets"
chmod 755 "$HOME/workspace-monitor/runtime/lab-docker/data/runtime-secrets"
cp "$HOME/workspace-monitor/release/deploy/compose/lab-observability/.env.example" \
  "$HOME/workspace-monitor/runtime/lab-docker/.env"
chmod 600 "$HOME/workspace-monitor/runtime/lab-docker/.env"
```

Edit `.env` and set these values to absolute server paths:

```dotenv
MONITORING_DATA_DIR=/home/jhaynes/workspace-monitor/runtime/lab-docker/data
GRAFANA_ADMIN_PASSWORD_FILE=/home/jhaynes/workspace-monitor/runtime/lab-docker/secrets/grafana_admin_password
MONITORING_ENV_FILE=/home/jhaynes/workspace-monitor/runtime/lab-docker/.env
```

Set `MONITORING_UID` and `MONITORING_GID` from `id -u` and `id -g`. Create the Grafana password file with a password-manager-generated value, owned by that UID/GID, and mode `0640`. Grafana remains UID 472 and receives the monitoring host group as a supplementary group solely to read this file. Sprint 0 does not require SMTP or webhook credentials; notification delivery is deferred until the integration design is reviewed.

### Optional live Kubernetes evidence

Gatus inventory works without Kubernetes credentials. In that case, the portal deliberately reports `partial` mode and mapped workloads remain unknown. To enable Kubernetes evidence, first review `deploy/kubernetes/inventory-reader-rbac.yaml`. It grants only `get` on Deployments and Pods and binds that role only in the catalog namespaces `default` and `cpq-test`.

Applying RBAC is a separate, explicit cluster mutation and is not performed by the deployment script:

```sh
cd "$HOME/workspace-monitor/release"
kubectl apply -f deploy/kubernetes/inventory-reader-rbac.yaml
kubectl auth can-i --as=system:serviceaccount:monitoring:workspace-monitor-inventory get deployment/application -n default
kubectl auth can-i --as=system:serviceaccount:monitoring:workspace-monitor-inventory list deployments -n default
```

The first authorization check must return `yes`; the second must return `no`. Issue a bounded token and install it so only the inventory container UID can read it:

```sh
kubectl --namespace monitoring create token workspace-monitor-inventory --duration=168h | \
  sudo install -o 10001 -g 10001 -m 0400 /dev/stdin \
  /home/jhaynes/workspace-monitor/runtime/lab-docker/data/runtime-secrets/kubernetes_inventory_token
```

The Compose profile mounts the k3s server CA from `/var/lib/rancher/k3s/server/tls/server-ca.crt`; override `KUBERNETES_HOST_CA_FILE` only when the reviewed server path differs. Renew the token before expiry and restart only `inventory-api` so it rereads the file. An expired or rejected token becomes an explicit unavailable source and cannot turn workload health green.

Then run the read-only preflight:

```sh
./deployment/scripts/deploy-lab-docker.sh preflight \
  --host 192.168.86.246 --ssh-user jhaynes
```

Deploy only after reviewing plan and preflight output:

```sh
./deployment/scripts/deploy-lab-docker.sh deploy \
  --host 192.168.86.246 --ssh-user jhaynes \
  --confirm-deploy lab-docker
```

Read-only operations:

```sh
./deployment/scripts/deploy-lab-docker.sh status \
  --host 192.168.86.246 --ssh-user jhaynes
./deployment/scripts/deploy-lab-docker.sh verify \
  --host 192.168.86.246 --ssh-user jhaynes
./deployment/scripts/deploy-lab-docker.sh logs \
  --host 192.168.86.246 --ssh-user jhaynes --tail 200
```

### Portal deployment and Cloudflare tunnel

The deployment command creates an explicit credential-free source archive, tags the portal and inventory API with the same `candidate-<sha256>` content revision, verifies that digest on the server before replacing the release directory, and binds only the portal to `127.0.0.1:3100`. It leaves Grafana running on `127.0.0.1:3000` and never changes Cloudflare configuration. Preflight rejects insufficient build capacity and an unrelated listener on port `3100`.

Before Sprint 1.1 cutover, the user-managed tunnel continues to route `monitor.jefferyhaynes.net` to `http://localhost:3000` on the CPQ host. Grafana is configured with `https://monitor.jefferyhaynes.net` as its public root URL. Protect the hostname with Cloudflare Access before public use. Do not store tunnel tokens, credentials, account IDs, or Access policy secrets in this repository.

The implemented deployment and operator-controlled cutover sequence is intentionally reversible:

1. Deploy the portal and inventory API containers without changing Cloudflare.
2. Verify `/healthz`, `/api/v1/inventory`, all primary routes, live/partial disclosure, resource limits, and existing Grafana/monitoring health over loopback.
3. Confirm that the Cloudflare Access policy is active for `monitor.jefferyhaynes.net`.
4. Change the user-managed tunnel origin from `http://localhost:3000` to `http://localhost:3100`.
5. Verify public TLS, Access enforcement, and portal navigation.
6. If verification fails, restore the tunnel origin to `http://localhost:3000`; this tunnel rollback is independent of container rollback.

The repository script automates steps 1 and 2 only. Steps 3–6 remain explicit operator actions. See [PORTAL_ROLLBACK.md](PORTAL_ROLLBACK.md) for the exact image/API and tunnel rollback procedures. Live inventory always identifies partial and unavailable sources; preview-only routes retain their fixture disclosure.

The public-path Gatus process runs on the same host. It validates DNS, TLS, reverse-proxy, and public URL behavior, but it cannot detect loss of the server, LAN, ISP, host Docker daemon, or host power independently.

## Future Kubernetes monitoring stack

The remote k3s host needs Helm 3, `kubectl`, access to the intended cluster, the `monitoring` namespace, and the Grafana bootstrap Secret.

Review locally:

```sh
./deployment/scripts/deploy-monitoring-k8s.sh plan
```

Provision the namespace and Secret separately through the lab's secret workflow. The expected Secret is `lab-observability-grafana-admin` in namespace `monitoring`, with non-empty `admin-user` and `admin-password` keys.

Read-only remote preflight:

```sh
./deployment/scripts/deploy-monitoring-k8s.sh preflight \
  --host 192.168.86.246 --ssh-user jhaynes
```

Intentional deployment after review:

```sh
./deployment/scripts/deploy-monitoring-k8s.sh deploy \
  --host 192.168.86.246 --ssh-user jhaynes \
  --confirm-deploy monitoring
```

Read-only follow-up:

```sh
./deployment/scripts/deploy-monitoring-k8s.sh status \
  --host 192.168.86.246 --ssh-user jhaynes
./deployment/scripts/deploy-monitoring-k8s.sh verify \
  --host 192.168.86.246 --ssh-user jhaynes
```

## Future independent Gatus nodes

Review either node locally with its non-secret example environment:

```sh
./deployment/scripts/deploy-gatus.sh plan --vantage internal
./deployment/scripts/deploy-gatus.sh plan --vantage external
```

Before remote preflight, create the remote runtime directory and its `.env` through a secure channel. For example, the internal node expects `/home/<user>/workspace-monitor/runtime/gatus/internal/.env` when the default remote root is used. Set file mode `0600`, use the Docker host's non-root UID/GID, and replace every placeholder.

Read-only remote preflight:

```sh
./deployment/scripts/deploy-gatus.sh preflight --vantage internal \
  --host <internal-probe-host> --ssh-user <user>
./deployment/scripts/deploy-gatus.sh preflight --vantage external \
  --host <external-probe-host> --ssh-user <user>
```

Intentional deployment after review:

```sh
./deployment/scripts/deploy-gatus.sh deploy --vantage internal \
  --host <internal-probe-host> --ssh-user <user> \
  --confirm-deploy internal
./deployment/scripts/deploy-gatus.sh deploy --vantage external \
  --host <external-probe-host> --ssh-user <user> \
  --confirm-deploy external
```

## Rollback boundary

Helm keeps ten release revisions, so a reviewed Kubernetes rollback can use `helm rollback` outside this script. Gatus configuration rollback is performed by deploying a previously reviewed repository revision. Automated rollback commands are deferred until a sprint defines exact state-preservation and confirmation behavior; adding a convenient destructive shortcut before then would be unsafe.
