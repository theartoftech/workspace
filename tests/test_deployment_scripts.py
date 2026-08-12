from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
K8S_SCRIPT = ROOT / "deployment/scripts/deploy-monitoring-k8s.sh"
GATUS_SCRIPT = ROOT / "deployment/scripts/deploy-gatus.sh"


def run_script(script: Path, *arguments: str, environment: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    process_environment = os.environ.copy()
    if environment:
        process_environment.update(environment)
    return subprocess.run(
        ["bash", str(script), *arguments],
        cwd=ROOT,
        env=process_environment,
        check=False,
        capture_output=True,
        text=True,
    )


def write_mock(directory: Path, name: str) -> None:
    path = directory / name
    path.write_text(
        '#!/usr/bin/env bash\nprintf \'%s\\n\' "' + name + ' $*" >> "$MONITORING_MOCK_LOG"\n',
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


class KubernetesDeploymentScriptTests(unittest.TestCase):
    def test_help_describes_guarded_command_surface(self) -> None:
        result = run_script(K8S_SCRIPT, "help")

        self.assertEqual(result.returncode, 0, result.stderr)
        for command in ("plan", "preflight", "deploy", "status", "verify"):
            self.assertIn(command, result.stdout)

    def test_deploy_requires_exact_namespace_confirmation(self) -> None:
        result = run_script(K8S_SCRIPT, "deploy", "--namespace", "monitoring")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--confirm-deploy monitoring", result.stderr)

    def test_plan_renders_without_calling_kubectl(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            log = temporary / "commands.log"
            write_mock(temporary, "helm")
            result = run_script(
                K8S_SCRIPT,
                "plan",
                environment={
                    "PATH": f"{temporary}:{os.environ['PATH']}",
                    "MONITORING_MOCK_LOG": str(log),
                },
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            commands = log.read_text(encoding="utf-8")
            self.assertIn("helm dependency build", commands)
            self.assertIn("helm lint", commands)
            self.assertIn("helm template", commands)
            self.assertNotIn("kubectl", commands)
            self.assertNotIn("upgrade --install", commands)


class GatusDeploymentScriptTests(unittest.TestCase):
    def test_help_describes_guarded_command_surface(self) -> None:
        result = run_script(GATUS_SCRIPT, "help")

        self.assertEqual(result.returncode, 0, result.stderr)
        for command in ("plan", "preflight", "deploy", "status", "verify", "logs"):
            self.assertIn(command, result.stdout)

    def test_deploy_requires_exact_vantage_confirmation(self) -> None:
        result = run_script(GATUS_SCRIPT, "deploy", "--vantage", "internal")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--confirm-deploy internal", result.stderr)

    def test_plan_accepts_example_environment_without_deploying(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            log = temporary / "commands.log"
            write_mock(temporary, "docker")
            result = run_script(
                GATUS_SCRIPT,
                "plan",
                "--vantage",
                "external",
                "--env-file",
                str(ROOT / "probes/external/.env.example"),
                environment={
                    "PATH": f"{temporary}:{os.environ['PATH']}",
                    "MONITORING_MOCK_LOG": str(log),
                },
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            commands = log.read_text(encoding="utf-8")
            self.assertIn("docker compose", commands)
            self.assertIn("config", commands)
            self.assertNotIn(" up ", f" {commands} ")

    def test_preflight_does_not_require_notification_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            write_mock(temporary, "docker")
            result = run_script(
                GATUS_SCRIPT,
                "preflight",
                "--vantage",
                "internal",
                "--env-file",
                str(ROOT / "probes/internal/.env.example"),
                environment={
                    "PATH": f"{temporary}:{os.environ['PATH']}",
                    "MONITORING_MOCK_LOG": str(temporary / "commands.log"),
                },
            )

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_plan_supports_standalone_docker_compose(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            log = temporary / "commands.log"
            docker = temporary / "docker"
            docker.write_text(
                '#!/usr/bin/env bash\nif [[ "${1:-}" == compose ]]; then exit 1; fi\nexit 1\n',
                encoding="utf-8",
            )
            docker.chmod(docker.stat().st_mode | stat.S_IXUSR)
            write_mock(temporary, "docker-compose")
            result = run_script(
                GATUS_SCRIPT,
                "plan",
                "--vantage",
                "internal",
                "--env-file",
                str(ROOT / "probes/internal/.env.example"),
                environment={
                    "PATH": f"{temporary}:{os.environ['PATH']}",
                    "MONITORING_MOCK_LOG": str(log),
                },
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("docker-compose", log.read_text(encoding="utf-8"))


class DeploymentSourceSafetyTests(unittest.TestCase):
    def test_remote_sync_never_includes_runtime_secrets_or_data(self) -> None:
        for script in (K8S_SCRIPT, GATUS_SCRIPT):
            source = script.read_text(encoding="utf-8")
            self.assertNotIn('tar -czf - .', source)
            self.assertNotIn('scp -r .', source)
        gatus_source = GATUS_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("Only compose.yaml and config.yaml are synchronized", gatus_source)


if __name__ == "__main__":
    unittest.main()
