"""
Deterministic fixture kit -- the Python port of
frontend/src/mocks/buildings/shared.ts.

Nothing here is random. Every curve comes from a handful of control points, so
the forecast, the flow diagram, the KPI tiles and the action plan are reading
the same arithmetic and cannot disagree. The one rule the whole module exists
to enforce:

    grid_kw = base_kw + ev_kw + hvac_kw - solar_kw - battery_kw

battery_kw is the only signed field: positive means the pack is discharging
into the building, negative means it is charging from the grid.

Rounding note: JavaScript's Math.round rounds half *up* (towards +Infinity)
while Python's round() rounds half to even. js_round below reproduces the
JavaScript behaviour so these curves are identical to the ones the frontend
mock serves.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

HOURS = 24

#: Thursday. Pinned so fixtures stay stable across runs.
DEMO_DATE = "2025-09-18"
#: The day after, for dispatch windows that run past midnight.
NEXT_DATE = "2025-09-19"
#: Seattle, PDT. All four buildings share the day and the tariff.
TZ_OFFSET = "-07:00"
#: The demo's "now". Hours before this have metered actuals.
NOW_HOUR = 10


def iso_hour(h: int, date: str = DEMO_DATE) -> str:
    """ISO 8601 timestamp for the start of hour h on the demo day."""
    return "%sT%02d:00:00%s" % (date, h, TZ_OFFSET)


def iso_minute(h: int, m: int, date: str = DEMO_DATE) -> str:
    return "%sT%02d:%02d:00%s" % (date, h, m, TZ_OFFSET)


def next_day_iso(h: int) -> str:
    return iso_hour(h, NEXT_DATE)


NOW_ISO = iso_hour(NOW_HOUR)


# --------------------------------------------------------------------------- #
# Small deterministic math                                                     #
# --------------------------------------------------------------------------- #


def js_round(value: float) -> float:
    """Math.round semantics: half rounds towards +Infinity."""
    return math.floor(value + 0.5)


def round1(value: float) -> float:
    return js_round(value * 10) / 10


def round2(value: float) -> float:
    return js_round(value * 100) / 100


def zeros() -> list[float]:
    return [0.0] * HOURS


def flat(value: float) -> list[float]:
    return [float(value)] * HOURS


def with_hours(series: Sequence[float], hours: Iterable[int], value: float) -> list[float]:
    """Writes value into hours of a fresh copy of series."""
    out = [float(v) for v in series]
    for h in hours:
        out[h] = float(value)
    return out


def hour_range(start: int, end: int) -> list[int]:
    """Inclusive start, exclusive end: hour_range(14, 17) -> [14, 15, 16]."""
    return list(range(start, end))


def piecewise(points: Sequence[tuple[int, float]]) -> list[float]:
    """
    A 24-hour curve through sparse [hour, value] control points, linearly
    interpolated between them and held flat outside the first/last point.
    """
    ordered = sorted(points, key=lambda p: p[0])
    out: list[float] = []
    for h in range(HOURS):
        if h <= ordered[0][0]:
            out.append(float(ordered[0][1]))
            continue
        if h >= ordered[-1][0]:
            out.append(float(ordered[-1][1]))
            continue
        i = 0
        while ordered[i + 1][0] < h:
            i += 1
        h0, v0 = ordered[i]
        h1, v1 = ordered[i + 1]
        out.append(v0 + ((v1 - v0) * (h - h0)) / (h1 - h0))
    return out


def solar_bell(
    peak_kw: float, peak_hour: float, half_width_h: float, exponent: float = 2
) -> list[float]:
    """
    Clear-day PV curve: a raised cosine reaching peak_kw at peak_hour and
    touching zero half_width_h hours either side.
    """
    out: list[float] = []
    for h in range(HOURS):
        offset = abs(h - peak_hour)
        if offset >= half_width_h:
            out.append(0.0)
            continue
        c = math.cos((offset / half_width_h) * (math.pi / 2))
        out.append(round1(peak_kw * (c ** exponent)))
    return out


# --------------------------------------------------------------------------- #
# Weather -- one Seattle September day, shared by all four sites               #
# --------------------------------------------------------------------------- #

OUTDOOR_TEMP_F: list[float] = [
    round1(v)
    for v in piecewise(
        [
            (0, 60),
            (4, 55),
            (7, 59),
            (10, 71),
            (13, 77),
            (16, 80),
            (19, 72),
            (21, 66),
            (23, 62),
        ]
    )
]

_TEMP_MIN = min(OUTDOOR_TEMP_F)
_TEMP_MAX = max(OUTDOOR_TEMP_F)

#: Outdoor temperature normalised to 0..1. Drives the HVAC share of load.
TEMP_SHAPE: list[float] = [(t - _TEMP_MIN) / (_TEMP_MAX - _TEMP_MIN) for t in OUTDOOR_TEMP_F]


# --------------------------------------------------------------------------- #
# Tariff                                                                       #
# --------------------------------------------------------------------------- #

#: Seattle City Light style TOU: $0.09/kWh off-peak, $0.16/kWh 14:00-20:00.
PRICE_PER_KWH: list[float] = [0.16 if 14 <= h < 20 else 0.09 for h in range(HOURS)]
OFF_PEAK_USD_PER_KWH = 0.09
ON_PEAK_USD_PER_KWH = 0.16
ON_PEAK_WINDOW = "14:00-20:00"
#: Monthly demand charge used for the avoided-demand-charge figure.
DEMAND_CHARGE_USD_PER_KW = 8.5


def energy_cost(load_kw: Sequence[float]) -> float:
    return sum(kw * PRICE_PER_KWH[h] for h, kw in enumerate(load_kw))


# --------------------------------------------------------------------------- #
# Deriving an action from a dispatch                                           #
# --------------------------------------------------------------------------- #
#
# The four sites' action text was authored against the heuristic, which shaves
# a flat rate across one contiguous window. A solver does not: it varies the
# rate hour to hour and may split the dispatch. That left every site stating a
# window its own curve contradicted -- an action reading "14:00-17:00" beside a
# battery that actually ran 13:00 to 18:00 -- and per-action savings that no
# longer summed to the plan's. Both are read by the person approving the plan,
# so both are derived here rather than typed.


def action_window(hours: Iterable[int] | Mapping[int, float]) -> tuple[int, int]:
    """
    Inclusive start and exclusive end hour spanned by a lever's activity.

    A split dispatch is reported as the span covering it, because an action is
    one row with one window in the contract. A gap belongs in the description,
    not in a second row the frontend has nowhere to put.
    """
    active = sorted(int(h) for h in hours)
    if not active:
        return 0, 0
    return active[0], min(active[-1] + 1, HOURS)


def lever_savings_usd(delta_kw: Mapping[int, float], *, reduces_grid: bool = False) -> float:
    """
    What one lever's own change to the grid curve is worth at the tariff.

    `delta_kw` is the lever's hourly change in its own terms. Consumers (EV,
    HVAC) raise the grid as they rise, so a positive delta costs money. A
    battery discharge is the other way round, so pass `reduces_grid=True` to
    price a positive value as a saving. Across the levers these sum to the
    plan's energy saving, which is the first thing a reader checks.
    """
    sign = 1.0 if reduces_grid else -1.0
    return round2(
        sum(sign * kw * PRICE_PER_KWH[h] for h, kw in delta_kw.items() if 0 <= int(h) < HOURS)
    )


def lever_cut_at(delta_kw: Mapping[int, float], hour: int, *, reduces_grid: bool = False) -> float:
    """
    How much this lever takes off the grid at one hour, never below zero.

    The contract defines `estimated_peak_reduction_kw` as a lever's
    contribution at the BASELINE peak interval, so a lever doing nothing then
    contributes nothing. That is the honest answer for a battery that starts
    after the peak, and it stops an action claiming a reduction it never made.
    """
    value = float(delta_kw.get(hour, 0.0))
    return round1(max(0.0, value if reduces_grid else -value))


# --------------------------------------------------------------------------- #
# HVAC                                                                         #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class HvacShareSpec:
    """HVAC as a share of the hour's grid load, sliding with outdoor temp."""

    night: float
    day_min: float
    day_max: float
    day_start: int
    day_end: int


