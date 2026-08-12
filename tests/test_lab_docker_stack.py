from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STACK_DIR = ROOT / "deploy/compose/lab-observability"
DEPLOY_SCRIPT = ROOT / "deployment/scripts/deploy-lab-docker.sh"


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
        text=True,
    )


def write_executable(path: Path, source: str) -> None:
    path.write_text(source, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


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
        self.assertEqual(compose.count("mem_limit:"), 7)
        self.assertEqual(compose.count("cpus:"), 7)

    def test_operator_interfaces_bind_to_loopback_without_port_conflicts(self) -> None:
        compose = (STACK_DIR / "compose.yaml").read_text(encoding="utf-8")

        for port in ("3000:3000", "9090:9090", "9115:9115", "8085:8080", "8186:8080"):
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
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            write_executable(temporary / "docker", "#!/usr/bin/env bash\nexit 0\n")

            result = run_script(
                "preflight",
                "--env-file",
                str(environment_file),
                environment={"PATH": f"{temporary}:{os.environ['PATH']}"},
            )

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_remote_sync_excludes_secrets_and_runtime_data(self) -> None:
        source = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        self.assertNotIn('tar -czf - .', source)
        self.assertNotIn('scp -r .', source)
        self.assertIn("Runtime .env, secrets, and data are never synchronized", source)
        self.assertIn("--exclude='._*'", source)

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
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            write_executable(
                temporary / "docker",
                """#!/usr/bin/env bash
if [[ " $* " == *" ps -q "* ]]; then printf 'container-id\n'; fi
if [[ "${1:-}" == inspect ]]; then printf 'true\n'; fi
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
(( count >= 3 ))
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
