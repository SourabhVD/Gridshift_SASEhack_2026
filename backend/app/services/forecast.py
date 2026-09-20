"""
The forecast service.

GRIDSHIFT_FORECAST=fixtures (the default) publishes the ported demo curves.
GRIDSHIFT_FORECAST=ml calls the teammate's `ml` package in process: it loads
the trained bundle, runs `forecast_next_24_hours`, and maps the 24 predictions
into `predicted_load_kw`.
GRIDSHIFT_FORECAST=backtest reads what `ml/evaluate_forecast_date.py` left on
disk for one real day -- a real model's predictions against real metered load,
for the one building the database holds. Nothing in the request path touches
the database, loads a model or retrains, so no credential reaches this service.
Every other site keeps its fixture curve, because there is no data for it.

What is real in that mode, and what is not, is worth stating plainly. The shape
of the day and the gap between predicted and measured are the model's, exactly.
The absolute kW and the calendar date are the site's demo values: both series
are multiplied by one factor that maps the day's peak onto this site's own, and
they are published on the demo day. That is a presentational choice, and
`/health` reports the real kW and the factor so it is not a hidden one.

The reason is coherence. The optimizer's levers, the device facts they are
validated against and the agent's scripted narration are all authored at the
site's scale and on the demo day. Publishing raw kW put a 73 kW forecast beside
a 522 kW impact chart, on two different dates, in the same dashboard.

None of these paths replace anything but the *grid* curve. A regression on
total load says nothing about how that load splits between the base, the EV
bays, the chillers and the array -- so the flows are synthesised with the same
helper the fixtures use: the authored component shapes are held and `base_kw`
is re-solved through

    base_kw = grid_kw - ev_kw - hvac_kw + solar_kw + battery_kw

which keeps the identity exact at every hour.

When the ml package, the model artifact, the history CSV or the backtest
directory is missing, the service logs a warning and falls back to fixtures
rather than failing the request: a dashboard that cannot draw a forecast is
worse than one drawing the demo's.
"""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass
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
from . import backtest as backtest_reader

log = logging.getLogger("gridshift.forecast")

#: Set once the ml import has been tried, so a broken install warns once.
_ML_WARNED = False
#: Same, for the backtest directory.
_BACKTEST_WARNED = False


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


def onto_site_scale(fixture: BuildingFixture, values: list[float]) -> float:
    """
    The factor that maps a curve's peak onto this site's own peak.

    The real building in the database draws a fraction of what the demo office
    does, and every consumer of a curve downstream -- the optimizer's levers,
    the device facts they are checked against, the agent's scripted narration
    -- is authored at the site's scale. Publishing real kW on the forecast
    while the plan stayed at fixture scale put a 73 kW chart next to a 522 kW
    impact chart, so the curve is mapped onto the site instead. The shape and
    the predicted-to-measured relationship survive that exactly, because both
    series are multiplied by the same number.
    """
    peak = max(values) if values else 0.0
    if peak <= 0:
        return 1.0
    return max(fixture.baseline_grid) / peak


def flows_for_grid(fixture: BuildingFixture, grid_kw: list[float]) -> FlowComponents:
    """
    Hold the authored component shapes and re-solve base_kw for a new grid
    curve. This is the one helper every non-fixture path uses, so
    `flows.grid_kw == predicted_load_kw` can never drift.
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


# --------------------------------------------------------------------------- #
# The backtest path                                                            #
# --------------------------------------------------------------------------- #


def _load_backtest(fixture: BuildingFixture) -> backtest_reader.Backtest | None:
    """
    The stored backtest for this site, or None to fall back.

    The database holds one building, so only the configured slug is served from
    it. Returning None for the others is the normal case, not a failure, and is
    not warned about.
    """
    global _BACKTEST_WARNED
    settings = get_settings()

    if fixture.id != settings.backtest_building:
        return None

    try:
        result = backtest_reader.load(settings.backtest_path, settings.backtest_date)
    except backtest_reader.BacktestUnavailable as exc:
        if not _BACKTEST_WARNED:
            _BACKTEST_WARNED = True
            log.warning(
                "GRIDSHIFT_FORECAST=backtest but no usable backtest (%s); "
                "falling back to fixture curves",
                exc,
            )
        return None

    log.info(
        "backtest %s for %s: %s, peak %.1f kW predicted against %.1f kW measured",
        result.date,
        fixture.id,
        result.algorithm,
        max(result.predicted_kw),
        max(result.actual_kw),
    )
    return result


# --------------------------------------------------------------------------- #
# Public surface                                                               #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Curve:
    """
    One day's grid curve and everything derived from the same source as it.

    Summary and forecast both read this, so they can never disagree about the
    peak, the threshold or which day is on screen.
    """

    grid: list[float]
    #: 'fixtures' | 'ml' | 'backtest'.
    source: str
    threshold_kw: float
    #: Metered load, None from "now" onward.
    actual: list[float | None]
    #: Component shapes for this curve, already scaled to it.
    parts: FlowComponents
    #: ISO 8601 with offset, for the start of each local hour.
    hours: list[str]
    #: ISO 8601 with offset, for "now" on the day being served.
    now_iso: str


def _fixture_curve(fixture: BuildingFixture, grid: list[float], source: str) -> Curve:
    """A curve on the fixture's own scale and on the demo day."""
    parts = fixture.baseline_parts if source == "fixtures" else flows_for_grid(fixture, grid)
    return Curve(
        grid=grid,
        source=source,
        threshold_kw=fixture.peak_threshold_kw,
        actual=list(fixture.actual_load_kw),
        parts=parts,
        hours=[iso_hour(h) for h in range(HOURS)],
        now_iso=NOW_ISO,
    )