def hvac_profile(grid: Sequence[float], spec: HvacShareSpec) -> list[float]:
    out: list[float] = []
    for h, kw in enumerate(grid):
        occupied = spec.day_start <= h < spec.day_end
        if occupied:
            share = spec.day_min + (spec.day_max - spec.day_min) * TEMP_SHAPE[h]
        else:
            share = spec.night
        out.append(round1(share * kw))
    return out


# --------------------------------------------------------------------------- #
# Flow assembly                                                                #
# --------------------------------------------------------------------------- #


@dataclass
class FlowComponents:
    """The five consumer/source series plus the battery's state of charge."""

    base: list[float]
    ev: list[float]
    hvac: list[float]
    solar: list[float]
    #: Signed: > 0 discharging into the building, < 0 charging from the grid.
    battery: list[float]
    #: State of charge at the end of each hour.
    soc: list[float] = field(default_factory=zeros)

    def copy(self) -> "FlowComponents":
        return FlowComponents(
            base=list(self.base),
            ev=list(self.ev),
            hvac=list(self.hvac),
            solar=list(self.solar),
            battery=list(self.battery),
            soc=list(self.soc),
        )


def base_from_grid(
    grid: Sequence[float],
    *,
    ev: Sequence[float],
    hvac: Sequence[float],
    solar: Sequence[float],
    battery: Sequence[float],
) -> list[float]:
    """Solve the identity for base_kw, given an authored grid curve."""
    return [round1(kw - ev[h] - hvac[h] + solar[h] + battery[h]) for h, kw in enumerate(grid)]


