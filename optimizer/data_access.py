"""
GridShift Component 3 — database access.

The only module in `optimizer/` that talks to PostgreSQL. It reads:

    model_forecasts      -> predicted demand (Component 2 output)
    tariff_rates         -> energy prices + demand charge (flat or TOU)
    energy_readings      -> month-to-date billed peak
    battery_assets       -> battery spec + current SOC        (new, devices.sql)
    ev_charging_sessions -> EV charging requirements          (new, devices.sql)
    hvac_flexibility     -> HVAC flexibility envelope         (new, devices.sql)

The last three tables are NOT in the branch's `data/scripts/db/schema.sql`.
Apply `optimizer/db/devices.sql`, then seed them with
`python -m optimizer.seed_devices`.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError

from data.scripts.db.connection import get_engine
from optimizer.schemas import (
    FLAT,
    BatterySpec,
    EVSpec,
    HVACSpec,
    OptimizationInput,
    OptimizationOptions,
    TariffSchedule,
)

DEVICE_TABLES = ("battery_assets", "ev_charging_sessions", "hvac_flexibility")
MISSING_TABLES_HINT = (
    "Device tables are missing. The data branch's schema.sql has no battery/EV/HVAC "
    "tables. Apply optimizer/db/devices.sql, then run "
    "`python -m optimizer.seed_devices --building-id <uuid>`."
)


def _query(engine, sql: str, **params) -> pd.DataFrame:
    try:
        with engine.connect() as connection:
            return pd.read_sql(text(sql), connection, params=params)
    except ProgrammingError as error:  # undefined table / column
        if any(table in str(error) for table in DEVICE_TABLES):
            raise RuntimeError(MISSING_TABLES_HINT) from error
        raise


def load_building(engine, building_id: str) -> dict:
    frame = _query(
        engine,
        "SELECT building_id, name, timezone, utility, rate_class FROM public.buildings WHERE building_id = :id",
        id=building_id,
    )
    if frame.empty:
        raise ValueError(f"Unknown building_id {building_id}")
    return frame.iloc[0].to_dict()


def load_forecast(engine, building_id: str, hours: int = 24, generated_at: datetime | None = None):
    """Latest Component 2 forecast run for this building."""
    frame = _query(
        engine,
        """
        SELECT forecast_timestamp, predicted_load_kw, peak_threshold_kw, model_name, model_version
        FROM public.model_forecasts
        WHERE building_id = :id
          AND generated_at = COALESCE(
              :generated_at,
              (SELECT max(generated_at) FROM public.model_forecasts WHERE building_id = :id))
        ORDER BY forecast_timestamp
        """,
        id=building_id,
        generated_at=generated_at,
    )
    if frame.empty:
        raise ValueError("No model_forecasts rows for this building; run the ML pipeline first")

    timestamps = pd.DatetimeIndex(pd.to_datetime(frame.forecast_timestamp, utc=True))
    if len(frame) < hours:
        raise ValueError(
            f"Requested a {hours}-hour horizon but the latest forecast run only covers "
            f"{len(frame)} hours. Component 2 currently issues 24 hours; a week or month "
            "needs either a longer ML horizon or chained daily runs."
        )
    frame = frame.head(hours)
    timestamps = timestamps[:hours]
    steps = timestamps.to_series().diff().dropna()
    if not (steps == pd.Timedelta(hours=1)).all():
        raise ValueError("Forecast timestamps are not regular hourly steps")
    return timestamps, frame.predicted_load_kw.to_numpy(dtype=float), frame.iloc[0].to_dict()


def load_tariff(engine, building_id: str, timestamps: pd.DatetimeIndex, timezone: str,
                prefer: str = "auto") -> TariffSchedule:
    """Build an hourly price vector from tariff_rates.

    prefer='auto' uses time-of-use rows when the building has them and falls
    back to the flat row otherwise. prefer='flat'/'tou' forces one.

    Known limitation: tariff_rates carries start_hour/end_hour but no day-of-week
    column, so a Mon-Sat peak window cannot be expressed. TOU rows are applied by
    local hour on every day.
    """
    frame = _query(
        engine,
        """
        SELECT rate_name, period_type, energy_rate_per_kwh, demand_rate_per_kw,
               start_hour, end_hour, currency, effective_from, effective_to
        FROM public.tariff_rates
        WHERE building_id = :id
        ORDER BY period_type, start_hour
        """,
        id=building_id,
    )
    if frame.empty:
        raise ValueError("No tariff_rates rows for this building")

    target_day = timestamps[0].tz_convert(timezone).date()
    frame["effective_from"] = pd.to_datetime(frame.effective_from).dt.date
    effective_to = pd.to_datetime(frame.effective_to).dt.date
    covers_day = (frame.effective_from <= target_day) & (effective_to.isna() | (effective_to >= target_day))
    dated = frame[covers_day]
    if not dated.empty:
        frame = dated
    # Else: nothing covers this date (e.g. a forecast replayed against 2018
    # history against a 2026-effective demo tariff) — fall back to whatever
    # tariff_rates has on file rather than failing. This matches how the data
    # branch documents its own tariff row: a demo-scenario price, not a
    # reconstruction of the actual bill for that historical date.

    frame["energy_rate_per_kwh"] = frame.energy_rate_per_kwh.astype(float)
    frame["demand_rate_per_kw"] = frame.demand_rate_per_kw.astype(float)
    flat_rows = frame[frame.period_type == FLAT]
    tou_rows = frame[frame.period_type != FLAT]

    use_tou = (prefer == "tou") or (prefer == "auto" and not tou_rows.empty)
    if use_tou and tou_rows.empty:
        raise ValueError("Time-of-use pricing requested but no non-flat tariff_rates rows exist")
    if not use_tou and flat_rows.empty:
        raise ValueError("Flat pricing requested but no flat tariff_rates row exists")

    local_hours = timestamps.tz_convert(timezone).hour
    demand_rate = float(np.nanmax(frame.demand_rate_per_kw.to_numpy())) if frame.demand_rate_per_kw.notna().any() else 0.0

    if not use_tou:
        row = flat_rows.iloc[0]
        return TariffSchedule.flat(
            len(timestamps), row.energy_rate_per_kwh, demand_rate,
            currency=row.currency, rate_name=row.rate_name,
        )

    rates = np.full(len(timestamps), np.nan)
    labels = [""] * len(timestamps)
    for _, row in tou_rows.iterrows():
        mask = (local_hours >= row.start_hour) & (local_hours < row.end_hour)
        rates[mask] = row.energy_rate_per_kwh
        for index in np.flatnonzero(mask):
            labels[index] = row.period_type
    if np.isnan(rates).any():
        if flat_rows.empty:
            raise ValueError("Time-of-use rows leave hours unpriced and no flat fallback exists")
        fill = flat_rows.iloc[0]
        gaps = np.isnan(rates)
        rates[gaps] = fill.energy_rate_per_kwh
        for index in np.flatnonzero(gaps):
            labels[index] = FLAT
    return TariffSchedule(
        energy_rate_per_kwh=rates,
        demand_rate_per_kw=demand_rate,
        period_labels=labels,
        currency=str(tou_rows.iloc[0].currency),
        rate_name=str(tou_rows.iloc[0].rate_name),
        is_time_of_use=True,
    )


def load_battery(engine, building_id: str) -> BatterySpec | None:
    frame = _query(
        engine,
        """
        SELECT asset_id::text, name, capacity_kwh, max_charge_kw, max_discharge_kw,
               charge_efficiency, discharge_efficiency, min_soc_pct, max_soc_pct,
               current_soc_pct, target_final_soc_pct
        FROM public.battery_assets
        WHERE building_id = :id AND is_active
        ORDER BY updated_at DESC LIMIT 1
        """,
        id=building_id,
    )
    if frame.empty:
        return None
    row = frame.iloc[0]
    return BatterySpec(
        asset_id=row.asset_id, name=row["name"], capacity_kwh=float(row.capacity_kwh),
        max_charge_kw=float(row.max_charge_kw), max_discharge_kw=float(row.max_discharge_kw),
        charge_efficiency=float(row.charge_efficiency), discharge_efficiency=float(row.discharge_efficiency),
        min_soc_pct=float(row.min_soc_pct), max_soc_pct=float(row.max_soc_pct),
        initial_soc_pct=float(row.current_soc_pct), final_soc_pct=float(row.target_final_soc_pct),
    )


def load_ev_sessions(engine, building_id: str, timestamps: pd.DatetimeIndex) -> list[EVSpec]:
    frame = _query(
        engine,
        """
        SELECT session_id::text, vehicle_name, max_charge_kw, energy_required_kwh,
               available_from, available_until, charge_efficiency, priority
        FROM public.ev_charging_sessions
        WHERE building_id = :id
          AND available_until > :start AND available_from < :end
        ORDER BY available_from
        """,
        id=building_id,
        start=timestamps[0].to_pydatetime(),
        end=(timestamps[-1] + pd.Timedelta(hours=1)).to_pydatetime(),
    )
    return [
        EVSpec(
            asset_id=row.session_id, name=row.vehicle_name, max_charge_kw=float(row.max_charge_kw),
            energy_required_kwh=float(row.energy_required_kwh),
            available_from=pd.to_datetime(row.available_from, utc=True),
            available_until=pd.to_datetime(row.available_until, utc=True),
            charge_efficiency=float(row.charge_efficiency), priority=float(row.priority),
        )
        for _, row in frame.iterrows()
    ]


def load_hvac(engine, building_id: str) -> HVACSpec | None:
    frame = _query(
        engine,
        """
        SELECT asset_id::text, name, max_curtail_fraction, max_curtail_kw,
               max_consecutive_hours, recovery_fraction, daily_curtail_limit_kwh
        FROM public.hvac_flexibility
        WHERE building_id = :id AND is_active
        ORDER BY updated_at DESC LIMIT 1
        """,
        id=building_id,
    )
    if frame.empty:
        return None
    row = frame.iloc[0]
    return HVACSpec(
        asset_id=row.asset_id, name=row["name"],
        max_curtail_fraction=float(row.max_curtail_fraction),
        max_curtail_kw=None if pd.isna(row.max_curtail_kw) else float(row.max_curtail_kw),
        max_consecutive_hours=int(row.max_consecutive_hours),
        recovery_fraction=float(row.recovery_fraction),
        daily_curtail_limit_kwh=None if pd.isna(row.daily_curtail_limit_kwh) else float(row.daily_curtail_limit_kwh),
    )


def month_to_date_peak(engine, building_id: str, as_of: pd.Timestamp, timezone: str) -> float:
    """Highest measured hourly demand in the local billing month before `as_of`."""
    local = as_of.tz_convert(timezone)
    month_start = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    frame = _query(
        engine,
        """
        SELECT COALESCE(max(load_kw), 0) AS peak
        FROM public.energy_readings
        WHERE building_id = :id AND timestamp >= :start AND timestamp < :end
          AND quality_flag IN ('valid', 'estimated')
        """,
        id=building_id,
        start=month_start.tz_convert("UTC").to_pydatetime(),
        end=as_of.tz_convert("UTC").to_pydatetime(),
    )
    return float(frame.iloc[0].peak or 0.0)


def build_request(
    building_id: str,
    hours: int = 24,
    pricing: str = "flat",
    options: OptimizationOptions | None = None,
    engine=None,
    carry_month_to_date_peak: bool = True,
) -> OptimizationInput:
    """Assemble an OptimizationInput straight from the teammate's database."""
    owned = engine is None
    engine = engine or get_engine()
    try:
        building = load_building(engine, building_id)
        timezone = building.get("timezone") or "America/Los_Angeles"
        timestamps, forecast, meta = load_forecast(engine, building_id, hours)
        tariff = load_tariff(engine, building_id, timestamps, timezone, prefer=pricing)
        peak = month_to_date_peak(engine, building_id, timestamps[0], timezone) if carry_month_to_date_peak else 0.0
        request = OptimizationInput(
            building_id=str(building_id),
            timestamps=timestamps,
            forecast_load_kw=forecast,
            tariff=tariff,
            battery=load_battery(engine, building_id),
            evs=load_ev_sessions(engine, building_id, timestamps),
            hvac=load_hvac(engine, building_id),
            month_to_date_peak_kw=peak,
            timezone=timezone,
            options=options or OptimizationOptions(),
        )
        request.forecast_meta = meta  # type: ignore[attr-defined]
        return request
    finally:
        if owned:
            engine.dispose()


