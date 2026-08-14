from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from lab_observability.catalog import Catalog, CatalogValidationError, WorkloadKind  # noqa: E402


class CatalogContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog_path = ROOT / "catalog" / "services.json"

    def test_repository_catalog_is_valid_and_has_expected_services(self) -> None:
        catalog = Catalog.from_path(self.catalog_path)

        self.assertEqual(catalog.version, 1)
        self.assertEqual(
            {service.service_id for service in catalog.services},
            {"cpq-demo", "cpq-test", "oauth", "mailpit", "erpnet", "portfolio"},
        )
        self.assertEqual(catalog.services[-1].environment.value, "portfolio")
        demo = next(service for service in catalog.services if service.service_id == "cpq-demo")
        self.assertEqual(len(demo.workloads), 1)
        self.assertEqual(demo.workloads[0].kind, WorkloadKind.DEPLOYMENT)
        self.assertEqual(demo.workloads[0].namespace, "default")
        self.assertEqual(demo.workloads[0].name, "application")

    def test_catalog_covers_each_probe_vantage_point(self) -> None:
        catalog = Catalog.from_path(self.catalog_path)

        internal = {probe.probe_id for probe in catalog.probes_for("internal")}
        external = {probe.probe_id for probe in catalog.probes_for("external")}

        self.assertEqual(
            internal,
            {
                "cpq-demo-ready-internal",
                "cpq-test-ready-internal",
                "erpnet-ping-internal",
                "mailpit-api-internal",
                "oauth-demo-discovery-internal",
                "oauth-test-discovery-internal",
                "portfolio-home-internal",
            },
        )
        self.assertEqual(
            external,
            {"cpq-demo-ready-external", "erpnet-ping-external", "portfolio-home-external"},
        )

    def test_duplicate_probe_ids_are_rejected(self) -> None:
        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["services"][1]["probes"][0]["id"] = raw["services"][0]["probes"][0]["id"]

        with self.assertRaisesRegex(CatalogValidationError, "duplicate probe id"):
            Catalog.from_dict(raw)

    def test_probe_urls_cannot_embed_credentials_or_secrets(self) -> None:
        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["services"][0]["probes"][0]["url"] = "https://admin:secret@example.test/health"

        with self.assertRaisesRegex(CatalogValidationError, "credentials"):
            Catalog.from_dict(raw)

    def test_unknown_vantage_point_is_rejected(self) -> None:
        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["services"][0]["probes"][0]["vantagePoints"] = ["satellite"]

        with self.assertRaisesRegex(CatalogValidationError, "vantage point"):
            Catalog.from_dict(raw)

    def test_timeout_cannot_equal_or_exceed_interval(self) -> None:
        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["services"][0]["probes"][0]["timeoutSeconds"] = 30

        with self.assertRaisesRegex(CatalogValidationError, "less than intervalSeconds"):
            Catalog.from_dict(raw)

    def test_certificate_threshold_requires_https(self) -> None:
        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["services"][0]["probes"][0]["certificateMinimumHours"] = 168

        with self.assertRaisesRegex(CatalogValidationError, "requires an HTTPS URL"):
            Catalog.from_dict(raw)

    def test_secret_query_keys_are_rejected(self) -> None:
        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["services"][0]["probes"][0]["url"] = "https://example.test/health?token=secret"

        with self.assertRaisesRegex(CatalogValidationError, "secret query keys"):
            Catalog.from_dict(raw)

    def test_unknown_fields_are_rejected(self) -> None:
        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["services"][0]["probes"][0]["silentFallback"] = True

        with self.assertRaisesRegex(CatalogValidationError, "unknown fields"):
            Catalog.from_dict(raw)

    def test_unknown_workload_kind_is_rejected(self) -> None:
        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["services"][0]["workloads"][0]["kind"] = "StatefulSet"

        with self.assertRaisesRegex(CatalogValidationError, "workload.*kind|unsupported value"):
            Catalog.from_dict(raw)

    def test_missing_and_invalid_catalog_files_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            with self.assertRaisesRegex(CatalogValidationError, "does not exist"):
                Catalog.from_path(temporary / "missing.json")

            invalid_catalog = temporary / "invalid.json"
            invalid_catalog.write_text("{not-json", encoding="utf-8")
            with self.assertRaisesRegex(CatalogValidationError, "not valid JSON"):
                Catalog.from_path(invalid_catalog)

    def test_unsupported_version_and_empty_services_are_rejected(self) -> None:
        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["catalogVersion"] = 2
        with self.assertRaisesRegex(CatalogValidationError, "unsupported catalogVersion"):
            Catalog.from_dict(raw)

        raw["catalogVersion"] = 1
        raw["services"] = []
        with self.assertRaisesRegex(CatalogValidationError, "at least one service"):
            Catalog.from_dict(raw)

    def test_empty_probe_and_vantage_lists_are_rejected(self) -> None:
        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["services"][0]["probes"] = []
        with self.assertRaisesRegex(CatalogValidationError, "at least one probe"):
            Catalog.from_dict(raw)

        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["services"][0]["probes"][0]["vantagePoints"] = []
        with self.assertRaisesRegex(CatalogValidationError, "cannot be empty"):
            Catalog.from_dict(raw)

    def test_duplicate_vantage_and_unknown_filter_are_rejected(self) -> None:
        raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        raw["services"][0]["probes"][0]["vantagePoints"] = ["internal", "internal"]
        with self.assertRaisesRegex(CatalogValidationError, "contains duplicates"):
            Catalog.from_dict(raw)

        catalog = Catalog.from_path(self.catalog_path)
        with self.assertRaisesRegex(CatalogValidationError, "unknown vantage point"):
            catalog.probes_for("satellite")


if __name__ == "__main__":
    unittest.main()
