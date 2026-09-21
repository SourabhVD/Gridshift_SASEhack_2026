"""
What GridShift would have done across every metered day on disk.

This is a backtest, and it is labelled one everywhere it surfaces. Nothing here
was dispatched: each day is the forecast the model produced for a real date,
put through the same optimizer the live product runs, and priced on the same
tariff. It is not a record of savings achieved.

Why it exists
-------------
A demand charge is billed on the single highest interval in a MONTH. One day
cannot tell you what it does to a bill, so a single-day figure has to be
extrapolated, and extrapolating it is wrong in a way that always flatters:
multiplying one day's peak cut by thirty assumes every day sets its own bill.
It does not. You pay once, on the worst interval of the month.

So this reports both. `best_day_claim_usd` is what you would say if you picked
your best day and quoted its peak cut -- which is exactly what a one-day demo
does, ours included. `demand_charge_usd` is what the period actually delivers,
taking the worst interval on each side. The gap between them is the honest
part: you only get the full cut if the day you shaved hardest is also the day
that set the bill, and the optimized peak on every other day stays below it.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ..config import get_settings
from ..fixtures.generator import DEMAND_CHARGE_USD_PER_KW, round1, round2
from . import forecast as forecast_service
from .optimizer import solve

log = logging.getLogger("gridshift.reports")

def _accuracy(date: str) -> dict[str, float]:
    """The harness's own scoring for a day, if it wrote any."""
    directory = get_settings().backtest_path / date
    try:
        raw = json.loads((directory / "metrics.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - metrics are enrichment, never required
        return {}
    out = {}
    for key, name in (("MAE_kW", "mae_kw"), ("MAPE_pct", "mape_pct"), ("R2", "r2")):
        value = raw.get(key)
        if isinstance(value, (int, float)):
            out[name] = round(float(value), 4)
    return out


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 4) if values else None


def backtest_report(building_id: str) -> dict[str, Any]:
    """
    Every available day, solved, plus the month those days add up to.

    Days the reader cannot serve are skipped and counted rather than failing
    the report: one unreadable directory should not take the other thirty with
    it, but a report that silently covered less than it claimed would be worse
    than no report at all.
    """
    fixture = forecast_service.require_fixture(building_id)
    dates = forecast_service.available_dates()

    # The same factor the dashboard uses, so a day read here and a day read
    # there are the same day. Scaling each one onto the site's peak separately
    # would make all 31 peak at the identical number and destroy the only
    # thing a month tells you: which day set the bill.
    factor = forecast_service.period_factor(fixture)

    days: list[dict[str, Any]] = []
    skipped: list[str] = []

    for date in dates:
        with forecast_service.serve_date(date), forecast_service.period_scale(factor):
            curve = forecast_service.current_curve(fixture)
            if curve.source != "backtest":
                # This site is not the one the backtests are for, or the day
                # is unreadable and the service fell back to the fixture.
                skipped.append(date)
                continue
            result = solve(fixture)
            row = {
                "date": date,
                "baseline_peak_kw": result.baseline_peak_kw,
                "optimized_peak_kw": result.optimized_peak_kw,
                "peak_reduction_kw": result.peak_reduction_kw,
                "baseline_cost_usd": result.baseline_cost_usd,
                "optimized_cost_usd": result.optimized_cost_usd,
                "energy_savings_usd": result.savings_usd,
                "actions": len(
                    [d for d in fixture.build_actions(result) if d["end_time"] > d["start_time"]]
                ),
            }
            row.update(_accuracy(date))
            days.append(row)

    if not days:
        return {
            "building_id": fixture.id,
            "building_name": fixture.name,
            "days": [],
            "skipped_dates": skipped,
            "summary": None,
        }

    # The billed peak is the worst interval in the period, not the average of
    # the daily peaks and not their sum. This is the whole reason the report
    # exists.
    billed_baseline = max(d["baseline_peak_kw"] for d in days)
    billed_optimized = max(d["optimized_peak_kw"] for d in days)
    billed_cut = round1(billed_baseline - billed_optimized)
    demand_usd = round2(billed_cut * DEMAND_CHARGE_USD_PER_KW)

    energy_usd = round2(sum(d["energy_savings_usd"] for d in days))
    # What a single-day demo would quote: the best day's cut, priced as though
    # it were the month's. Not a strawman -- it is what our own card says.
    best_day = max(days, key=lambda d: d["peak_reduction_kw"])
    best_claim_usd = round2(best_day["peak_reduction_kw"] * DEMAND_CHARGE_USD_PER_KW)

    summary = {
        "days_covered": len(days),
        "first_date": days[0]["date"],
        "last_date": days[-1]["date"],
        # What the utility actually bills on.
        "billed_peak_baseline_kw": billed_baseline,
        "billed_peak_optimized_kw": billed_optimized,
        "billed_peak_reduction_kw": billed_cut,
        "demand_charge_usd_per_kw": DEMAND_CHARGE_USD_PER_KW,
        "demand_charge_usd": demand_usd,
        "energy_savings_usd": energy_usd,
        "total_savings_usd": round2(demand_usd + energy_usd),
        # And what quoting the best single day would have claimed.
        "mean_daily_peak_reduction_kw": round1(_mean([d["peak_reduction_kw"] for d in days]) or 0.0),
        "best_day": best_day["date"],
        "best_day_peak_reduction_kw": best_day["peak_reduction_kw"],
        "best_day_claim_usd": best_claim_usd,
        "best_day_overstates_by_usd": round2(best_claim_usd - demand_usd),
        # Whose forecast this was.
        "mean_mae_kw": _mean([d["mae_kw"] for d in days if "mae_kw" in d]),
        "mean_mape_pct": _mean([d["mape_pct"] for d in days if "mape_pct" in d]),
        "mean_r2": _mean([d["r2"] for d in days if "r2" in d]),
        "days_over_threshold": sum(
            1 for d in days if d["baseline_peak_kw"] > fixture.peak_threshold_kw
        ),
        "threshold_kw": fixture.peak_threshold_kw,
    }

    log.info(
        "backtest report for %s: %d days %s..%s, billed peak %.1f -> %.1f kW, $%.2f",
        fixture.id,
        summary["days_covered"],
        summary["first_date"],
        summary["last_date"],
        billed_baseline,
        billed_optimized,
        summary["total_savings_usd"],
    )

    return {
        "building_id": fixture.id,
        "building_name": fixture.name,
        "days": days,
        "skipped_dates": skipped,
        "summary": summary,
    }


__all__ = ["backtest_report"]
