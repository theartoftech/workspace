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
- Incident and authentication SQLite data stay under the host runtime data directory and are excluded from deployment archives.
- Kubernetes bearer tokens, the OIDC client secret, and authentication session keys are read only from individually mounted host runtime files; they are never placed in Compose environment variables or synchronized archives.
- Cloudflare Access remains an outer perimeter. Its identity headers are not trusted as Workspace Monitor identity, and repository scripts never modify Cloudflare, DNS, tunnels, or provider configuration.

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

The deploy action creates `${MONITORING_DATA_DIR}/incidents` with group-write access for the unprivileged API container and stores `incidents.sqlite` and `auth.sqlite` there. Plan, preflight, status, verify, and logs do not create or modify that directory. Container replacement must preserve it. The incident database contains operational history and operator-entered reasons. The authentication database contains encrypted session payloads, opaque identifier hashes, and bounded audit history. Neither database may be copied into deployment archives, logs, screenshots, or Git. Notification credentials are not configured or accepted.

### Required enterprise identity decisions and runtime files

Sprint 7 is implemented locally but must not be deployed from placeholder settings. Before preflight, explicitly approve and register a confidential direct-OIDC client with all of these capabilities:

- exact redirect URI `https://monitor.jefferyhaynes.net/auth/callback`;
- post-logout return URI `https://monitor.jefferyhaynes.net/` when provider logout is supported;
- Authorization Code flow, PKCE S256, `client_secret_basic`, ID token validation, UserInfo, and refresh-token issuance;
- an approved scope set containing `openid`;
- one approved display-name claim and one group-valued role claim;
- three distinct exact group values for Viewer, Operator, and Administrator.

Set the approved non-secret values in the remote runtime `.env`:

```dotenv
MONITORING_PUBLIC_URL=https://monitor.jefferyhaynes.net
OIDC_ISSUER_URL=https://<approved-provider>/<approved-issuer-path>
OIDC_CLIENT_ID=<approved-confidential-client-id>
OIDC_SCOPES=<approved-openid-including-scope-set>
OIDC_DISPLAY_NAME_CLAIM=<approved-claim-path>
OIDC_ROLE_CLAIM=<approved-group-claim-path>
OIDC_VIEWER_GROUP=<exact-viewer-group>
OIDC_OPERATOR_GROUP=<exact-operator-group>
OIDC_ADMINISTRATOR_GROUP=<exact-administrator-group>
```

Do not copy the placeholder issuer or mappings from `.env.example` into a deployment. Do not add the client secret or session key to `.env`. Install them through the approved secret-transfer workflow at these exact paths:

- `/home/jhaynes/workspace-monitor/runtime/lab-docker/data/runtime-secrets/oidc_client_secret`
- `/home/jhaynes/workspace-monitor/runtime/lab-docker/data/runtime-secrets/auth_session_keyring`

Both files must be regular files owned by UID/GID `10001` with exact mode `0400`. The client-secret file contains only the provider-issued value. The keyring file has this strict schema, with a unique safe key ID and a password-manager or CSPRNG-generated 32-byte secret encoded as unpadded base64url:

```json
{
  "version": 1,
  "activeKeyId": "<current-key-id>",
  "keys": [
    {
      "id": "<current-key-id>",
      "secret": "<43-character-base64url-encoded-32-byte-secret>"
    }
  ]
}
```

Never print either file, pass its value on a command line, store it in shell history, or include it in a support artifact. Preflight checks only existence, exact ownership/mode, non-emptiness, and keyring version; application startup performs strict parsing without echoing the value.

For controlled key rotation, add one new key, set it active, retain only the immediately previous key, and replace the file atomically before restarting `inventory-api`. Existing sessions using the previous key survive. After the 12-hour absolute session bound (plus the 10-minute transaction bound), remove the previous key and restart; any remaining record tied to it fails closed. Removing a key immediately is the emergency session-revocation mechanism. Separately rotate or revoke the OIDC client secret through the provider and secure runtime workflow. Back up `auth.sqlite` only through an approved encrypted operational process and always together with the applicable keyring revision.

The OIDC callback uses a query string. Local Nginx callback access logging is disabled, but Cloudflare and provider logging are externally managed. Review their query-string handling before deployment. Do not treat Cloudflare Access headers as a substitute for this validated OIDC session.

### Required live Kubernetes evidence

The portal can still explain partial data without Kubernetes credentials, but deployment verification requires live topology and Sprint 6 log evidence. First review `deploy/kubernetes/inventory-reader-rbac.yaml`. It grants `get`/`list` only for topology resources inside the catalog namespaces `default`, `cpq-test`, and `public-site`, plus `get` only on the `pods/log` subresource in those same namespaces. Namespace reads are name-restricted, and cluster scope is limited to read-only node inventory. Mutation, pod exec/attach, and watch permissions are deliberately absent.

