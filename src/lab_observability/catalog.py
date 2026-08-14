"""Strict, dependency-free loader for the monitored-service catalog."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Iterable, TypeVar, cast
from urllib.parse import parse_qsl, urlsplit


_IDENTIFIER = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_SENSITIVE_QUERY_KEYS = frozenset({"access_token", "api_key", "apikey", "password", "secret", "token"})
_EnumValue = TypeVar("_EnumValue", bound=StrEnum)


class CatalogValidationError(ValueError):
    """Raised when the service catalog violates its contract."""


class ServiceKind(StrEnum):
    APPLICATION = "application"
    IDENTITY = "identity"
    MAIL = "mail"
    ERP = "erp"


class Environment(StrEnum):
    DEMO = "demo"
    TEST = "test"
    PORTFOLIO = "portfolio"
    SHARED = "shared"


class Criticality(StrEnum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"


class VantagePoint(StrEnum):
    INTERNAL = "internal"
    EXTERNAL = "external"


class WorkloadKind(StrEnum):
    DEPLOYMENT = "Deployment"
    POD = "Pod"


@dataclass(frozen=True, slots=True)
class KubernetesWorkload:
    kind: WorkloadKind
    namespace: str
    name: str


@dataclass(frozen=True, slots=True)
class HttpProbe:
    probe_id: str
    display_name: str
    group: str
    url: str
    vantage_points: tuple[VantagePoint, ...]
    interval_seconds: int
    timeout_seconds: int
    expected_status: int
    body_condition: str | None
    certificate_minimum_hours: int | None


@dataclass(frozen=True, slots=True)
class MonitoredService:
    service_id: str
    display_name: str
    kind: ServiceKind
    environment: Environment
    owner: str
    criticality: Criticality
    probes: tuple[HttpProbe, ...]
    workloads: tuple[KubernetesWorkload, ...]


@dataclass(frozen=True, slots=True)
class Catalog:
    version: int
    services: tuple[MonitoredService, ...]

    @classmethod
    def from_path(cls, path: Path) -> Catalog:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise CatalogValidationError(f"catalog does not exist: {path}") from error
        except json.JSONDecodeError as error:
            raise CatalogValidationError(f"catalog is not valid JSON: {error}") from error
        return cls.from_dict(_object(raw, "catalog"))

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Catalog:
        _require_exact_keys(raw, {"catalogVersion", "services"}, "catalog")
        version = _integer(raw["catalogVersion"], "catalogVersion", minimum=1)
        if version != 1:
            raise CatalogValidationError(f"unsupported catalogVersion: {version}")

        services_raw = _list(raw["services"], "services")
        if not services_raw:
            raise CatalogValidationError("services must contain at least one service")
        services = tuple(_parse_service(item, index) for index, item in enumerate(services_raw))
        _ensure_unique((service.service_id for service in services), "service id")
        _ensure_unique(
            (probe.probe_id for service in services for probe in service.probes),
            "probe id",
        )
        return cls(version=version, services=services)

    def probes_for(self, vantage_point: VantagePoint | str) -> tuple[HttpProbe, ...]:
        try:
            requested = VantagePoint(vantage_point)
        except ValueError as error:
            raise CatalogValidationError(f"unknown vantage point: {vantage_point}") from error
        return tuple(
            probe
            for service in self.services
            for probe in service.probes
            if requested in probe.vantage_points
        )


def _parse_service(raw_value: object, index: int) -> MonitoredService:
    context = f"services[{index}]"
    raw = _object(raw_value, context)
    _require_exact_keys(
        raw,
        {"id", "displayName", "kind", "environment", "owner", "criticality", "probes", "workloads"},
        context,
    )
    probes_raw = _list(raw["probes"], f"{context}.probes")
    if not probes_raw:
        raise CatalogValidationError(f"{context}.probes must contain at least one probe")
    workloads_raw = _list(raw["workloads"], f"{context}.workloads")
    return MonitoredService(
        service_id=_identifier(raw["id"], f"{context}.id"),
        display_name=_nonempty_string(raw["displayName"], f"{context}.displayName"),
        kind=_enum(ServiceKind, raw["kind"], f"{context}.kind"),
        environment=_enum(Environment, raw["environment"], f"{context}.environment"),
        owner=_nonempty_string(raw["owner"], f"{context}.owner"),
        criticality=_enum(Criticality, raw["criticality"], f"{context}.criticality"),
        probes=tuple(_parse_probe(item, context, probe_index) for probe_index, item in enumerate(probes_raw)),
        workloads=tuple(
            _parse_workload(item, context, workload_index)
            for workload_index, item in enumerate(workloads_raw)
        ),
    )


def _parse_workload(raw_value: object, service_context: str, index: int) -> KubernetesWorkload:
    context = f"{service_context}.workloads[{index}]"
    raw = _object(raw_value, context)
    _require_exact_keys(raw, {"kind", "namespace", "name"}, context)
    return KubernetesWorkload(
        kind=_enum(WorkloadKind, raw["kind"], f"{context}.kind"),
        namespace=_identifier(raw["namespace"], f"{context}.namespace"),
        name=_identifier(raw["name"], f"{context}.name"),
    )


def _parse_probe(raw_value: object, service_context: str, index: int) -> HttpProbe:
    context = f"{service_context}.probes[{index}]"
    raw = _object(raw_value, context)
    required = {
        "id",
        "displayName",
        "group",
        "url",
        "vantagePoints",
        "intervalSeconds",
        "timeoutSeconds",
        "expectedStatus",
    }
    optional = {"bodyCondition", "certificateMinimumHours"}
    _require_exact_keys(raw, required, context, optional)

    url = _url(raw["url"], f"{context}.url")
    vantage_values = _list(raw["vantagePoints"], f"{context}.vantagePoints")
    if not vantage_values:
        raise CatalogValidationError(f"{context}.vantagePoints cannot be empty")
    try:
        vantage_points = tuple(VantagePoint(_nonempty_string(value, f"{context}.vantagePoints")) for value in vantage_values)
    except ValueError as error:
        raise CatalogValidationError(f"{context} contains an unknown vantage point: {error}") from error
    if len(set(vantage_points)) != len(vantage_points):
        raise CatalogValidationError(f"{context}.vantagePoints contains duplicates")

    timeout_seconds = _integer(raw["timeoutSeconds"], f"{context}.timeoutSeconds", minimum=1)
    interval_seconds = _integer(raw["intervalSeconds"], f"{context}.intervalSeconds", minimum=1)
    if timeout_seconds >= interval_seconds:
        raise CatalogValidationError(f"{context}.timeoutSeconds must be less than intervalSeconds")

    certificate_hours_raw = raw.get("certificateMinimumHours")
    certificate_hours = (
        _integer(certificate_hours_raw, f"{context}.certificateMinimumHours", minimum=1)
        if certificate_hours_raw is not None
        else None
    )
    if certificate_hours is not None and not url.startswith("https://"):
        raise CatalogValidationError(f"{context}.certificateMinimumHours requires an HTTPS URL")

    body_condition_raw = raw.get("bodyCondition")
    body_condition = (
        _nonempty_string(body_condition_raw, f"{context}.bodyCondition")
        if body_condition_raw is not None
        else None
    )
    return HttpProbe(
        probe_id=_identifier(raw["id"], f"{context}.id"),
        display_name=_nonempty_string(raw["displayName"], f"{context}.displayName"),
        group=_identifier(raw["group"], f"{context}.group"),
        url=url,
        vantage_points=vantage_points,
        interval_seconds=interval_seconds,
        timeout_seconds=timeout_seconds,
        expected_status=_integer(raw["expectedStatus"], f"{context}.expectedStatus", minimum=100, maximum=599),
        body_condition=body_condition,
        certificate_minimum_hours=certificate_hours,
    )


def _url(value: object, context: str) -> str:
    url = _nonempty_string(value, context)
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise CatalogValidationError(f"{context} must be an absolute HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise CatalogValidationError(f"{context} must not embed credentials")
    if parsed.fragment:
        raise CatalogValidationError(f"{context} must not contain a fragment")
    query_keys = {key.casefold() for key, _ in parse_qsl(parsed.query, keep_blank_values=True)}
    sensitive_keys = sorted(query_keys & _SENSITIVE_QUERY_KEYS)
    if sensitive_keys:
        raise CatalogValidationError(f"{context} must not contain secret query keys: {sensitive_keys}")
    return url


def _enum(enum_type: type[_EnumValue], value: object, context: str) -> _EnumValue:
    text = _nonempty_string(value, context)
    try:
        return enum_type(text)
    except ValueError as error:
        raise CatalogValidationError(f"{context} has unsupported value: {text}") from error


def _identifier(value: object, context: str) -> str:
    identifier = _nonempty_string(value, context)
    if not _IDENTIFIER.fullmatch(identifier):
        raise CatalogValidationError(f"{context} must be a lowercase kebab-case identifier")
    return identifier


def _nonempty_string(value: object, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CatalogValidationError(f"{context} must be a non-empty string")
    return value.strip()


def _integer(value: object, context: str, minimum: int, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise CatalogValidationError(f"{context} must be an integer")
    if value < minimum or (maximum is not None and value > maximum):
        range_text = f"{minimum}..{maximum}" if maximum is not None else f">= {minimum}"
        raise CatalogValidationError(f"{context} must be {range_text}")
    return value


def _object(value: object, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CatalogValidationError(f"{context} must be an object")
    raw_object = cast(dict[object, object], value)
    if not all(isinstance(key, str) for key in raw_object):
        raise CatalogValidationError(f"{context} must use string keys")
    return cast(dict[str, Any], raw_object)


def _list(value: object, context: str) -> list[object]:
    if not isinstance(value, list):
        raise CatalogValidationError(f"{context} must be an array")
    return cast(list[object], value)


def _require_exact_keys(
    raw: dict[str, Any],
    required: set[str],
    context: str,
    optional: set[str] | None = None,
) -> None:
    allowed = required | (optional or set())
    missing = sorted(required - raw.keys())
    unknown = sorted(raw.keys() - allowed)
    if missing:
        raise CatalogValidationError(f"{context} is missing required fields: {missing}")
    if unknown:
        raise CatalogValidationError(f"{context} contains unknown fields: {unknown}")


def _ensure_unique(values: Iterable[str], label: str) -> None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise CatalogValidationError(f"duplicate {label}: {value}")
        seen.add(value)
