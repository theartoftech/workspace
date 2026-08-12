#!/usr/bin/env python3
"""Validate the checked-in monitoring catalog without third-party packages."""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from lab_observability.catalog import Catalog, CatalogValidationError, VantagePoint  # noqa: E402


def main() -> int:
    try:
        catalog = Catalog.from_path(ROOT / "catalog" / "services.json")
    except CatalogValidationError as error:
        print(f"catalog validation failed: {error}", file=sys.stderr)
        return 1

    counts = {
        vantage_point.value: len(catalog.probes_for(vantage_point))
        for vantage_point in VantagePoint
    }
    print(
        f"catalog v{catalog.version}: {len(catalog.services)} services, "
        f"{counts['internal']} internal probes, {counts['external']} external probes"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
