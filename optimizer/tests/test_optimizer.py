"""Solver behaviour tests. No database required."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from optimizer.optimizer import optimize
from optimizer.schemas import (
    BatterySpec,
    EVSpec,
    HVACSpec,
    OptimizationInput,
    OptimizationOptions,
    TariffSchedule,
)

HOURS = 24
TZ = "America/Los_Angeles"


def profile() -> np.ndarray:
    """Office-shaped day: flat overnight, a broad afternoon peak."""
    hours = np.arange(HOURS)
    return 200 + 150 * np.exp(-((hours - 15) ** 2) / 18)


def timestamps() -> pd.DatetimeIndex:
    return pd.date_range("2025-06-02 07:00", periods=HOURS, freq="h", tz="UTC")


def make_request(**overrides) -> OptimizationInput:
    base = dict(
        building_id="test",
        timestamps=timestamps(),
        forecast_load_kw=profile(),
        tariff=TariffSchedule.flat(HOURS, 0.0842, 8.10),
        timezone=TZ,
        options=OptimizationOptions(time_limit_s=20),
    )
    base.update(overrides)
    return OptimizationInput(**base)


def battery(**overrides) -> BatterySpec:
    spec = dict(
        asset_id="b1", name="test battery", capacity_kwh=200, max_charge_kw=100,
        max_discharge_kw=100, initial_soc_pct=50, final_soc_pct=50,
    )
    spec.update(overrides)
    return BatterySpec(**spec)


def test_battery_shaves_peak_and_respects_soc():
    result = optimize(make_request(battery=battery()))
    assert result.status == "OPTIMAL"
    assert result.optimized_peak_kw < result.baseline_peak_kw - 20
    soc = result.schedule.battery_soc_pct
    assert soc.between(10, 100).all()
    assert soc.iloc[-1] >= 50 - 1e-6
    # never charging and discharging in the same hour
    both = (result.schedule.battery_charge_kw > 1e-6) & (result.schedule.battery_discharge_kw > 1e-6)
    assert not both.any()


def test_battery_energy_balance_holds():
    spec = battery()
    result = optimize(make_request(battery=spec))
    schedule = result.schedule
    soc = spec.kwh(spec.initial_soc_pct)
    for _, row in schedule.iterrows():
        soc += spec.charge_efficiency * row.battery_charge_kw
        soc -= row.battery_discharge_kw / spec.discharge_efficiency
        assert row.battery_soc_kwh == pytest.approx(soc, abs=0.05)  # schedule is rounded to 3 dp


def test_ev_energy_delivered_inside_window_only():
    stamps = timestamps()
    session = EVSpec(
        asset_id="ev1", name="EV 1", max_charge_kw=11, energy_required_kwh=44,
        available_from=stamps[2], available_until=stamps[12], charge_efficiency=1.0,
    )
    result = optimize(make_request(evs=[session], battery=battery()))
    draw = result.schedule.ev_charge_kw.to_numpy()
    assert draw.sum() == pytest.approx(44, abs=1e-3)
    assert draw[:2].sum() == pytest.approx(0, abs=1e-9)
    assert draw[12:].sum() == pytest.approx(0, abs=1e-9)
    assert result.violations["unmet_ev_kwh"] == pytest.approx(0, abs=1e-6)
    # shifted away from the afternoon peak hour
    assert draw[result.schedule.forecast_load_kw.idxmax()] < 11


def test_ev_shortfall_is_penalised_not_infeasible():
    stamps = timestamps()
    impossible = EVSpec(
        asset_id="ev2", name="EV 2", max_charge_kw=5, energy_required_kwh=500,
        available_from=stamps[0], available_until=stamps[4], charge_efficiency=1.0,
    )
    result = optimize(make_request(evs=[impossible]))
    assert result.status == "OPTIMAL"
    assert result.violations["unmet_ev_kwh"] > 0


def test_hvac_respects_caps_rebound_and_run_length():
    spec = HVACSpec(
        asset_id="h1", name="hvac", max_curtail_fraction=0.1,
        max_consecutive_hours=2, recovery_fraction=0.5,
    )
    result = optimize(make_request(hvac=spec))
    schedule = result.schedule
    caps = 0.1 * schedule.forecast_load_kw
    assert (schedule.hvac_curtail_kw <= caps + 1e-6).all()
    assert schedule.hvac_rebound_kw.sum() == pytest.approx(0.5 * schedule.hvac_curtail_kw.sum(), abs=1e-3)
    active = (schedule.hvac_curtail_kw > 1e-6).astype(int).to_numpy()
    runs, current = 0, 0
    for value in active:
        current = current + 1 if value else 0
        runs = max(runs, current)
    assert runs <= spec.max_consecutive_hours


def test_no_grid_export_by_default():
    result = optimize(make_request(battery=battery(max_discharge_kw=500)))
    assert (result.schedule.optimized_load_kw >= -1e-6).all()


def test_month_to_date_peak_removes_demand_savings():
    high = optimize(make_request(battery=battery(), month_to_date_peak_kw=10_000))
    assert high.optimized_cost["demand"] == pytest.approx(0)
    assert high.savings["demand"] == pytest.approx(0)
    low = optimize(make_request(battery=battery(), month_to_date_peak_kw=0))
    assert low.savings["demand"] > 0


def test_time_of_use_arbitrage_without_demand_charge():
    rates = np.full(HOURS, 0.05)
    rates[14:18] = 0.30  # expensive block
    tariff = TariffSchedule(
        energy_rate_per_kwh=rates, demand_rate_per_kw=0.0,
        period_labels=["peak" if 14 <= h < 18 else "off" for h in range(HOURS)],
        is_time_of_use=True, rate_name="test tou",
    )
    result = optimize(make_request(tariff=tariff, battery=battery()))
    schedule = result.schedule
    assert result.savings["energy"] > 0
    assert schedule.battery_discharge_kw[14:18].sum() > schedule.battery_discharge_kw.drop(range(14, 18)).sum()


def test_flat_tariff_energy_savings_are_negligible():
    """Under a flat rate, all the value is the demand charge — worth demoing."""
    result = optimize(make_request(battery=battery()))
    assert result.savings["demand"] > 10 * abs(result.savings["energy"])


def test_week_horizon_runs():
    hours = 168
    stamps = pd.date_range("2025-06-02", periods=hours, freq="h", tz="UTC")
    load = np.tile(profile(), 7)
    result = optimize(
        OptimizationInput(
            building_id="test", timestamps=stamps, forecast_load_kw=load,
            tariff=TariffSchedule.flat(hours, 0.0842, 8.10), battery=battery(),
            hvac=HVACSpec(asset_id="h", name="hvac", daily_curtail_limit_kwh=120),
            timezone=TZ, options=OptimizationOptions(time_limit_s=60),
        )
    )
    assert result.status in ("OPTIMAL", "FEASIBLE")
    assert result.optimized_peak_kw < result.baseline_peak_kw
