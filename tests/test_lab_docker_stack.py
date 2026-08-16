from __future__ import annotations

import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
STACK_DIR = ROOT / "deploy/compose/lab-observability"
DEPLOY_SCRIPT = ROOT / "deployment/scripts/deploy-lab-docker.sh"
PORTAL_DIR = ROOT / "deploy/portal"
ROLLBACK_RUNBOOK = ROOT / "deployment/PORTAL_ROLLBACK.md"


def run_script(*arguments: str, environment: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    process_environment = os.environ.copy()
    if environment:
        process_environment.update(environment)
    return subprocess.run(
        ["bash", str(DEPLOY_SCRIPT), *arguments],
        cwd=ROOT,
        env=process_environment,
        check=False,
        capture_output=True,
        stdin=subprocess.DEVNULL,
        text=True,
        timeout=30,
    )


def write_executable(path: Path, source: str) -> None:
    path.write_text(source, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def provision_identity_runtime(temporary: Path) -> tuple[str, ...]:
    secret_directory = temporary / "data" / "runtime-secrets"
    secret_directory.mkdir(parents=True, exist_ok=True)
    (secret_directory / "oidc_client_secret").write_text("test-client-secret\n", encoding="utf-8")
    (secret_directory / "auth_session_keyring").write_text(
        '{"version":1,"activeKeyId":"test-key","keys":[{"id":"test-key","secret":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}\n',
        encoding="utf-8",
    )
    write_executable(temporary / "stat", "#!/usr/bin/env bash\nprintf '400 10001\\n'\n")
    return (
        "OIDC_ISSUER_URL=https://identity.example.test/realms/workspace-monitor",
        "OIDC_CLIENT_ID=workspace-monitor",
        "OIDC_SCOPES=openid profile",
        "OIDC_ROLE_CLAIM=groups",
        "OIDC_DISPLAY_NAME_CLAIM=preferred_username",
        "OIDC_VIEWER_GROUP=/workspace-monitor/viewer",
        "OIDC_OPERATOR_GROUP=/workspace-monitor/operator",
        "OIDC_ADMINISTRATOR_GROUP=/workspace-monitor/administrator",
    )


class DeploymentTestHarnessTests(unittest.TestCase):
    def test_script_runner_closes_stdin_and_enforces_a_timeout(self) -> None:
        completed = subprocess.CompletedProcess(["bash"], 0, "", "")
        with patch.object(subprocess, "run", return_value=completed) as mocked_run:
            run_script("help")

        call_options = mocked_run.call_args.kwargs
        self.assertIs(call_options["stdin"], subprocess.DEVNULL)
        self.assertEqual(call_options["timeout"], 30)


class SingleHostComposeContractTests(unittest.TestCase):
    def test_stack_contains_the_expected_foundation_services(self) -> None:
        compose = (STACK_DIR / "compose.yaml").read_text(encoding="utf-8")
        service_section = compose.split("services:\n", maxsplit=1)[1].split("\nsecrets:\n", maxsplit=1)[0]
        services = {
            line.removesuffix(":").strip()
            for line in service_section.splitlines()
            if line.startswith("  ") and not line.startswith("    ") and line.strip().endswith(":")
        }

        self.assertEqual(
            services,
            {
                "prometheus",
                "portal",
                "inventory-api",
                "grafana",
                "blackbox-exporter",
                "node-exporter",
                "cadvisor",
                "gatus-internal",
                "gatus-public-path",
            },
        )

    def test_images_are_pinned_and_resources_are_bounded(self) -> None:
        compose = (STACK_DIR / "compose.yaml").read_text(encoding="utf-8")

        for image in (
            "prom/prometheus:v3.13.1-distroless",
            "grafana/grafana:13.1.0",
            "quay.io/prometheus/blackbox-exporter:v0.28.0",
            "quay.io/prometheus/node-exporter:v1.12.1",
            "ghcr.io/google/cadvisor:v0.57.0",
            "ghcr.io/twin/gatus:v5.34.0",
        ):
            self.assertIn(image, compose)
        self.assertNotIn(":latest", compose)
        self.assertEqual(compose.count("mem_limit:"), 9)
        self.assertEqual(compose.count("cpus:"), 9)

    def test_operator_interfaces_bind_to_loopback_without_port_conflicts(self) -> None:
        compose = (STACK_DIR / "compose.yaml").read_text(encoding="utf-8")

        for port in ("3100:8080", "3000:3000", "9090:9090", "9115:9115", "8085:8080", "8186:8080"):
            self.assertIn(f'"${{MONITORING_BIND_ADDRESS:-127.0.0.1}}:{port}"', compose)
        self.assertNotIn(":8086:8080", compose)
        for cpq_port in ("8080:8080", "8081:8080", "8082:8080", "8083:8080", "8088:8080"):
            self.assertNotIn(cpq_port, compose)

    def test_prometheus_has_one_direct_cpq_scrape_and_host_metrics(self) -> None:
        prometheus = (STACK_DIR / "config/prometheus.yaml").read_text(encoding="utf-8")

        self.assertEqual(prometheus.count("job_name: cpq-demo"), 1)
        self.assertIn("host.docker.internal:8080", prometheus)
        self.assertIn("metrics_path: /api/actuator/prometheus", prometheus)
        self.assertIn("job_name: node-exporter", prometheus)
        self.assertIn("job_name: cadvisor", prometheus)
        self.assertIn("job_name: gatus-internal", prometheus)
        self.assertIn("job_name: gatus-public-path", prometheus)
        self.assertIn("job_name: portfolio-nginx", prometheus)
        self.assertIn("public-website-metrics.public-site.svc.cluster.local:9113", prometheus)
        self.assertIn("service: portfolio", prometheus)
        self.assertIn("KUBERNETES_CLUSTER_DNS:-10.43.0.10", (STACK_DIR / "compose.yaml").read_text(encoding="utf-8"))

    def test_cloudflare_hostname_points_at_loopback_grafana_for_sprint_zero(self) -> None:
        compose = (STACK_DIR / "compose.yaml").read_text(encoding="utf-8")
        example_environment = (STACK_DIR / ".env.example").read_text(encoding="utf-8")

        self.assertIn("GF_SERVER_ROOT_URL: ${MONITORING_PUBLIC_URL}", compose)
        self.assertIn("MONITORING_PUBLIC_URL=https://monitor.jefferyhaynes.net", example_environment)
        self.assertIn("MONITORING_PUBLIC_HOST=monitor.jefferyhaynes.net", example_environment)

    def test_grafana_can_read_group_protected_password_without_running_as_root(self) -> None:
        compose = (STACK_DIR / "compose.yaml").read_text(encoding="utf-8")
        grafana = compose.split("  grafana:\n", maxsplit=1)[1].split("\n  blackbox-exporter:", maxsplit=1)[0]

        self.assertIn('user: "472:0"', grafana)
        self.assertIn('group_add:\n      - "${MONITORING_GID}"', grafana)
        self.assertIn("GF_SECURITY_ADMIN_PASSWORD__FILE: /run/secrets/grafana_admin_password", grafana)

    def test_public_path_probe_is_not_presented_as_independent_external_monitoring(self) -> None:
        config = (STACK_DIR / "config/gatus-public-path.yaml").read_text(encoding="utf-8")

        self.assertIn("Public Path Simulation", config)
        self.assertIn("same lab host", config)

    def test_sprint_zero_does_not_require_notification_integrations(self) -> None:
        example_environment = (STACK_DIR / ".env.example").read_text(encoding="utf-8")
        internal_config = (ROOT / "probes/internal/config.yaml").read_text(encoding="utf-8")
        public_path_config = (STACK_DIR / "config/gatus-public-path.yaml").read_text(encoding="utf-8")

        self.assertNotIn("GATUS_SMTP_", example_environment)
        self.assertNotIn("GATUS_WEBHOOK_URL", example_environment)
        self.assertNotIn("alerting:", internal_config)
        self.assertNotIn("alerts:", internal_config)
        self.assertNotIn("alerting:", public_path_config)
        self.assertNotIn("alerts:", public_path_config)


class PortalPackagingContractTests(unittest.TestCase):
    def test_inventory_api_is_reproducible_unprivileged_and_not_host_exposed(self) -> None:
        dockerfile = (ROOT / "deploy/inventory-api/Dockerfile").read_text(encoding="utf-8")
        compose = (STACK_DIR / "compose.yaml").read_text(encoding="utf-8")
        example_environment = (STACK_DIR / ".env.example").read_text(encoding="utf-8")
        api = compose.split("  inventory-api:\n", maxsplit=1)[1].split("\n  prometheus:", maxsplit=1)[0]

        self.assertRegex(dockerfile, r"FROM node:[^\s]+@sha256:[0-9a-f]{64} AS build")
        self.assertIn("RUN npm ci --ignore-scripts", dockerfile)
        self.assertIn("RUN npm run build:server", dockerfile)
        self.assertIn("RUN npm ci --omit=dev --ignore-scripts", dockerfile)
        self.assertIn("USER 10001:10001", dockerfile)
        self.assertIn("server/src/main.js", dockerfile)
        self.assertIn("dockerfile: deploy/inventory-api/Dockerfile", api)
        self.assertIn('user: "10001:10001"', api)
        self.assertIn('group_add:\n      - "${MONITORING_GID}"', api)
        self.assertIn("read_only: true", api)
        self.assertIn("no-new-privileges:true", api)
        self.assertIn("cap_drop:\n      - ALL", api)
        self.assertNotIn("ports:", api)
        self.assertIn("KUBERNETES_TOKEN_FILE: /run/secrets/kubernetes_inventory_token", api)
        self.assertIn("KUBERNETES_API_URL: ${KUBERNETES_API_URL:-https://192.168.86.246:6443}", api)
        self.assertIn("KUBERNETES_API_URL=https://192.168.86.246:6443", example_environment)
        self.assertIn("PROMETHEUS_API_URL: http://prometheus:9090", api)
        self.assertIn('PROMETHEUS_CONCURRENCY: "4"', api)
        self.assertIn("INCIDENT_DATABASE_PATH: /var/lib/workspace-monitor/incidents.sqlite", api)
        self.assertNotIn("INCIDENT_OPERATOR_ID", api)
        self.assertIn("AUTH_PUBLIC_ORIGIN: ${MONITORING_PUBLIC_URL}", api)
        self.assertIn("OIDC_ISSUER_URL: ${OIDC_ISSUER_URL}", api)
        self.assertIn("OIDC_CLIENT_ID: ${OIDC_CLIENT_ID}", api)
        self.assertIn("OIDC_CLIENT_SECRET_FILE: /run/secrets/oidc_client_secret", api)
        self.assertIn("AUTH_SESSION_DATABASE_PATH: /var/lib/workspace-monitor/auth.sqlite", api)
        self.assertIn("AUTH_SESSION_KEYRING_FILE: /run/secrets/auth_session_keyring", api)
        self.assertIn("OIDC_VIEWER_GROUP: ${OIDC_VIEWER_GROUP}", api)
        self.assertIn("OIDC_OPERATOR_GROUP: ${OIDC_OPERATOR_GROUP}", api)
        self.assertIn("OIDC_ADMINISTRATOR_GROUP: ${OIDC_ADMINISTRATOR_GROUP}", api)
        self.assertIn('INCIDENT_EVALUATION_INTERVAL_SECONDS: "30"', api)
        self.assertIn("depends_on:\n      - prometheus", api)
        self.assertNotIn("runtime-secrets:/run/secrets:ro", api)
        for secret_name in ("kubernetes_inventory_token", "oidc_client_secret", "auth_session_keyring"):
            self.assertIn(f"runtime-secrets/{secret_name}:/run/secrets/{secret_name}:ro", api)
        self.assertIn("${MONITORING_DATA_DIR}/incidents:/var/lib/workspace-monitor", api)
        self.assertIn("mem_limit: 128m", api)
        self.assertIn("cpus: 0.25", api)

    def test_portal_uses_a_reproducible_multi_stage_unprivileged_image(self) -> None:
        dockerfile = (PORTAL_DIR / "Dockerfile").read_text(encoding="utf-8")
        dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8")

        self.assertRegex(
            dockerfile,
            r"FROM node:[0-9]+\.[0-9]+\.[0-9]+-alpine[0-9.]+@sha256:[0-9a-f]{64} AS build",
        )
        self.assertIn("RUN npm ci --ignore-scripts", dockerfile)
        self.assertIn("RUN npm run build", dockerfile)
        self.assertRegex(
            dockerfile,
            r"FROM nginxinc/nginx-unprivileged:[0-9]+\.[0-9]+\.[0-9]+-alpine[0-9.]+@sha256:[0-9a-f]{64}",
        )
        self.assertIn("COPY --from=build", dockerfile)
        self.assertIn("/workspace/dist", dockerfile)
        self.assertIn("USER 101:101", dockerfile)
        self.assertIn("org.opencontainers.image.revision", dockerfile)
        self.assertIn("grep -q '^healthy$'", dockerfile)
        self.assertNotIn("grep --quiet", dockerfile)
        for excluded in ("node_modules", "dist", "coverage", ".git", ".env", "runtime"):
            self.assertIn(excluded, dockerignore)
        self.assertNotIn("**/data", dockerignore)
        self.assertNotIn("web/src/data", dockerignore)

    def test_nginx_serves_health_spa_routes_caching_and_security_headers(self) -> None:
        nginx = (PORTAL_DIR / "default.conf").read_text(encoding="utf-8")

        self.assertIn("listen 8080", nginx)
        self.assertIn("location = /healthz", nginx)
        self.assertIn('return 200 "healthy\\n"', nginx)
        self.assertIn("try_files $uri $uri/ /index.html", nginx)
        self.assertIn("location /api/", nginx)
        self.assertIn("location /auth/", nginx)
        self.assertIn("location = /auth/callback", nginx)
        self.assertIn("access_log off", nginx.split("location = /auth/callback", maxsplit=1)[1].split("}", maxsplit=1)[0])
        self.assertIn("location = /_auth/check", nginx)
        self.assertIn("internal", nginx.split("location = /_auth/check", maxsplit=1)[1].split("}", maxsplit=1)[0])
        self.assertIn("/api/v1/auth-check", nginx)
        self.assertGreaterEqual(nginx.count("auth_request /_auth/check"), 3)
        self.assertIn("error_page 401 = @oidc_login", nginx)
        self.assertIn("return 302 /auth/login", nginx)
        self.assertIn("proxy_pass http://inventory-api:3001", nginx)
        self.assertIn("client_max_body_size 16k", nginx)
        self.assertIn("location /tools/gatus-internal/", nginx)
        self.assertIn("location /tools/gatus-public-path/", nginx)
        self.assertNotIn("/cdn-cgi/access/logout", nginx)
        self.assertIn("public, max-age=31536000, immutable", nginx)
        self.assertIn('default "no-store"', nginx)
        for header in (
            "Content-Security-Policy",
            "X-Content-Type-Options",
            "X-Frame-Options",
            "Referrer-Policy",
            "Permissions-Policy",
        ):
            self.assertIn(f"add_header {header}", nginx)

    def test_portal_compose_service_is_loopback_only_bounded_and_hardened(self) -> None:
        compose = (STACK_DIR / "compose.yaml").read_text(encoding="utf-8")
        portal = compose.split("  portal:\n", maxsplit=1)[1].split("\n  prometheus:", maxsplit=1)[0]

        self.assertIn("context: ../../..", portal)
        self.assertIn("dockerfile: deploy/portal/Dockerfile", portal)
        self.assertIn("PORTAL_BUILD_REVISION", portal)
        self.assertIn('image: "workspace-monitor-portal:${PORTAL_BUILD_REVISION:-development}"', portal)
        self.assertIn('user: "101:101"', portal)
        self.assertIn("read_only: true", portal)
        self.assertIn("no-new-privileges:true", portal)
        self.assertIn("cap_drop:\n      - ALL", portal)
        self.assertIn('"${MONITORING_BIND_ADDRESS:-127.0.0.1}:3100:8080"', portal)
        self.assertIn("healthcheck:", portal)
        self.assertIn("http://127.0.0.1:8080/healthz", portal)
        self.assertIn("grep -q '^healthy$'", portal)
        self.assertNotIn("grep --quiet", portal)
        self.assertIn("tmpfs:", portal)
        self.assertIn("mem_limit: 128m", portal)
        self.assertIn("cpus: 0.25", portal)

    def test_portal_rollback_runbook_separates_container_and_tunnel_recovery(self) -> None:
        runbook = ROLLBACK_RUNBOOK.read_text(encoding="utf-8")

        self.assertIn("Container rollback", runbook)
        self.assertIn("Tunnel-origin rollback", runbook)
        self.assertIn("--no-build", runbook)
        self.assertIn("workspace-monitor-inventory-api:<prior-revision>", runbook)
        self.assertIn("inventory-api portal", runbook)
        self.assertIn("http://localhost:3100", runbook)
        self.assertIn("http://localhost:3000", runbook)
        self.assertIn("Cloudflare Access", runbook)
        self.assertIn("candidate-<sha256>", runbook)


class SingleHostDeploymentScriptTests(unittest.TestCase):
    def test_help_describes_review_boundaries(self) -> None:
        result = run_script("help")

        self.assertEqual(result.returncode, 0, result.stderr)
        for command in ("plan", "preflight", "deploy", "status", "verify", "logs"):
            self.assertIn(command, result.stdout)

    def test_deploy_requires_exact_profile_confirmation(self) -> None:
        result = run_script("deploy")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--confirm-deploy lab-docker", result.stderr)

    def test_plan_supports_the_servers_standalone_docker_compose(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            command_log = temporary / "commands.log"
            write_executable(
                temporary / "docker",
                "#!/usr/bin/env bash\nif [[ \"${1:-}\" == compose ]]; then exit 1; fi\nexit 1\n",
            )
            write_executable(
                temporary / "docker-compose",
                '#!/usr/bin/env bash\nprintf \'docker-compose %s\\n\' "$*" >> "$MONITORING_MOCK_LOG"\n',
            )
            result = run_script(
                "plan",
                "--env-file",
                str(STACK_DIR / ".env.example"),
                environment={
                    "PATH": f"{temporary}:{os.environ['PATH']}",
                    "MONITORING_MOCK_LOG": str(command_log),
                },
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            commands = command_log.read_text(encoding="utf-8")
            self.assertIn("docker-compose", commands)
            self.assertIn("config", commands)
            self.assertNotIn(" up ", f" {commands} ")

    def test_preflight_rejects_example_secrets(self) -> None:
        result = run_script("preflight", "--env-file", str(STACK_DIR / ".env.example"))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("placeholder", result.stderr.lower())

    def test_preflight_accepts_runtime_without_notification_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            password_file = temporary / "grafana_admin_password"
            password_file.write_text("valid-test-password\n", encoding="utf-8")
            token_file = temporary / "data" / "runtime-secrets" / "kubernetes_inventory_token"
            token_file.parent.mkdir(parents=True)
            token_file.write_text("test-read-only-token\n", encoding="utf-8")
            identity_environment = provision_identity_runtime(temporary)
            environment_file = temporary / ".env"
            environment_file.write_text(
                "\n".join(
                    (
                        "MONITORING_BIND_ADDRESS=127.0.0.1",
                        "MONITORING_PUBLIC_HOST=monitor.jefferyhaynes.net",
                        "MONITORING_PUBLIC_URL=https://monitor.jefferyhaynes.net",
                        "MONITORING_UID=1000",
                        "MONITORING_GID=1000",
                        f"MONITORING_DATA_DIR={temporary / 'data'}",
                        f"MONITORING_ENV_FILE={environment_file}",
                        f"GRAFANA_ADMIN_PASSWORD_FILE={password_file}",
                        *identity_environment,
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            write_executable(temporary / "docker", "#!/usr/bin/env bash\nexit 0\n")
            write_executable(temporary / "ss", "#!/usr/bin/env bash\nexit 0\n")

            result = run_script(
                "preflight",
                "--env-file",
                str(environment_file),
                environment={"PATH": f"{temporary}:{os.environ['PATH']}"},
            )

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_preflight_rejects_port_occupied_outside_the_portal_service(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            password_file = temporary / "grafana_admin_password"
            password_file.write_text("valid-test-password\n", encoding="utf-8")
            token_file = temporary / "data" / "runtime-secrets" / "kubernetes_inventory_token"
            token_file.parent.mkdir(parents=True)
            token_file.write_text("test-read-only-token\n", encoding="utf-8")
            identity_environment = provision_identity_runtime(temporary)
            environment_file = temporary / ".env"
            environment_file.write_text(
                "\n".join(
                    (
                        "MONITORING_BIND_ADDRESS=127.0.0.1",
                        "MONITORING_PUBLIC_HOST=monitor.jefferyhaynes.net",
                        "MONITORING_PUBLIC_URL=https://monitor.jefferyhaynes.net",
                        "MONITORING_UID=1000",
                        "MONITORING_GID=1000",
                        f"MONITORING_DATA_DIR={temporary / 'data'}",
                        f"MONITORING_ENV_FILE={environment_file}",
                        f"GRAFANA_ADMIN_PASSWORD_FILE={password_file}",
                        *identity_environment,
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            write_executable(temporary / "docker", "#!/usr/bin/env bash\nexit 0\n")
            write_executable(
                temporary / "ss",
                "#!/usr/bin/env bash\nprintf 'LISTEN 0 4096 127.0.0.1:3100 0.0.0.0:*\\n'\n",
            )

            result = run_script(
                "preflight",
                "--env-file",
                str(environment_file),
                environment={"PATH": f"{temporary}:{os.environ['PATH']}"},
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("port 3100 is already occupied", result.stderr)

    def test_invalid_portal_revision_fails_explicitly(self) -> None:
        result = run_script(
            "plan",
            "--env-file",
            str(STACK_DIR / ".env.example"),
            environment={"PORTAL_BUILD_REVISION": "not-a-git-revision"},
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PORTAL_BUILD_REVISION", result.stderr)

    def test_candidate_content_revision_is_valid_for_portal_builds(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            write_executable(temporary / "docker", "#!/usr/bin/env bash\nexit 0\n")

            result = run_script(
                "plan",
                "--env-file",
                str(STACK_DIR / ".env.example"),
                environment={
                    "PATH": f"{temporary}:{os.environ['PATH']}",
                    "PORTAL_BUILD_REVISION": f"candidate-{'a' * 64}",
                },
            )

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_remote_deploy_packages_dirty_candidate_with_verified_content_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            ssh_calls = temporary / "ssh-calls"
            archive_contents = temporary / "archive-contents"
            ssh_count = temporary / "ssh-count"
            write_executable(
                temporary / "git",
                "#!/usr/bin/env bash\nprintf 'git must not determine candidate provenance\\n' >&2\nexit 99\n",
            )
            write_executable(
                temporary / "ssh",
                """#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MONITORING_SSH_CALLS"
count=0
[[ ! -f "$MONITORING_SSH_COUNT" ]] || count="$(<"$MONITORING_SSH_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$MONITORING_SSH_COUNT"
if (( count == 1 )); then
    tar -tf - > "$MONITORING_ARCHIVE_CONTENTS"
else
    cat >/dev/null
fi
""",
            )

            result = run_script(
                "deploy",
                "--confirm-deploy",
                "lab-docker",
                "--host",
                "cpqserver.example",
                "--ssh-user",
                "jhaynes",
                environment={
                    "PATH": f"{temporary}:{os.environ['PATH']}",
                    "MONITORING_ARCHIVE_CONTENTS": str(archive_contents),
                    "MONITORING_SSH_CALLS": str(ssh_calls),
                    "MONITORING_SSH_COUNT": str(ssh_count),
                },
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            revision_match = re.search(r"Candidate revision: (candidate-[0-9a-f]{64})", result.stdout)
            self.assertIsNotNone(revision_match, result.stdout)
            revision = revision_match.group(1)
            calls = ssh_calls.read_text(encoding="utf-8")
            self.assertIn("sha256sum --check", calls)
            self.assertIn(revision, calls)
            self.assertIn(f"PORTAL_BUILD_REVISION={revision}", calls)
            sync_call = calls.splitlines()[0]
            self.assertLess(sync_call.index("sha256sum --check"), sync_call.index("rm -rf --"))

            synchronized_paths = archive_contents.read_text(encoding="utf-8").splitlines()
            self.assertTrue(any(path.endswith("web/src/main.tsx") for path in synchronized_paths))
            self.assertTrue(any(path.endswith("server/src/main.ts") for path in synchronized_paths))
            self.assertTrue(any(path.endswith("catalog/services.json") for path in synchronized_paths))
            self.assertTrue(any(path.endswith("deploy/portal/Dockerfile") for path in synchronized_paths))
            self.assertTrue(any(path.endswith("deploy/inventory-api/Dockerfile") for path in synchronized_paths))
            forbidden_parts = ("/.git/", "/node_modules/", "/dist/", "/coverage/", "/runtime/")
            for path in synchronized_paths:
                normalized_path = f"/{path.removeprefix('./')}"
                self.assertFalse(any(part in normalized_path for part in forbidden_parts), path)
                self.assertNotIn("/deploy/compose/lab-observability/data/", normalized_path, path)
                self.assertNotIn("/probes/internal/data/", normalized_path, path)
                self.assertNotIn("/probes/external/data/", normalized_path, path)
                self.assertFalse(normalized_path.endswith("/.env"), path)
                self.assertNotIn("/secrets/", normalized_path, path)

    def test_direct_local_deploy_still_rejects_dirty_git_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            write_executable(
                temporary / "git",
                """#!/usr/bin/env bash
if [[ " $* " == *" rev-parse --short=12 HEAD "* ]]; then printf 'abcdef123456\n'; exit 0; fi
if [[ " $* " == *" rev-parse --is-inside-work-tree "* ]]; then exit 0; fi
if [[ " $* " == *" status --porcelain --untracked-files=normal "* ]]; then printf ' M web/src/main.tsx\n'; exit 0; fi
exit 1
""",
            )

            result = run_script(
                "deploy",
                "--confirm-deploy",
                "lab-docker",
                environment={"PATH": f"{temporary}:{os.environ['PATH']}"},
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Direct local deploy requires a clean Git worktree", result.stderr)

    def test_remote_sync_excludes_secrets_and_runtime_data(self) -> None:
        source = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        self.assertNotIn('tar -czf - .', source)
        self.assertNotIn('scp -r .', source)
        self.assertIn("Runtime .env, secrets, and data are never synchronized", source)
        self.assertIn("--exclude='._*'", source)
        for exclusion in ("node_modules", "dist", "coverage", ".git", "runtime", ".env"):
            self.assertIn(f"--exclude='{exclusion}'", source)
        self.assertIn("--exclude='*/secrets'", source)
        self.assertIn("--exclude='*/secrets/*'", source)
        for portal_source in ("package.json", "package-lock.json", "web", "deploy/portal"):
            self.assertIn(portal_source, source)

    def test_script_builds_live_portal_and_api_and_verifies_inventory(self) -> None:
        source = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("compose build --pull inventory-api portal", source)
        self.assertNotIn("compose pull\n", source)
        self.assertIn('verify_http "Portal health" http://127.0.0.1:3100/healthz', source)
        for route in ("/", "/deployments", "/infrastructure", "/performance", "/incidents", "/logs", "/settings"):
            self.assertIn(f'"{route}"', source)
        self.assertIn("/api/v1/inventory?environment=all", source)
        self.assertIn("/api/v1/session", source)
        self.assertIn("verify_unauthenticated_http", source)
        self.assertIn("--force-recreate gatus-internal gatus-public-path", source)
        self.assertIn("kubernetes_inventory_token", source)
        self.assertIn("/api/v1/topology?environment=all", source)
        self.assertIn("/api/v1/incidents?environment=all&status=active", source)
        self.assertIn("/api/v1/logs?environment=demo&service=cpq-demo&range=1h", source)
        self.assertIn("/tools/gatus-internal/api/v1/endpoints/statuses", source)
        self.assertIn("Authenticated browser acceptance is required", source)
        self.assertIn("validate_identity_credentials", source)
        self.assertIn("validate_portal_port", source)

    def test_deploy_prepares_bounded_persistent_incident_and_session_storage(self) -> None:
        source = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        self.assertIn('"$data_directory/incidents"', source)
        self.assertIn('chmod 0770 "$data_directory/incidents"', source)
        self.assertIn('chgrp "$(env_value MONITORING_GID)" "$data_directory/incidents"', source)
        self.assertIn("auth.sqlite", (STACK_DIR / "compose.yaml").read_text(encoding="utf-8"))
        self.assertIn("PORTAL_BUILD_REVISION", source)

    def test_remote_preflight_cleanup_exits_successfully(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            write_executable(temporary / "ssh", "#!/usr/bin/env bash\nexit 0\n")

            result = run_script(
                "preflight",
                "--host",
                "cpqserver.example",
                "--ssh-user",
                "jhaynes",
                environment={"PATH": f"{temporary}:{os.environ['PATH']}"},
            )

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_verify_retries_transient_http_startup_failures(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            password_file = temporary / "grafana_admin_password"
            password_file.write_text("valid-test-password\n", encoding="utf-8")
            token_file = temporary / "data" / "runtime-secrets" / "kubernetes_inventory_token"
            token_file.parent.mkdir(parents=True)
            token_file.write_text("test-read-only-token\n", encoding="utf-8")
            identity_environment = provision_identity_runtime(temporary)
            environment_file = temporary / ".env"
            environment_file.write_text(
                "\n".join(
                    (
                        "MONITORING_BIND_ADDRESS=127.0.0.1",
                        "MONITORING_PUBLIC_HOST=monitor.jefferyhaynes.net",
                        "MONITORING_PUBLIC_URL=https://monitor.jefferyhaynes.net",
                        "MONITORING_UID=1000",
                        "MONITORING_GID=1000",
                        f"MONITORING_DATA_DIR={temporary / 'data'}",
                        f"MONITORING_ENV_FILE={environment_file}",
                        f"GRAFANA_ADMIN_PASSWORD_FILE={password_file}",
                        *identity_environment,
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            write_executable(
                temporary / "docker",
                """#!/usr/bin/env bash
if [[ " $* " == *" ps -q "* ]]; then printf 'container-id\n'; fi
if [[ "${1:-}" == inspect && "$*" == *"State.Health"* ]]; then printf 'healthy\n';
elif [[ "${1:-}" == inspect ]]; then printf 'true\n'; fi
exit 0
""",
            )
            write_executable(
                temporary / "curl",
                """#!/usr/bin/env bash
count=0
[[ ! -f "$MONITORING_CURL_COUNT" ]] || count="$(<"$MONITORING_CURL_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$MONITORING_CURL_COUNT"
if (( count < 3 )); then exit 1; fi
if [[ " $* " == *" --write-out "* ]]; then
    if [[ " $* " == *"/api/v1/"* || " $* " == *"/tools/"* ]]; then printf '401';
    else printf '302'; fi
    exit 0
fi
if [[ " $* " == *"/tools/gatus-internal/api/v1/endpoints/statuses"* ]]; then
    printf '[{"name":"cpq-demo-ready-internal"},{"name":"portfolio-home-internal"}]'
elif [[ " $* " == *"/api/v1/inventory?environment=all"* ]]; then
    printf '{"apiVersion":1,"services":[{"id":"cpq-demo"},{"id":"portfolio"}]}'
elif [[ " $* " == *"/api/v1/topology?environment=all"* ]]; then
    printf '{"apiVersion":1,"source":{"name":"kubernetes"},"resources":[{"kind":"Node"}]}'
elif [[ " $* " == *"/api/v1/performance?environment=demo&service=cpq-demo&range=1h"* ]]; then
    printf '{"apiVersion":1,"serviceId":"cpq-demo","metrics":[{"id":"request-rate"}]}'
elif [[ " $* " == *"/api/v1/performance?environment=portfolio&service=portfolio&range=1h"* ]]; then
    printf '{"apiVersion":1,"serviceId":"portfolio","metrics":[{"id":"request-total","status":"ok"}]}'
elif [[ " $* " == *"/api/v1/incidents?environment=all&status=active"* ]]; then
    printf '{"apiVersion":1,"alertSource":{"name":"inventory-health-evaluator"},"notification":{"state":"unconfigured"}}'
elif [[ " $* " == *"/api/v1/logs?environment=demo&service=cpq-demo&range=1h"* ]]; then
    printf '{"apiVersion":1,"service":{"id":"cpq-demo"},"sources":[{"name":"kubernetes-pod-logs","availability":"available"},{"name":"kubernetes-events","availability":"available"}],"redaction":{"applied":true}}'
elif [[ " $* " == *" http://127.0.0.1:3100/assets/"* ]]; then
    printf 'Live inventory Prometheus telemetry Kubernetes inventory Logs & events Server-side redaction applied'
elif [[ " $* " == *" http://127.0.0.1:3100/"* && " $* " != *"/healthz"* ]]; then
    printf '<title>Workspace Monitor</title><script src="/assets/index-test.js"></script>'
fi
""",
            )

            result = run_script(
                "verify",
                "--env-file",
                str(environment_file),
                environment={
                    "PATH": f"{temporary}:{os.environ['PATH']}",
                    "MONITORING_CURL_COUNT": str(temporary / "curl-count"),
                    "MONITORING_VERIFY_RETRY_SECONDS": "0",
                },
            )

            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