def write_plan(engine, building_id: str, result, generated_at: datetime | None = None) -> int:
    """Persist the recommended schedule for the agent / frontend to read."""
    generated_at = generated_at or datetime.now().astimezone()
    rows = result.schedule.to_dict("records")
    with engine.begin() as connection:
        for row in rows:
            connection.execute(
                text(
                    """
                    INSERT INTO public.optimization_plans (
                        building_id, generated_at, plan_timestamp, forecast_load_kw,
                        baseline_load_kw, optimized_load_kw, battery_charge_kw,
                        battery_discharge_kw, battery_soc_pct, ev_charge_kw,
                        hvac_curtail_kw, hvac_rebound_kw, energy_rate_per_kwh, tariff_period)
                    VALUES (:building_id, :generated_at, :plan_timestamp, :forecast_load_kw,
                        :baseline_load_kw, :optimized_load_kw, :battery_charge_kw,
                        :battery_discharge_kw, :battery_soc_pct, :ev_charge_kw,
                        :hvac_curtail_kw, :hvac_rebound_kw, :energy_rate_per_kwh, :tariff_period)
                    ON CONFLICT (building_id, generated_at, plan_timestamp) DO UPDATE SET
                        optimized_load_kw = EXCLUDED.optimized_load_kw
                    """
                ),
                {
                    "building_id": building_id,
                    "generated_at": generated_at,
                    "plan_timestamp": row["timestamp"],
                    "forecast_load_kw": row["forecast_load_kw"],
                    "baseline_load_kw": row["baseline_load_kw"],
                    "optimized_load_kw": row["optimized_load_kw"],
                    "battery_charge_kw": row["battery_charge_kw"],
                    "battery_discharge_kw": row["battery_discharge_kw"],
                    "battery_soc_pct": row["battery_soc_pct"],
                    "ev_charge_kw": row["ev_charge_kw"],
                    "hvac_curtail_kw": row["hvac_curtail_kw"],
                    "hvac_rebound_kw": row["hvac_rebound_kw"],
                    "energy_rate_per_kwh": row["energy_rate_per_kwh"],
                    "tariff_period": row["tariff_period"],
                },
            )
    return len(rows)


_ = timedelta  # re-exported convenience for callers building windows
