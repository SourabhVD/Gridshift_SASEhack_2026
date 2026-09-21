"""
GridShift Component 3 — optimization contracts.

Everything the solver needs is expressed here, so `optimizer.py` never touches
SQLAlchemy, CSVs or the ML package. `data_access.py` is the only module that
reads the database.

Horizon-agnostic: T is simply len(timestamps). 24 h is the demo case; 168 h
(week) and ~720 h (month) use the identical model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
import pandas as pd

FLAT = "flat"


@dataclass(frozen=True)
class BatterySpec:
    asset_id: str
    name: str
    capacity_kwh: float
    max_charge_kw: float
    max_discharge_kw: float
    charge_efficiency: float = 0.95
    discharge_efficiency: float = 0.95
    min_soc_pct: float = 10.0
    max_soc_pct: float = 100.0
    initial_soc_pct: float = 50.0
    # SOC the battery must end the horizon at or above, so a 24 h run does not
    # simply dump the pack and leave tomorrow defenceless.
    final_soc_pct: float = 50.0

    def __post_init__(self) -> None:
        if self.capacity_kwh <= 0:
            raise ValueError("capacity_kwh must be positive")
        if not 0 < self.charge_efficiency <= 1 or not 0 < self.discharge_efficiency <= 1:
            raise ValueError("efficiencies must be in (0, 1]")
        for pct in (self.min_soc_pct, self.max_soc_pct, self.initial_soc_pct, self.final_soc_pct):
            if not 0 <= pct <= 100:
                raise ValueError("SOC percentages must be in [0, 100]")
        if self.min_soc_pct > self.max_soc_pct:
            raise ValueError("min_soc_pct exceeds max_soc_pct")

    def kwh(self, pct: float) -> float:
        return self.capacity_kwh * pct / 100.0


@dataclass(frozen=True)
class EVSpec:
    """One charging session. Multiple sessions per vehicle are separate specs."""

    asset_id: str
    name: str
    max_charge_kw: float
    energy_required_kwh: float
    available_from: datetime
    available_until: datetime
    charge_efficiency: float = 0.92
    # Unmet energy is penalised rather than made infeasible, so a demo run
    # never hard-fails on an over-committed plug schedule.
    priority: float = 1.0


@dataclass(frozen=True)
class HVACSpec:
    """Curtailable HVAC envelope, expressed against forecast load.

    Deliberately simple: no thermal RC model. `max_curtail_fraction` is the
    share of predicted whole-building load HVAC can shed in one hour,
    `recovery_fraction` is how much of the shed energy must be paid back later
    (thermal rebound), and the consecutive/daily limits stand in for comfort.
    """

    asset_id: str
    name: str
    max_curtail_fraction: float = 0.15
    max_curtail_kw: float | None = None
    max_consecutive_hours: int = 3
    recovery_fraction: float = 0.5
    daily_curtail_limit_kwh: float | None = None

    def __post_init__(self) -> None:
        if not 0 <= self.max_curtail_fraction <= 1:
            raise ValueError("max_curtail_fraction must be in [0, 1]")
        if not 0 <= self.recovery_fraction <= 1:
            raise ValueError("recovery_fraction must be in [0, 1]")


@dataclass(frozen=True)
class TariffSchedule:
    """Per-hour energy price plus a billing-period demand charge.

    A flat tariff is a constant `energy_rate_per_kwh` array, so the solver code
    is identical for flat and time-of-use. `period_labels` is for reporting.
    """

    energy_rate_per_kwh: np.ndarray
    demand_rate_per_kw: float
    period_labels: list[str]
    currency: str = "USD"
    rate_name: str = "unknown"
    is_time_of_use: bool = False

    def __post_init__(self) -> None:
        if np.any(np.asarray(self.energy_rate_per_kwh) < 0):
            raise ValueError("energy rates must be non-negative")
        if self.demand_rate_per_kw < 0:
            raise ValueError("demand rate must be non-negative")

    @classmethod
    def flat(cls, hours: int, energy_rate: float, demand_rate: float, **kw) -> "TariffSchedule":
        return cls(
            energy_rate_per_kwh=np.full(hours, float(energy_rate)),
            demand_rate_per_kw=float(demand_rate),
            period_labels=[FLAT] * hours,
            **kw,
        )


@dataclass
class OptimizationOptions:
    solver_name: str = "SCIP"
    time_limit_s: float = 30.0
    allow_grid_export: bool = False
    # Binaries forbid simultaneous charge+discharge and enforce the HVAC
    # consecutive-hour limit. Exact, but MIP; relaxed on long horizons.
    use_binaries: bool = True
    max_binary_hours: int = 336
    unmet_ev_penalty_per_kwh: float = 100.0  # last-resort slack, not a price
    comfort_penalty_per_kwh: float = 1.0
    peak_weight_per_kw: float = 0.0  # extra pressure on peak beyond its $ value


@dataclass
class OptimizationInput:
    building_id: str
    timestamps: pd.DatetimeIndex
    forecast_load_kw: np.ndarray
    tariff: TariffSchedule
    battery: BatterySpec | None = None
    evs: list[EVSpec] = field(default_factory=list)
    hvac: HVACSpec | None = None
    # Highest demand already billed this month. The demand charge applies only
    # to what a new peak adds on top of it.
    month_to_date_peak_kw: float = 0.0
    timezone: str = "America/Los_Angeles"
    options: OptimizationOptions = field(default_factory=OptimizationOptions)

    def __post_init__(self) -> None:
        self.forecast_load_kw = np.asarray(self.forecast_load_kw, dtype=float)
        if len(self.timestamps) != len(self.forecast_load_kw):
            raise ValueError("timestamps and forecast_load_kw must have equal length")
        if len(self.timestamps) == 0:
            raise ValueError("empty horizon")
        if len(self.tariff.energy_rate_per_kwh) != len(self.timestamps):
            raise ValueError("tariff length must match the horizon")
        if not np.isfinite(self.forecast_load_kw).all() or (self.forecast_load_kw < 0).any():
            raise ValueError("forecast load must be finite and non-negative")

    @property
    def hours(self) -> int:
        return len(self.timestamps)


@dataclass
class OptimizationResult:
    status: str
    schedule: pd.DataFrame
    baseline_peak_kw: float
    optimized_peak_kw: float
    baseline_cost: dict[str, float]
    optimized_cost: dict[str, float]
    savings: dict[str, float]
    violations: dict[str, float]
    solver: dict[str, float | str]
    # Per-device summaries, keyed "battery" / "hvac" / "ev:<session name>" /
    # "other_electrical". CSV/console only — not persisted to the DB (the
    # optimization_plans table stays aggregate-only by design).
    device_plans: dict[str, dict] = field(default_factory=dict)

    def summary(self) -> str:
        cut = self.baseline_peak_kw - self.optimized_peak_kw
        pct = 100 * cut / self.baseline_peak_kw if self.baseline_peak_kw else 0.0
        return (
            f"{self.status} | peak {self.baseline_peak_kw:.1f} -> "
            f"{self.optimized_peak_kw:.1f} kW ({pct:.1f}% cut) | "
            f"saves ${self.savings['total']:.2f} "
            f"(energy ${self.savings['energy']:.2f}, demand ${self.savings['demand']:.2f})"
        )

    def format_plan(self) -> str:
        """Human-readable per-device breakdown: battery, each EV, HVAC, other."""
        lines: list[str] = []

        battery = self.device_plans.get("battery")
        if battery:
            lines.append(
                f"BATTERY  {battery['name']}  {battery['capacity_kwh']:.1f} kWh\n"
                f"  charged {battery['energy_charged_kwh']:.1f} kWh | "
                f"discharged {battery['energy_discharged_kwh']:.1f} kWh | "
                f"SOC {battery['soc_start_pct']:.0f}% -> {battery['soc_end_pct']:.0f}% | "
                f"active {battery['active_hours']}/{battery['horizon_hours']} h"
            )
        else:
            lines.append("BATTERY  none configured")

        ev_plans = {k: v for k, v in self.device_plans.items() if k.startswith("ev:")}
        if ev_plans:
            lines.append(f"EV FLEET  {len(ev_plans)} session(s)")
            for plan in ev_plans.values():
                status = "OK" if plan["unmet_kwh"] < 1e-6 else f"SHORT {plan['unmet_kwh']:.1f} kWh"
                lines.append(
                    f"  {plan['name']:<20} {plan['delivered_kwh']:.1f}/{plan['required_kwh']:.1f} kWh "
                    f"[{plan['window_start']} -> {plan['window_end']}]  {status}"
                )
        else:
            lines.append("EV FLEET  none configured")

        hvac = self.device_plans.get("hvac")
        if hvac:
            lines.append(
                f"HVAC     {hvac['name']}\n"
                f"  curtailed {hvac['curtailed_kwh']:.1f} kWh | rebounded {hvac['rebounded_kwh']:.1f} kWh | "
                f"active {hvac['active_hours']}/{hvac['horizon_hours']} h | "
                f"longest run {hvac['longest_run_hours']} h"
            )
        else:
            lines.append("HVAC     none configured")

        other = self.device_plans.get("other_electrical")
        if other:
            lines.append(
                f"OTHER ELECTRICAL (lighting, plug loads, non-curtailed HVAC baseline — "
                f"the forecast's non-flexible remainder; not independently metered)\n"
                f"  avg {other['avg_kw']:.1f} kW | peak {other['peak_kw']:.1f} kW | "
                f"total {other['total_kwh']:.1f} kWh over the horizon"
            )

        return "\n".join(lines)
