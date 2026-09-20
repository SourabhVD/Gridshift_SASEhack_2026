"""
The forecast service.

GRIDSHIFT_FORECAST=fixtures (the default) publishes the ported demo curves.
GRIDSHIFT_FORECAST=ml calls the teammate's `ml` package: it loads the trained
bundle, runs `forecast_next_24_hours`, and maps the 24 predictions into
`predicted_load_kw`.

The ml path only replaces the *grid* curve. A regression on total load says
nothing about how that load splits between the base, the EV bays, the chillers
and the array -- so the flows are synthesised with the same helper the fixtures
use: the authored component shapes are held and `base_kw` is re-solved through

    base_kw = grid_kw - ev_kw - hvac_kw + solar_kw + battery_kw

which keeps the identity exact at every hour. When the ml package, the model
artifact or the history CSV is missing, the service logs a warning and falls
back to fixtures rather than failing the request: a dashboard that cannot draw
a forecast is worse than one drawing the demo's.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from ..config import get_settings
from ..fixtures import BuildingFixture, assert_flows_identity, get_fixture
from ..fixtures.generator import (
    HOURS,
    NOW_HOUR,
    NOW_ISO,
    PRICE_PER_KWH,
    FlowComponents,
    base_from_grid,
    iso_hour,
    round1,
    to_flows,
)

log = logging.getLogger("gridshift.forecast")

#: Set once the ml import has been tried, so a broken install warns once.
_ML_WARNED = False


class UnknownBuilding(Exception):
    """Raised for a building_id no fixture knows. Surfaces as HTTP 422."""


def require_fixture(building_id: str) -> BuildingFixture:
    fixture = get_fixture(building_id)
    if fixture is None:
        raise UnknownBuilding(f'Unknown building "{building_id}".')
    return fixture


# --------------------------------------------------------------------------- #
# Flow synthesis                                                               #
# --------------------------------------------------------------------------- #


def flows_for_grid(fixture: BuildingFixture, grid_kw: list[float]) -> FlowComponents:
    """
    Hold the authored component shapes and re-solve base_kw for a new grid
    curve. This is the one helper both the fixture path and the ml path use,
    so `flows.grid_kw == predicted_load_kw` can never drift.
    """
    parts = fixture.baseline_parts
    return FlowComponents(
        base=base_from_grid(
            grid_kw, ev=parts.ev, hvac=parts.hvac, solar=parts.solar, battery=parts.battery
        ),
        ev=list(parts.ev),
        hvac=list(parts.hvac),
        solar=list(parts.solar),
        battery=list(parts.battery),
        soc=list(parts.soc),
    )


# --------------------------------------------------------------------------- #
# The ml path                                                                  #
# --------------------------------------------------------------------------- #


def _predict_with_ml(fixture: BuildingFixture) -> list[float] | None:
    """
    24 predictions from the teammate's model, or None if anything is missing.

    The ml package imports its own subpackages by bare name (`from
    features.engineering import ...`), so `ml/` itself goes on sys.path rather
    than being imported as `ml.*`.
    """
    global _ML_WARNED
    settings = get_settings()

    try:
        ml_root = str(settings.ml_package_path)
        if ml_root not in sys.path:
            sys.path.insert(0, ml_root)

        import pandas as pd  # noqa: PLC0415 - optional dependency
        from features.engineering import load_standard_frame  # noqa: PLC0415
        from models.inference import forecast_next_24_hours  # noqa: PLC0415
        from models.load_forecaster import load_model  # noqa: PLC0415

        if not settings.ml_model_path.exists():
            raise FileNotFoundError(
                f"no trained bundle at {settings.ml_model_path}; run ml/run_pipeline.py"
            )

        history_csv = settings.ml_package_path / "data" / "prototype_commercial_building.csv"
        if not history_csv.exists():
            raise FileNotFoundError(f"no history CSV at {history_csv}")

        frame = load_standard_frame(history_csv)
        history = frame.iloc[:-HOURS]
        future_weather = frame.iloc[-HOURS:][
            ["timestamp", "temperature_c", "humidity_pct", "wind_speed_mps"]
        ]
        bundle = load_model(settings.ml_model_path)
        predicted = forecast_next_24_hours(bundle, history, future_weather)
        values = [float(v) for v in predicted["predicted_load_kw"].tolist()]
        if len(values) != HOURS:
            raise ValueError(f"model returned {len(values)} hours, expected {HOURS}")

        # The prototype model is trained on one synthetic commercial building,
        # so its absolute level means nothing for a hospital or a house. Scale
        # the shape onto this site's own baseline peak until each site has its
        # own model. Remove this when the model is per-building.
        scale = max(fixture.baseline_grid) / max(max(values), 1e-6)
        log.info(
            "ml forecast for %s: %d hours, scaled by %.3f onto the site baseline",
            fixture.id,
            len(values),
            scale,
        )
        return [round1(v * scale) for v in values]

    except Exception as exc:  # noqa: BLE001 - any failure falls back to fixtures
        if not _ML_WARNED:
            _ML_WARNED = True
            log.warning(
                "GRIDSHIFT_FORECAST=ml but the ml forecaster is unavailable (%s); "
                "falling back to fixture curves",
                exc,
            )
        return None


# --------------------------------------------------------------------------- #
# Public surface                                                               #
# --------------------------------------------------------------------------- #


def predicted_load_kw(fixture: BuildingFixture) -> tuple[list[float], str]:
    """The 24-hour grid curve and the source it came from."""
    if get_settings().forecast_mode == "ml":
        values = _predict_with_ml(fixture)
        if values is not None:
            return values, "ml"
    return list(fixture.baseline_grid), "fixtures"


def build_forecast(building_id: str) -> dict[str, Any]:
    """The GET /api/forecast payload."""
    fixture = require_fixture(building_id)
    grid, source = predicted_load_kw(fixture)
    parts = fixture.baseline_parts if source == "fixtures" else flows_for_grid(fixture, grid)
    flows = to_flows(grid, parts)
    threshold = fixture.peak_threshold_kw

    payload = {
        "building_name": fixture.name,
        "generated_at": NOW_ISO,
        "peak_threshold_kw": threshold,
        "points": [
            {
                "timestamp": iso_hour(h),
                "predicted_load_kw": grid[h],
                "actual_load_kw": fixture.actual_load_kw[h],
                "price_per_kwh": PRICE_PER_KWH[h],
                "is_peak": grid[h] > threshold,
                "flows": flows[h],
            }
            for h in range(HOURS)
        ],
    }

    # Self-check. A broken identity is always a backend bug, but a dashboard
    # that draws slightly wrong flows still beats one that draws nothing, so
    # this logs rather than raises here. The test suite calls the same function
    # and lets it raise.
    try:
        assert_flows_identity(payload["points"], label=f"forecast({fixture.id})")
    except AssertionError as exc:
        log.error("%s", exc)

    return payload


def build_summary(building_id: str) -> dict[str, Any]:
    """The GET /api/dashboard/summary payload."""
    fixture = require_fixture(building_id)
    grid, _ = predicted_load_kw(fixture)
    peak_kw = max(grid)

    return {
        "building_id": fixture.id,
        "building_type": fixture.building["type"],
        "building_name": fixture.name,
        "timestamp": NOW_ISO,
        "predicted_peak_kw": round1(peak_kw),
        "predicted_peak_time": iso_hour(grid.index(peak_kw)),
        "peak_threshold_kw": fixture.peak_threshold_kw,
        "battery_capacity_kwh": fixture.building["battery_capacity_kwh"],
        "battery_max_kw": fixture.building["battery_max_kw"],
        "electricity_price_per_kwh": PRICE_PER_KWH[NOW_HOUR],
        **fixture.summary_extras,
    }
