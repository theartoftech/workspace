from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class HelmFoundationTests(unittest.TestCase):
    def test_chart_pins_monitoring_dependencies(self) -> None:
        chart = (ROOT / "deploy/helm/lab-observability/Chart.yaml").read_text(encoding="utf-8")

        self.assertIn("version: 87.21.0", chart)
        self.assertIn("version: 11.17.2", chart)
        self.assertIn("repository: https://prometheus-community.github.io/helm-charts", chart)

    def test_prometheus_retention_and_storage_are_bounded(self) -> None:
        values = (ROOT / "deploy/helm/lab-observability/values.yaml").read_text(encoding="utf-8")

        self.assertIn("retention: 30d", values)
        self.assertIn("retentionSize: 25GB", values)
        self.assertIn("storage: 30Gi", values)
        self.assertIn("serviceMonitorSelectorNilUsesHelmValues: false", values)

    def test_cpq_service_monitor_selects_only_the_demo_service(self) -> None:
        monitor = (ROOT / "deploy/helm/lab-observability/templates/cpq-service-monitor.yaml").read_text(
            encoding="utf-8"
        )

        self.assertIn("kind: ServiceMonitor", monitor)
        self.assertIn("- default", monitor)
        self.assertIn("app: application", monitor)
        self.assertIn("runtime: spring-boot-primary", monitor)
        self.assertIn("path: /api/actuator/prometheus", monitor)
        self.assertIn("port: http", monitor)


class GatusFoundationTests(unittest.TestCase):
    def test_probe_configs_match_the_catalog_vantage_points(self) -> None:
        catalog = json.loads((ROOT / "catalog/services.json").read_text(encoding="utf-8"))
        expected: dict[str, dict[str, tuple[str, str]]] = {"internal": {}, "external": {}}
        for service in catalog["services"]:
            for probe in service["probes"]:
                for vantage_point in probe["vantagePoints"]:
                    expected[vantage_point][probe["id"]] = (probe["group"], probe["url"])

        for vantage_point in ("internal", "external"):
            config = (ROOT / f"probes/{vantage_point}/config.yaml").read_text(encoding="utf-8")
            endpoints = re.findall(
                r'^  - name: ([^\n]+)\n    group: ([^\n]+)\n    url: "([^"]+)"',
                config,
                flags=re.MULTILINE,
            )
            actual = {
                name: (group, url)
                for name, group, url in endpoints
            }
            self.assertEqual(actual, expected[vantage_point])

    def test_probe_images_are_immutable_and_process_is_hardened(self) -> None:
        for vantage_point in ("internal", "external"):
            compose = (ROOT / f"probes/{vantage_point}/compose.yaml").read_text(encoding="utf-8")
            self.assertIn("ghcr.io/twin/gatus:v5.34.0", compose)
            self.assertNotIn(":latest", compose)
            self.assertIn('user: "${GATUS_UID:-1000}:${GATUS_GID:-1000}"', compose)
            self.assertIn("read_only: true", compose)
            self.assertIn("no-new-privileges:true", compose)
            self.assertIn("cap_drop:", compose)

    def test_probe_configs_do_not_require_notification_credentials(self) -> None:
        for vantage_point in ("internal", "external"):
            config = (ROOT / f"probes/{vantage_point}/config.yaml").read_text(encoding="utf-8")
            self.assertNotIn("alerting:", config)
            self.assertNotIn("alerts:", config)
            self.assertNotRegex(config, r"(?im)^\s*(?:password|authorization):")
            self.assertNotIn("bearer ", config.lower())


if __name__ == "__main__":
    unittest.main()
