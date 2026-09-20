"""
The building registry.

Four Seattle sites on the same September weekday, same tariff, same "now". The
office is the default and is the original single-building demo; the hospital
and the warehouse give the flow diagram something with a different shape to
say; the residence drops two orders of magnitude to prove the contract reads
the same at household scale.

Registry order is UI order: the default first.

Identifiers
-----------
The frontend has always used slugs (`sea-office-001`), stores one in
localStorage and sends it as `building_id` on every building-scoped call. The
team's Postgres schema keys `buildings` on a UUID. Both are real, so both work
here: every fixture carries a stable `external_id` (a UUIDv5 derived from the
slug, so it is the same on every process start) and `get_fixture` resolves
either form. The response still publishes the slug as `id`, because that is
what is already in people's browsers, with the UUID alongside as `external_id`.

In production this is a `slug TEXT UNIQUE NOT NULL` column on `buildings` and
one extra WHERE clause; see README.md.
"""

from __future__ import annotations

import uuid

from .generator import (
    FLOW_TOLERANCE_KW,
    NOW_HOUR,
    NOW_ISO,
    assert_flows_identity,
    flow_residual,
)
from .hospital import FIXTURE as HOSPITAL_FIXTURE
from .hospital import HOSPITAL_ID
from .office import FIXTURE as OFFICE_FIXTURE
from .office import OFFICE_ID
from .residence import FIXTURE as RESIDENCE_FIXTURE
from .residence import RESIDENCE_ID
from .spec import BuildingFixture, DispatchPolicy, Step
from .warehouse import FIXTURE as WAREHOUSE_FIXTURE
from .warehouse import WAREHOUSE_ID

__all__ = [
    "BuildingFixture",
    "DispatchPolicy",
    "Step",
    "FIXTURES",
    "BUILDING_IDS",
    "BUILDING_UUIDS",
    "DEFAULT_BUILDING_ID",
    "FLOW_TOLERANCE_KW",
    "NOW_HOUR",
    "NOW_ISO",
    "assert_flows_identity",
    "flow_residual",
    "get_fixture",
    "is_known_building",
    "slug_for",
    "OFFICE_ID",
    "HOSPITAL_ID",
    "WAREHOUSE_ID",
    "RESIDENCE_ID",
]

FIXTURES: tuple[BuildingFixture, ...] = (
    OFFICE_FIXTURE,
    HOSPITAL_FIXTURE,
    WAREHOUSE_FIXTURE,
    RESIDENCE_FIXTURE,
)

#: Namespace for the derived UUIDs. Deterministic, so the same slug always
#: produces the same id and a restart does not invalidate anyone's bookmark.
BUILDING_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, "gridshift.energy")


def _external_id(slug: str) -> str:
    return str(uuid.uuid5(BUILDING_NAMESPACE, slug))


#: slug -> fixture, plus uuid -> the same fixture. Both forms resolve.
_BY_ID: dict[str, BuildingFixture] = {}
for _fixture in FIXTURES:
    _fixture.building.setdefault("external_id", _external_id(_fixture.id))
    _BY_ID[_fixture.id] = _fixture
    _BY_ID[str(_fixture.building["external_id"])] = _fixture

#: Slugs only, in UI order.
BUILDING_IDS: tuple[str, ...] = tuple(f.id for f in FIXTURES)
#: The matching UUIDs, same order.
BUILDING_UUIDS: tuple[str, ...] = tuple(str(f.building["external_id"]) for f in FIXTURES)

#: The building the frontend opens on when nothing is stored.
DEFAULT_BUILDING_ID = OFFICE_ID


def get_fixture(building_id: str) -> BuildingFixture | None:
    """
    Resolve a slug or a UUID to its fixture.

    Returns None for anything unknown; callers decide whether that is a 404.
    UUID matching is case-insensitive because Postgres prints them lowercase
    but a hand-typed curl may not.
    """
    if not building_id:
        return None
    fixture = _BY_ID.get(building_id)
    if fixture is not None:
        return fixture
    return _BY_ID.get(building_id.strip().lower())


def slug_for(building_id: str) -> str | None:
    """The canonical slug for either identifier form."""
    fixture = get_fixture(building_id)
    return fixture.id if fixture else None


def is_known_building(building_id: str) -> bool:
    return get_fixture(building_id) is not None