def current_curve(fixture: BuildingFixture) -> Curve:
    """The 24-hour curve this site is serving right now, and its provenance."""
    mode = get_settings().forecast_mode

    if mode == "backtest":
        result = _load_backtest(fixture)
        if result is not None:
            # Both series are mapped onto this site's own peak by the same
            # factor, so the model's relative error survives exactly while the
            # rest of the app -- optimizer levers, device facts, the scripted
            # narration, the plan's impact chart -- keeps working against
            # numbers it was authored for.
            scale = onto_site_scale(fixture, result.predicted_kw)
            grid = [round1(v * scale) for v in result.predicted_kw]
            # Measured load stops at "now", matching `metered_actuals` and what
            # the contract says the field means. The file knows the whole day;
            # publishing the future half would move the dashboard's time
            # cursor and claim a measurement that has not happened.
            actual: list[float | None] = [
                round1(v * scale) if h < NOW_HOUR else None
                for h, v in enumerate(result.actual_kw)
            ]
            return Curve(
                grid=grid,
                source="backtest",
                # The site's own billing threshold, not the harness's
                # 95th-percentile statistic: the curve now sits on the site's
                # scale, and the optimizer and agent both bill against this.
                threshold_kw=fixture.peak_threshold_kw,
                actual=actual,
                parts=flows_for_grid(fixture, grid),
                hours=[iso_hour(h) for h in range(HOURS)],
                now_iso=NOW_ISO,
            )

    if mode == "ml":
        values = _predict_with_ml(fixture)
        if values is not None:
            return _fixture_curve(fixture, values, "ml")

    return _fixture_curve(fixture, list(fixture.baseline_grid), "fixtures")


def baseline_for_optimizer(
    fixture: BuildingFixture,
) -> tuple[list[float], FlowComponents]:
    """
    The day the optimizer plans against: whatever the dashboard is showing.

    This has to be the same curve `build_forecast` publishes, and for a while
    it was not. The chart drew the backtested 2018-08-09 day -- peaking at
    13:00, with a deep morning trough -- while the plan was still solved
    against the authored fixture, which peaks at 15:00 and never drops below
    172 kW. Both said "522 kW", because the backtest is scaled onto the site's
    own peak, so the headline agreed and nothing looked wrong until you
    compared the two charts and found they were different days.

    `flows_for_grid` holds the authored EV, HVAC, solar and battery shapes and
    re-solves base_kw, so switching the optimizer onto this curve changes what
    the building is doing and leaves every lever, limit and device fact exactly
    where it was. In `fixtures` mode it returns the fixture, so this is a no-op
    on the default path and on every test that does not ask for a real day.
    """
    curve = current_curve(fixture)
    return list(curve.grid), curve.parts


def predicted_load_kw(fixture: BuildingFixture) -> tuple[list[float], str]:
    """The 24-hour grid curve and the source it came from."""
    curve = current_curve(fixture)
    return curve.grid, curve.source


def build_forecast(building_id: str) -> dict[str, Any]:
    """The GET /api/forecast payload."""
    fixture = require_fixture(building_id)
    curve = current_curve(fixture)
    grid = curve.grid
    flows = to_flows(grid, curve.parts)
    threshold = curve.threshold_kw

    payload = {
        "building_name": fixture.name,
        "generated_at": curve.now_iso,
        "peak_threshold_kw": threshold,
        "points": [
            {
                "timestamp": curve.hours[h],
                "predicted_load_kw": grid[h],
                "actual_load_kw": curve.actual[h],
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
    curve = current_curve(fixture)
    grid = curve.grid
    peak_kw = max(grid)

    payload = {
        "building_id": fixture.id,
        "building_type": fixture.building["type"],
        "building_name": fixture.name,
        "timestamp": curve.now_iso,
        "predicted_peak_kw": round1(peak_kw),
        "predicted_peak_time": curve.hours[grid.index(peak_kw)],
        "peak_threshold_kw": curve.threshold_kw,
        "battery_capacity_kwh": fixture.building["battery_capacity_kwh"],
        "battery_max_kw": fixture.building["battery_max_kw"],
        "electricity_price_per_kwh": PRICE_PER_KWH[NOW_HOUR],
        **fixture.summary_extras,
    }

    if curve.source != "fixtures":
        # summary_extras pins current_load_kw to the *fixture's* curve at this
        # hour. Once a model is driving the chart, that tile has to follow it
        # or the headline number contradicts the line right beside it.
        payload["current_load_kw"] = round1(grid[NOW_HOUR])

    return payload
