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


class InventoryReaderRbacTests(unittest.TestCase):
    def test_inventory_reader_is_read_only_and_bound_only_to_catalog_namespaces(self) -> None:
        manifest = (ROOT / "deploy/kubernetes/inventory-reader-rbac.yaml").read_text(encoding="utf-8")

        self.assertIn("name: workspace-monitor-inventory", manifest)
        self.assertIn('verbs: ["get", "list"]', manifest)
        self.assertNotRegex(manifest, r'(?m)verbs:.*(?:create|update|patch|delete|watch)')
        self.assertIn('resourceNames: ["default", "cpq-test", "public-site"]', manifest)
        for resource in ("statefulsets", "services", "persistentvolumeclaims", "events", "ingresses", "nodes", "namespaces"):
            self.assertIn(resource, manifest)
        self.assertIn('resources: ["pods/log"]', manifest)
        self.assertRegex(manifest, r'resources: \["pods/log"\]\s+verbs: \["get"\]')
        self.assertEqual(manifest.count("kind: RoleBinding"), 3)
        self.assertIn("namespace: default", manifest)
        self.assertIn("namespace: cpq-test", manifest)
        self.assertIn("namespace: public-site", manifest)


class PostgreSqlObservabilityTests(unittest.TestCase):
    def test_exporters_are_private_hardened_and_namespace_local(self) -> None:
        manifest = (ROOT / "deploy/kubernetes/postgresql-exporters.yaml").read_text(encoding="utf-8")

        self.assertEqual(manifest.count("kind: Deployment"), 2)
        self.assertEqual(manifest.count("kind: Service\n"), 2)
        self.assertEqual(manifest.count("kind: ConfigMap"), 2)
        self.assertEqual(manifest.count("namespace: default"), 3)
        self.assertEqual(manifest.count("namespace: cpq-test"), 3)
        self.assertEqual(len(re.findall(r"(?m)^  name: workspace-monitor-postgresql-exporter$", manifest)), 4)
        self.assertIn(
            "ghcr.io/prometheus-community/postgres-exporter:v0.20.1@sha256:ac5ec343104fae0e2d84a27bb8d69b38430a11910c5382cad85d478d2bab713e",
            manifest,
        )
        self.assertEqual(manifest.count("automountServiceAccountToken: false"), 2)
        self.assertEqual(manifest.count("runAsNonRoot: true"), 2)
        self.assertEqual(manifest.count("readOnlyRootFilesystem: true"), 2)
        self.assertEqual(manifest.count("allowPrivilegeEscalation: false"), 2)
        self.assertEqual(manifest.count("type: ClusterIP"), 2)
        self.assertNotRegex(manifest, r"(?m)^\s*(?:hostPort|nodePort):")

    def test_exporters_use_only_file_credentials_and_bounded_collectors(self) -> None:
        manifest = (ROOT / "deploy/kubernetes/postgresql-exporters.yaml").read_text(encoding="utf-8")

        for variable in ("DATA_SOURCE_URI_FILE", "DATA_SOURCE_USER_FILE", "DATA_SOURCE_PASS_FILE"):
            self.assertEqual(manifest.count(f"name: {variable}"), 2)
        self.assertNotRegex(manifest, r"(?m)^\s*- name: DATA_SOURCE_(?:NAME|URI|USER|PASS)$")
        self.assertNotRegex(manifest, r"(?i)(?:password|postgresql://)[^\n]*(?:value:|@)")
        self.assertEqual(manifest.count("secretName: workspace-monitor-postgresql-exporter"), 2)
        self.assertEqual(manifest.count("PG_EXPORTER_COLLECTION_TIMEOUT"), 2)
        self.assertEqual(manifest.count("--config.file="), 2)
        self.assertEqual(manifest.count("--log.level=error"), 2)
        self.assertEqual(manifest.count("--extend.query-path=/etc/postgres-exporter/queries.yaml"), 2)
        self.assertEqual(manifest.count("SELECT COUNT(*)::float AS count"), 2)
        self.assertNotRegex(manifest, r"(?i)SELECT\s+(?:query|usename|application_name)")
        for flag in (
            "--collector.long_running_transactions",
            "--no-collector.stat_statements",
            "--no-collector.stat_activity",
            "--no-collector.stat_user_tables",
            "--no-collector.statio_user_tables",
            "--no-collector.replication",
            "--no-collector.replication_slots",
        ):
            self.assertEqual(len(re.findall(rf"(?m)^\s+- {re.escape(flag)}$", manifest)), 2)

    def test_prometheus_ingests_only_bounded_postgresql_metrics(self) -> None:
        prometheus = (ROOT / "deploy/compose/lab-observability/config/prometheus.yaml").read_text(encoding="utf-8")
        rules = (ROOT / "deploy/compose/lab-observability/config/postgresql-rules.yaml").read_text(encoding="utf-8")
        rule_tests = (ROOT / "tests/prometheus/postgresql-rules.test.yaml").read_text(encoding="utf-8")

        self.assertEqual(prometheus.count("job_name: postgresql"), 1)
        self.assertIn("workspace-monitor-postgresql-exporter.default.svc.cluster.local:9187", prometheus)
        self.assertIn("workspace-monitor-postgresql-exporter.cpq-test.svc.cluster.local:9187", prometheus)
        self.assertIn("service: cpq-demo", prometheus)
        self.assertIn("service: cpq-test", prometheus)
        self.assertIn("action: keep", prometheus)
        self.assertIn("pg_up|pg_exporter_last_scrape_error", prometheus)
        self.assertIn("action: labeldrop", prometheus)
        for sensitive_label in ("datname", "usename", "application_name", "wait_event"):
            self.assertIn(sensitive_label, prometheus)
        self.assertNotIn("pg_stat_statements", prometheus)
        for alert in (
            "WorkspacePostgresqlExporterUnavailable",
            "WorkspacePostgresqlDatabaseUnavailable",
            "WorkspacePostgresqlConnectionSaturation",
            "WorkspacePostgresqlLockWaits",
            "WorkspacePostgresqlDeadlock",
            "WorkspacePostgresqlLongTransaction",
        ):
            self.assertIn(f"alert: {alert}", rules)
            self.assertIn(f"alertname: {alert}", rule_tests)


if __name__ == "__main__":
    unittest.main()
