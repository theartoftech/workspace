# Portal and operations API deployment and rollback runbook

This runbook covers the lab portal and matching operations API. Monitoring evidence routes, including Sprint 6 log correlation, remain read-only; incident commands are bounded and Sprint 7 authorizes them from validated OIDC sessions. The runbook does not delete containers, images, volumes, incident/authentication history, monitoring data, or credentials. Cloudflare tunnel, Access, DNS, and identity-provider changes remain user-managed and are never performed by repository scripts.

## Record before deployment

From the workstation, record the Git baseline and render the deployment plan:

```sh
git rev-parse --verify HEAD
./deployment/scripts/deploy-lab-docker.sh plan \
  --host 192.168.86.246 --ssh-user jhaynes
```

The remote plan prints `Candidate revision: candidate-<sha256>`. Record that full value: it is derived from the exact credential-free archive sent to `cpqserver`, and the server verifies the archive digest before replacing the release directory. The deploy command packages the candidate again, so record and use the revision printed by deploy for image and rollback tracking.

On `cpqserver`, record the current portal and inventory API images if they are already deployed:

```sh
cd /home/jhaynes/workspace-monitor/release
MONITORING_ENV_FILE=/home/jhaynes/workspace-monitor/runtime/lab-docker/.env \
  docker-compose --project-name lab-observability \
  --env-file /home/jhaynes/workspace-monitor/runtime/lab-docker/.env \
  --project-directory deploy/compose/lab-observability \
  -f deploy/compose/lab-observability/compose.yaml images portal inventory-api
```

Keep both prior `workspace-monitor-portal:<revision>` and `workspace-monitor-inventory-api:<revision>` tags in the local Docker image store until the new deployment and public cutover are accepted. A revision may be a Git hash from an earlier clean release or a `candidate-<sha256>` content revision.

## Pre-cutover verification

Do not change Cloudflare until all checks pass:

```sh
./deployment/scripts/deploy-lab-docker.sh verify \
  --host 192.168.86.246 --ssh-user jhaynes
ssh jhaynes@192.168.86.246 \
  'curl -fsS http://127.0.0.1:3100/healthz && curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/ && curl -sS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3100/api/v1/inventory?environment=all" && curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/auth/login && curl -fsS http://127.0.0.1:3000/api/health'
```

Health must return `healthy`; the anonymous page, inventory API, and login start must return `302`, `401`, and `302` respectively; Grafana health must remain available. Repeat the protected-API check for incidents, logs, topology, performance, and both proxied Gatus routes. The repository verifier performs these checks but cannot bypass OIDC or manufacture a test session. Before public acceptance, review the exact provider registration, role mappings, secret ownership, session-key rotation plan, and external callback-query logging behavior.

## Cloudflare cutover

Confirm that Cloudflare Access protects `monitor.jefferyhaynes.net`, then change its tunnel origin from `http://localhost:3000` to `http://localhost:3100`. Through the public TLS origin, verify Access enforcement, OIDC login/callback/logout, live/partial source disclosure, every primary route, and the role matrix with dedicated Viewer, Operator, and Administrator identities. Confirm that incident audit attribution uses the authenticated identity and that authentication failures disclose no protected evidence. Cloudflare Access remains an outer boundary; do not configure Workspace Monitor to trust its identity headers.

## Container rollback

Container rollback does not change Cloudflare. On `cpqserver`, first confirm that the prior immutable revision tag exists:

```sh
docker image inspect workspace-monitor-portal:<prior-revision>
docker image inspect workspace-monitor-inventory-api:<prior-revision>
```

Then render the prior image selection without mutation:

```sh
cd /home/jhaynes/workspace-monitor/release
PORTAL_BUILD_REVISION=<prior-revision> \
MONITORING_ENV_FILE=/home/jhaynes/workspace-monitor/runtime/lab-docker/.env \
  docker-compose --project-name lab-observability \
  --env-file /home/jhaynes/workspace-monitor/runtime/lab-docker/.env \
  --project-directory deploy/compose/lab-observability \
  -f deploy/compose/lab-observability/compose.yaml config --images
```

After reviewing that output, restore the matching API and portal without rebuilding either image:

```sh
PORTAL_BUILD_REVISION=<prior-revision> \
MONITORING_ENV_FILE=/home/jhaynes/workspace-monitor/runtime/lab-docker/.env \
  docker-compose --project-name lab-observability \
  --env-file /home/jhaynes/workspace-monitor/runtime/lab-docker/.env \
  --project-directory deploy/compose/lab-observability \
  -f deploy/compose/lab-observability/compose.yaml \
  up -d --no-deps --no-build inventory-api portal
```

Re-run `/healthz`, anonymous fail-closed checks, OIDC login start when supported by the selected revision, and all primary-route checks. The monitoring services, their volumes, and `${MONITORING_DATA_DIR}/incidents` are not recreated or removed by this command. Preserve both `incidents.sqlite` and `auth.sqlite`, plus the separately managed keyring and client-secret files, even when the selected revision does not read them. A pre-Sprint-7 API does not enforce application OIDC/RBAC, so Cloudflare Access must remain active and the operator must understand that incident actions again use that revision's configured lab actor. A pre-Sprint-5 API will not read the incident database, but rollback must preserve it for a later compatible revision. If the prior revision predates Sprint 2 and has no inventory API image, restore that fixture portal alone and verify its global fixture disclosure before cutover.

After the prior portal has passed verification, record the restored revision:

```sh
printf '%s\n' '<prior-revision>' > \
  /home/jhaynes/workspace-monitor/runtime/lab-docker/portal-revision
```

## Tunnel-origin rollback

Tunnel-origin rollback is independent from Container rollback. If the new public path fails, restore `monitor.jefferyhaynes.net` from `http://localhost:3100` to the recorded prior origin `http://localhost:3000`. Recheck Cloudflare Access and Grafana login before declaring rollback complete.

Do not remove failed portal/API containers or images until their logs and image revisions have been captured for diagnosis.