Applying RBAC is a separate, explicit cluster mutation and is not performed by the deployment script. Apply the reviewed manifest from the workspace before deploying the monitoring release, because the deployment verifier requires live topology and log evidence:

```sh
scp deploy/kubernetes/inventory-reader-rbac.yaml \
  jhaynes@192.168.86.246:/tmp/workspace-monitor-rbac.yaml
ssh -t jhaynes@192.168.86.246 \
  'sudo k3s kubectl apply -f /tmp/workspace-monitor-rbac.yaml'
ssh jhaynes@192.168.86.246 \
  'rm -f /tmp/workspace-monitor-rbac.yaml'
ssh -t jhaynes@192.168.86.246 \
  'sudo k3s kubectl auth can-i --as=system:serviceaccount:monitoring:workspace-monitor-inventory list deployments -n default'
ssh -t jhaynes@192.168.86.246 \
  'sudo k3s kubectl auth can-i --as=system:serviceaccount:monitoring:workspace-monitor-inventory list nodes'
ssh -t jhaynes@192.168.86.246 \
  'sudo k3s kubectl auth can-i --as=system:serviceaccount:monitoring:workspace-monitor-inventory get pods/log -n default'
```

All three authorization checks must return `yes`. Mutation checks such as `create`, `update`, `patch`, and `delete`, and access checks for `pods/exec` and `pods/attach`, must remain `no`. Issue a bounded token and install it so only the inventory container UID can read it:

```sh
ssh -t jhaynes@192.168.86.246 \
  "sudo sh -c 'mkdir -p /home/jhaynes/workspace-monitor/runtime/lab-docker/data/runtime-secrets && k3s kubectl --namespace monitoring create token workspace-monitor-inventory --duration=168h | install -o 10001 -g 10001 -m 0400 /dev/stdin /home/jhaynes/workspace-monitor/runtime/lab-docker/data/runtime-secrets/kubernetes_inventory_token'"
```

The Compose profile connects to `https://192.168.86.246:6443`, an address present in the lab k3s API certificate, and mounts its server CA from `/var/lib/rancher/k3s/server/tls/server-ca.crt`. If the host address changes, set `KUBERNETES_API_URL` to a DNS name or IP present in that certificate and override `KUBERNETES_HOST_CA_FILE` only when the reviewed server path differs. Do not disable TLS verification or use `host.docker.internal`, which is not covered by the lab certificate. Renew the token before expiry and restart only `inventory-api` so it rereads the file. An expired or rejected token becomes an explicit unavailable source and cannot turn workload health green.

### Portfolio request metrics prerequisite

Deploy the portfolio repository before this monitoring release. Its Kubernetes manifest adds a pinned Nginx exporter sidecar and a separate `public-website-metrics` ClusterIP Service. The Nginx status listener binds only to pod loopback; neither the status endpoint nor exporter is added to the public website LoadBalancer.

Prometheus resolves that private Service through k3s CoreDNS. `KUBERNETES_CLUSTER_DNS` defaults to the standard k3s address `10.43.0.10`; set it explicitly in the runtime `.env` if the cluster uses another service CIDR. The monitoring `verify` command refuses acceptance unless the portfolio `request-total` series is present.

After the Kubernetes and identity prerequisites are provisioned, run the read-only preflight:

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
2. Verify public `/healthz`, anonymous redirects for all primary pages, anonymous `401` responses for monitoring/incident/log/source APIs, an OIDC login redirect, resource limits, and existing Grafana/monitoring health over loopback.
3. Confirm that the Cloudflare Access policy is active for `monitor.jefferyhaynes.net`.
4. Change the user-managed tunnel origin from `http://localhost:3000` to `http://localhost:3100`.
5. Through the public TLS origin, complete human acceptance with dedicated Viewer, Operator, and Administrator identities: prove Viewer read-only behavior, Operator incident commands and attribution, Administrator audit access, safe logout/return paths, expiry behavior, and source/redaction disclosure.
6. If verification fails, restore the tunnel origin to `http://localhost:3000`; this tunnel rollback is independent of container rollback.

The repository script automates steps 1 and 2 only. It cannot create an authenticated browser session or bypass OIDC for verification. Steps 3–6 remain explicit operator actions. Deployment is not authorized until the provider/mapping/key-custody decisions above are approved and the runtime files are provisioned. See [PORTAL_ROLLBACK.md](PORTAL_ROLLBACK.md) for the exact image/API and tunnel rollback procedures. Live inventory always identifies partial and unavailable sources; preview-only routes retain their fixture disclosure.

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
