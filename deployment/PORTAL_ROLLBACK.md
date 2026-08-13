# Portal deployment and rollback runbook

This runbook covers the Sprint 1.1 lab portal only. It does not delete containers, images, volumes, monitoring data, or credentials. Cloudflare tunnel and Access changes remain user-managed and are never performed by repository scripts.

## Record before deployment

From the workstation, record the Git baseline and render the deployment plan:

```sh
git rev-parse --verify HEAD
./deployment/scripts/deploy-lab-docker.sh plan \
  --host 192.168.86.246 --ssh-user jhaynes
```

The remote plan prints `Candidate revision: candidate-<sha256>`. Record that full value: it is derived from the exact credential-free archive sent to `cpqserver`, and the server verifies the archive digest before replacing the release directory. The deploy command packages the candidate again, so record and use the revision printed by deploy for image and rollback tracking.

On `cpqserver`, record the current portal image if a portal is already deployed:

```sh
cd /home/jhaynes/workspace-monitor/release
MONITORING_ENV_FILE=/home/jhaynes/workspace-monitor/runtime/lab-docker/.env \
  docker-compose --project-name lab-observability \
  --env-file /home/jhaynes/workspace-monitor/runtime/lab-docker/.env \
  --project-directory deploy/compose/lab-observability \
  -f deploy/compose/lab-observability/compose.yaml images portal
```

Keep the prior `workspace-monitor-portal:<revision>` tag in the local Docker image store until the new deployment and public cutover are accepted. A revision may be a Git hash from an earlier clean release or a `candidate-<sha256>` content revision.

## Pre-cutover verification

Do not change Cloudflare until all checks pass:

```sh
./deployment/scripts/deploy-lab-docker.sh verify \
  --host 192.168.86.246 --ssh-user jhaynes
ssh jhaynes@192.168.86.246 \
  'curl -fsS http://127.0.0.1:3100/healthz && curl -fsS http://127.0.0.1:3000/api/health'
```

The first URL must return `healthy`; the second confirms that Grafana remains available. Review the portal at `http://localhost:3100` through an SSH tunnel before changing the public origin.

## Cloudflare cutover

Confirm that Cloudflare Access protects `monitor.jefferyhaynes.net`, then change its tunnel origin from `http://localhost:3000` to `http://localhost:3100`. Verify TLS, Access enforcement, fixture disclosure, and every primary portal route.

## Container rollback

Container rollback does not change Cloudflare. On `cpqserver`, first confirm that the prior immutable revision tag exists:

```sh
docker image inspect workspace-monitor-portal:<prior-revision>
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

After reviewing that output, restore only the portal without rebuilding it:

```sh
PORTAL_BUILD_REVISION=<prior-revision> \
MONITORING_ENV_FILE=/home/jhaynes/workspace-monitor/runtime/lab-docker/.env \
  docker-compose --project-name lab-observability \
  --env-file /home/jhaynes/workspace-monitor/runtime/lab-docker/.env \
  --project-directory deploy/compose/lab-observability \
  -f deploy/compose/lab-observability/compose.yaml \
  up -d --no-deps --no-build portal
```

Re-run `/healthz` and all primary-route checks. The monitoring services and their volumes are not recreated by this command.

After the prior portal has passed verification, record the restored revision:

```sh
printf '%s\n' '<prior-revision>' > \
  /home/jhaynes/workspace-monitor/runtime/lab-docker/portal-revision
```

## Tunnel-origin rollback

Tunnel-origin rollback is independent from Container rollback. If the new public path fails, restore `monitor.jefferyhaynes.net` from `http://localhost:3100` to the recorded prior origin `http://localhost:3000`. Recheck Cloudflare Access and Grafana login before declaring rollback complete.

Do not remove the failed portal container or image until its logs and image revision have been captured for diagnosis.