def grid_from_components(parts: FlowComponents) -> list[float]:
    """Solve the identity for grid_kw, given authored consumers and sources."""
    return [
        round1(kw + parts.ev[h] + parts.hvac[h] - parts.solar[h] - parts.battery[h])
        for h, kw in enumerate(parts.base)
    ]


def to_flows(grid: Sequence[float], parts: FlowComponents) -> list[dict[str, float]]:
    return [
        {
            "grid_kw": round1(kw),
            "solar_kw": round1(parts.solar[h]),
            "battery_kw": round1(parts.battery[h]),
            "ev_kw": round1(parts.ev[h]),
            "hvac_kw": round1(parts.hvac[h]),
            "base_kw": round1(parts.base[h]),
            "battery_soc_pct": round1(parts.soc[h]),
        }
        for h, kw in enumerate(grid)
    ]


def flow_residual(flows: dict[str, float]) -> float:
    """Signed residual of the flow identity, in kW. Zero means consistent."""
    return flows["grid_kw"] - (
        flows["base_kw"]
        + flows["ev_kw"]
        + flows["hvac_kw"]
        - flows["solar_kw"]
        - flows["battery_kw"]
    )


#: Half a rounding step. Flows are published to 0.1 kW, so anything larger is
#: a real inconsistency rather than float noise.
FLOW_TOLERANCE_KW = 0.05

#: Where a flow breakdown can hang, and the series it must equal.
_FLOW_KEYS: tuple[tuple[str, str | None], ...] = (
    ("flows", "predicted_load_kw"),
    ("baseline_flows", "baseline_kw"),
    ("optimized_flows", "optimized_kw"),
)


def assert_flows_identity(points: Any, *, label: str = "response") -> None:
    """
    Check the flow identity over a whole response, and raise on the first
    inconsistency.

        grid_kw = base_kw + ev_kw + hvac_kw - solar_kw - battery_kw

    Accepts anything that carries flows: a ForecastResponse or ActionPlan dict,
    a list of forecast points, a list of impact points, or a list of bare flow
    dicts. Where a point also publishes the matching kW series
    (`predicted_load_kw`, `baseline_kw`, `optimized_kw`) that value is checked
    against `grid_kw` too, because the flow diagram and the charts read the two
    separately and must not disagree.

    Run this against every forecast and plan response you build. It is cheap,
    it is the invariant the whole dashboard is drawn from, and a violation is
    always a backend bug.
    """
    if isinstance(points, dict):
        points = points.get("points") or points.get("impact") or [points]

    for index, point in enumerate(points):
        if not isinstance(point, dict):  # pragma: no cover - defensive
            raise AssertionError(f"{label}[{index}] is not a mapping")

        found = False
        for key, series_key in _FLOW_KEYS:
            flows = point.get(key)
            if flows is None:
                continue
            found = True
            _assert_one(flows, f"{label}[{index}].{key}")
            if series_key and series_key in point:
                delta = abs(float(point[series_key]) - float(flows["grid_kw"]))
                if delta > FLOW_TOLERANCE_KW:
                    raise AssertionError(
                        f"{label}[{index}]: {series_key}={point[series_key]} but "
                        f"{key}.grid_kw={flows['grid_kw']} (off by {delta:.4f} kW)"
                    )

        if not found and "grid_kw" in point:
            _assert_one(point, f"{label}[{index}]")


