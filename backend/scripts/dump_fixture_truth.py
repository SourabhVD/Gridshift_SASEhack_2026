"""
Dump what the backend's optimizer actually produces, for the frontend's
fixture verifier.

    python backend/scripts/dump_fixture_truth.py          # writes backend_truth.json here
    python backend/scripts/dump_fixture_truth.py out.json

Then, from `frontend/`:

    BACKEND_TRUTH=../backend_truth.json npx tsx scripts/verify-fixtures.ts

Why this exists
---------------
`frontend/src/mocks/` is the offline fallback the dashboard serves when the API
is unreachable, and it is a transcription of a real solve: the dispatch, the
state of charge and the resulting curves are copied out of the backend by hand.
Transcriptions rot. Every time the optimizer changes -- and it has changed
twice, from the fixed-order heuristic to CP-SAT to Minh's engine -- every one
of those numbers moves, and the demo starts showing different figures depending
on whether the backend happens to be up.

So the fixtures are checked against the backend rather than trusted, and this
is the half of that check that has to run in Python. Without it the verifier
has nothing to compare to and silently skips, which is the failure mode it was
written to prevent.

Forecast mode
-------------
Pinned to `fixtures` on purpose. `backtest` mode maps the curves onto a real
metered day, so it produces a different answer every time the day changes and
nothing static could ever match it. What is being checked here is that the
frontend and the backend agree about the OPTIMIZER and the CONTRACT -- the
dispatch, the flow identity, the pricing, how many actions a plan has -- not
about which day is being served.

The optimizer mode is not pinned: run it under whichever optimizer the demo
will run under, and the fixtures have to match that one.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))

os.environ.setdefault("GRIDSHIFT_FORECAST", "fixtures")

from app.fixtures import FIXTURES  # noqa: E402
from app.fixtures.generator import HOURS  # noqa: E402
from app.services.optimizer import solve  # noqa: E402


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO_ROOT / "backend_truth.json"

    truth: dict[str, dict] = {}
    for fixture in FIXTURES:
        r = solve(fixture)
        # The API drops a lever that did nothing: its window collapses to zero
        # length, which the contract forbids and which would put an action with
        # no magnitude in front of a human. The fixtures do the same, so the
        # counts only match if this filter is applied on both sides.
        actions = [d for d in fixture.build_actions(r) if d["end_time"] > d["start_time"]]
        truth[fixture.building["id"]] = {
            "baseline_grid": r.baseline_grid,
            "optimized_grid": r.optimized_grid,
            "optimized_battery": [r.optimized_flows[h]["battery_kw"] for h in range(HOURS)],
            "optimized_ev": [r.optimized_flows[h]["ev_kw"] for h in range(HOURS)],
            "optimized_hvac": [r.optimized_flows[h]["hvac_kw"] for h in range(HOURS)],
            "optimized_soc": [r.optimized_flows[h]["battery_soc_pct"] for h in range(HOURS)],
            "optimized_peak_kw": r.optimized_peak_kw,
            "peak_reduction_kw": r.peak_reduction_kw,
            "savings_usd": r.savings_usd,
            "actions": actions,
        }
        print(
            f"{fixture.building['id']:<18} {r.baseline_peak_kw:>7.1f} -> "
            f"{r.optimized_peak_kw:>7.1f} kW  ${r.savings_usd:>6.2f}  {len(actions)} actions"
        )

    out.write_text(json.dumps(truth, indent=1), encoding="utf-8")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
