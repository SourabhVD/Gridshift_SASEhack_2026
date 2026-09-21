"""
GridShift Component 3 — CLI.

Database mode (reads the teammate's data):

    python -m optimizer.run_optimizer --building-id <uuid> --hours 24
    python -m optimizer.run_optimizer --building-id <uuid> --hours 168 --pricing tou
    python -m optimizer.run_optimizer --building-id <uuid> --write-plan

Offline mode (no PostgreSQL; for demos and tests):

    python -m optimizer.run_optimizer --forecast-csv path.csv \
        --energy-rate 0.0842 --demand-rate 8.10

The CSV needs `timestamp` and `predicted_load_kw` — the Component 2 output
contract, so `ml/evaluation/demo_forecast_24h.csv` works directly.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from optimizer.optimizer import optimize
from optimizer.schemas import OptimizationInput, OptimizationOptions, TariffSchedule
from optimizer.seed_devices import default_battery, default_evs, default_hvac


def request_from_csv(path: str, energy_rate: float, demand_rate: float, hours: int,
                     timezone: str, month_to_date_peak: float,
                     options: OptimizationOptions) -> OptimizationInput:
    frame = pd.read_csv(path)
    if not {"timestamp", "predicted_load_kw"} <= set(frame.columns):
        raise ValueError("CSV needs 'timestamp' and 'predicted_load_kw' columns")
    stamps = pd.to_datetime(frame.timestamp)
    stamps = stamps.dt.tz_localize("UTC") if stamps.dt.tz is None else stamps.dt.tz_convert("UTC")
    timestamps = pd.DatetimeIndex(stamps).sort_values()[:hours]
    forecast = frame.predicted_load_kw.to_numpy(dtype=float)[: len(timestamps)]

    return OptimizationInput(
        building_id="offline-demo",
        timestamps=timestamps,
        forecast_load_kw=forecast,
        tariff=TariffSchedule.flat(len(timestamps), energy_rate, demand_rate, rate_name="offline flat"),
        battery=default_battery(float(forecast.max())),
        evs=default_evs(timestamps[0], timezone=timezone),
        hvac=default_hvac(float(forecast.sum())),
        month_to_date_peak_kw=month_to_date_peak,
        timezone=timezone,
        options=options,
    )


def main() -> None:
    cli = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    cli.add_argument("--building-id", help="read forecast, tariff and devices from PostgreSQL")
    cli.add_argument("--forecast-csv", help="offline mode: timestamp,predicted_load_kw")
    cli.add_argument("--hours", type=int, default=24, help="24 (day), 168 (week), 720 (month)")
    cli.add_argument("--pricing", choices=("auto", "flat", "tou"), default="flat")
    cli.add_argument("--energy-rate", type=float, default=0.0842, help="offline mode $/kWh")
    cli.add_argument("--demand-rate", type=float, default=8.10, help="offline mode $/kW")
    cli.add_argument("--month-to-date-peak", type=float, default=0.0,
                     help="offline mode: kW already billed this month")
    cli.add_argument("--ignore-month-to-date-peak", action="store_true",
                     help="DB mode: price the horizon peak from zero instead of the monthly max")
    cli.add_argument("--timezone", default="America/Los_Angeles")
    cli.add_argument("--solver", default="SCIP")
    cli.add_argument("--time-limit", type=float, default=30.0)
    cli.add_argument("--no-binaries", action="store_true", help="solve the LP relaxation (faster, approximate)")
    cli.add_argument("--write-plan", action="store_true", help="DB mode: save to optimization_plans")
    cli.add_argument("--out", default="optimizer/output", help="directory for schedule + summary CSVs")
    args = cli.parse_args()

    if bool(args.building_id) == bool(args.forecast_csv):
        cli.error("Pass exactly one of --building-id or --forecast-csv")

    options = OptimizationOptions(
        solver_name=args.solver, time_limit_s=args.time_limit, use_binaries=not args.no_binaries
    )

    engine = None
    if args.building_id:
        from data.scripts.db.connection import get_engine
        from optimizer.data_access import build_request, write_plan

        engine = get_engine()
        request = build_request(
            args.building_id, hours=args.hours, pricing=args.pricing, options=options,
            engine=engine, carry_month_to_date_peak=not args.ignore_month_to_date_peak,
        )
    else:
        request = request_from_csv(
            args.forecast_csv, args.energy_rate, args.demand_rate, args.hours,
            args.timezone, args.month_to_date_peak, options,
        )

    try:
        result = optimize(request)

        print(f"building        {request.building_id}")
        print(f"horizon         {request.hours} h from {request.timestamps[0]}")
        print(f"tariff          {request.tariff.rate_name} "
              f"({'TOU' if request.tariff.is_time_of_use else 'flat'}), "
              f"demand ${request.tariff.demand_rate_per_kw}/kW")
        print(f"month-to-date   {request.month_to_date_peak_kw:.1f} kW already billed")
        print(f"devices         battery={request.battery is not None} "
              f"evs={len(request.evs)} hvac={request.hvac is not None}")
        print()
        print(result.summary())
        print(f"cost  baseline ${result.baseline_cost['total']:.2f} "
              f"-> optimized ${result.optimized_cost['total']:.2f}")
        print()
        print(result.format_plan())
        print()
        if any(result.violations.values()):
            print(f"violations      {result.violations}")
        print(f"solver          {result.solver['name']} {result.solver['wall_time_ms']} ms, "
              f"{result.solver['variables']} vars / {result.solver['constraints']} cons")
        if result.solver["relaxation_notes"]:
            print(f"relaxations     {result.solver['relaxation_notes']}")

        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        result.schedule.to_csv(out / "schedule.csv", index=False)
        pd.DataFrame(
            [
                {"metric": "baseline_peak_kw", "value": result.baseline_peak_kw},
                {"metric": "optimized_peak_kw", "value": result.optimized_peak_kw},
                {"metric": "baseline_cost_usd", "value": result.baseline_cost["total"]},
                {"metric": "optimized_cost_usd", "value": result.optimized_cost["total"]},
                {"metric": "savings_energy_usd", "value": result.savings["energy"]},
                {"metric": "savings_demand_usd", "value": result.savings["demand"]},
                {"metric": "savings_total_usd", "value": result.savings["total"]},
            ]
        ).to_csv(out / "summary.csv", index=False)
        print(f"\nwrote {out / 'schedule.csv'} and {out / 'summary.csv'}")

        if args.write_plan and engine is not None:
            print(f"persisted {write_plan(engine, request.building_id, result)} rows to optimization_plans")
    finally:
        if engine is not None:
            engine.dispose()


if __name__ == "__main__":
    main()