def _assert_one(flows: dict[str, float], where: str) -> None:
    missing = [
        k
        for k in ("grid_kw", "solar_kw", "battery_kw", "ev_kw", "hvac_kw", "base_kw")
        if k not in flows
    ]
    if missing:
        raise AssertionError(f"{where} is missing flow fields: {missing}")
    residual = flow_residual(flows)
    if abs(residual) > FLOW_TOLERANCE_KW:
        raise AssertionError(
            f"{where} breaks the flow identity by {residual:.4f} kW "
            f"(grid_kw={flows['grid_kw']}, base={flows['base_kw']}, ev={flows['ev_kw']}, "
            f"hvac={flows['hvac_kw']}, solar={flows['solar_kw']}, "
            f"battery={flows['battery_kw']})"
        )


#: "no hours" reads better than "zero hours", which is why 0 is a word too.
_NUMBER_WORDS = (
    "no", "one", "two", "three", "four", "five", "six",
    "seven", "eight", "nine", "ten", "eleven", "twelve",
)


def number_word(value: int) -> str:
    """'two' rather than '2'. Prose counts small things in words."""
    return _NUMBER_WORDS[value] if 0 <= value < len(_NUMBER_WORDS) else str(value)


def energy_phrase(savings_usd: float, noun: str = "Day-ahead energy cost") -> str:
    """
    "Day-ahead energy cost falls $23.13" / "...rises $13.34".

    Flattening a peak is not always cheap, and on a real metered day it often
    is not. 2018-08-09 peaks between 09:00 and 14:00, which this tariff prices
    off-peak, so the only way to move load out of the peak is to move it into
    the expensive hours: the office gives up $13.34 of energy to take 162 kW
    off the billing peak, which is worth $1,373 a month. That is the right
    trade and the plan makes it on purpose. Printing it as "falls $-13.34" is
    how a correct plan ends up reading like a broken one.
    """
    return f"{noun} {'falls' if savings_usd >= 0 else 'rises'} ${abs(savings_usd):.2f}"


def solver_label() -> str:
    """
    What the scripted agent should call the solver it just ran.

    The fixtures used to hardcode "CP-SAT" in the payload the agent narrates.
    That was true while the CP-SAT model was the default and became a false
    statement in the demo the day Minh's engine took over -- the kind of
    detail a judge asks about precisely because it is in writing.
    """
    from ..config import get_settings  # noqa: PLC0415 - avoids an import cycle

    return {
        "engine": "MIP (OR-Tools/SCIP)",
        "cpsat": "CP-SAT",
        "heuristic": "fixed-order heuristic",
    }.get(get_settings().optimizer_mode, "MIP (OR-Tools/SCIP)")


def soc_walk(
    battery: Sequence[float],
    start_pct: float,
    capacity_kwh: float,
    *,
    charge_efficiency: float = 1.0,
    discharge_efficiency: float = 1.0,
) -> list[float]:
    """
    State-of-charge walk. Every hour the battery moves battery[h] kW for one
    hour, so SOC changes by -battery[h] / capacity. Positive kW (discharge)
    drains, negative kW (charge) fills.

    `battery` is metered at the inverter, which is not what reaches the cells.
    A pack with efficiencies below 1 stores only `charge_kw * eta_c` of what it
    draws and must take `discharge_kw / eta_d` out of itself to deliver a
    discharge. Both default to 1.0 -- lossless, which is what the heuristic and
    the CP-SAT model assume -- so pass the real figures when the schedule came
    from a solver that priced the losses, or the published SOC will climb past
    100% on charge and bottom out below where the solver put it.
    """
    soc = start_pct
    out: list[float] = []
    for kw in battery:
        stored = kw / discharge_efficiency if kw > 0 else kw * charge_efficiency
        soc = round1(soc - (stored / capacity_kwh) * 100)
        out.append(soc)
    return out


def metered_actuals(grid: Sequence[float], until_hour: int) -> list[float | None]:
    """Deterministic wobble of about half a percent before until_hour."""
    return [
        round1(kw * (1 + 0.004 * math.sin(h * 1.7) - 0.005)) if h < until_hour else None
        for h, kw in enumerate(grid)
    ]


def pv_priority_charge(
    solar: Sequence[float], start_pct: float, capacity_kwh: float, max_kw: float
) -> list[float]:
    """
    Hybrid-inverter behaviour: fill the pack from PV before serving the house.
    Returns the signed battery series (negative is charging).
    """
    out = zeros()
    soc = start_pct
    for h in range(HOURS):
        headroom_kwh = ((100 - soc) / 100) * capacity_kwh
        charge = min(solar[h], headroom_kwh, max_kw)
        # Below 0.05 kW the published value would round to zero anyway.
        out[h] = 0.0 if charge < 0.05 else round1(-charge)
        soc = round1(soc - (out[h] / capacity_kwh) * 100)
    return out
