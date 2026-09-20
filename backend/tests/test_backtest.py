"""
The backtest forecast mode.

`ml/evaluate_forecast_date.py` writes a directory per date; this backend reads
it and never touches the database. These tests build that directory from
scratch, so they need no credential, no network and no ml dependencies -- which
is also the point of the reader using only the standard library.

The numbers here are deliberately on the real building's scale (tens of kW)
rather than the demo office's (hundreds), because that mismatch is the whole
reason the served curve is mapped onto the site's own peak. The first cut of
this mode published the raw kW and produced a dashboard that contradicted
itself: a 73 kW forecast beside a 522 kW impact chart, on two different dates,
with the agent reporting no peak at all.
"""

from __future__ import annotations

import csv
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.fixtures import get_fixture
from app.fixtures.generator import NOW_HOUR
from app.services import backtest as backtest_reader
from app.services import forecast as forecast_service
from .conftest import poll_until_complete

OFFICE = "sea-office-001"
WAREHOUSE = "sea-warehouse-003"
DATE = "2018-07-15"
ZONE = "America/Los_Angeles"

#: A plausible summer weekday for a 46,000 sq ft office, in kW.
PREDICTED = [
    31.2, 29.8, 29.1, 28.7, 28.9, 31.4, 38.6, 49.2,
    58.1, 63.4, 66.9, 69.2, 70.8, 71.6, 72.9, 73.4,
    70.1, 64.8, 55.3, 46.2, 40.1, 36.4, 33.8, 32.0,
]
ACTUAL = [round(v * 1.04 + 0.6, 1) for v in PREDICTED]
THRESHOLD = 68.5


def write_backtest(
    root: Path,
    date: str = DATE,
    *,
    predicted: list[float] | None = None,
    actual: list[float] | None = None,
    threshold: float | None = THRESHOLD,
    zone: str = ZONE,
) -> Path:
    """Reproduce exactly what evaluate_forecast_date leaves behind."""
    predicted = PREDICTED if predicted is None else predicted
    actual = ACTUAL if actual is None else actual

    directory = root / date
    directory.mkdir(parents=True, exist_ok=True)

    # The harness writes UTC timestamps, as pandas renders a tz-aware column.
    # Local midnight on a July day in Los Angeles is 07:00 UTC.
    start = datetime.fromisoformat(f"{date}T07:00:00+00:00")
    with (directory / "forecast_vs_actual.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["timestamp", "predicted_load_kw", "actual_load_kw", "error_kw", "absolute_error_kw"]
        )
        for hour in range(24):
            stamp = (start + timedelta(hours=hour)).astimezone(timezone.utc)
            error = actual[hour] - predicted[hour]
            writer.writerow(
                [
                    stamp.strftime("%Y-%m-%d %H:%M:%S+00:00"),
                    predicted[hour],
                    actual[hour],
                    round(error, 4),
                    round(abs(error), 4),
                ]
            )

    metrics: dict[str, object] = {"MAE_kW": 2.9, "RMSE_kW": 3.8}
    if threshold is not None:
        metrics["peak_threshold_kw"] = threshold
    (directory / "metrics.json").write_text(json.dumps(metrics), encoding="utf-8")

    (directory / "metadata.json").write_text(
        json.dumps(
            {
                "forecast_date_local": date,
                "building_id": "6ee36e26-40d4-5408-b93a-840ad2fdd412",
                "timezone": zone,
                "algorithm": "LightGBM",
            }
        ),
        encoding="utf-8",
    )
    return directory


@pytest.fixture()
def backtest_mode(tmp_path, monkeypatch):
    """Serve the backtest for the office, from a directory built here."""
    root = tmp_path / "backtests"
    write_backtest(root)

    monkeypatch.setenv("GRIDSHIFT_FORECAST", "backtest")
    monkeypatch.setenv("GRIDSHIFT_BACKTEST_PATH", str(root))
    monkeypatch.setenv("GRIDSHIFT_BACKTEST_DATE", "")
    monkeypatch.setenv("GRIDSHIFT_BACKTEST_BUILDING", OFFICE)
    get_settings.cache_clear()
    forecast_service._BACKTEST_WARNED = False
    yield root
    get_settings.cache_clear()
    forecast_service._BACKTEST_WARNED = False


# --------------------------------------------------------------------------- #
# The reader                                                                   #
# --------------------------------------------------------------------------- #


def test_reader_orders_rows_by_local_hour(tmp_path) -> None:
    """UTC in the file, building-local hours out of it."""
    root = tmp_path / "backtests"
    write_backtest(root)

    result = backtest_reader.load(root)

    assert result.date == DATE
    assert result.timezone == ZONE
    assert result.utc_offset == "-07:00"           # July, so daylight time
    assert result.algorithm == "LightGBM"
    assert result.predicted_kw == PREDICTED         # index 0 is local midnight
    assert result.actual_kw == ACTUAL
    assert result.threshold_kw == THRESHOLD


def test_reader_picks_the_latest_date_and_honours_an_explicit_one(tmp_path) -> None:
    root = tmp_path / "backtests"
    write_backtest(root, "2018-07-15")
    write_backtest(root, "2018-11-02")

    assert backtest_reader.available(root) == ["2018-07-15", "2018-11-02"]
    assert backtest_reader.load(root).date == "2018-11-02"
    assert backtest_reader.load(root, "2018-07-15").date == "2018-07-15"


def test_reader_reads_the_offset_off_the_date(tmp_path) -> None:
    """A winter day is -08:00, without a table of special cases."""
    root = tmp_path / "backtests"
    directory = root / "2018-12-05"
    directory.mkdir(parents=True)
    start = datetime.fromisoformat("2018-12-05T08:00:00+00:00")   # local midnight, PST
    with (directory / "forecast_vs_actual.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["timestamp", "predicted_load_kw", "actual_load_kw"])
        for hour in range(24):
            stamp = start + timedelta(hours=hour)
            writer.writerow(
                [stamp.strftime("%Y-%m-%d %H:%M:%S+00:00"), PREDICTED[hour], ACTUAL[hour]]
            )
    (directory / "metadata.json").write_text(
        json.dumps({"timezone": ZONE, "algorithm": "LightGBM", "building_id": "x"}),
        encoding="utf-8",
    )

    assert backtest_reader.load(root, "2018-12-05").utc_offset == "-08:00"


@pytest.mark.parametrize(
    "break_it",
    [
        pytest.param(lambda d: (d / "forecast_vs_actual.csv").unlink(), id="no-csv"),
        pytest.param(
            lambda d: (d / "metadata.json").write_text(
                json.dumps({"forecast_date_local": "2019-01-01"}), encoding="utf-8"
            ),
            id="date-disagrees-with-directory",
        ),
        pytest.param(
            lambda d: (d / "forecast_vs_actual.csv").write_text(
                "timestamp,predicted_load_kw,actual_load_kw\n", encoding="utf-8"
            ),
            id="empty-csv",
        ),
        pytest.param(
            lambda d: (d / "forecast_vs_actual.csv").write_text(
                "timestamp,predicted_load_kw,actual_load_kw\n"
                "2018-07-15 07:00:00+00:00,not-a-number,40\n",
                encoding="utf-8",
            ),
            id="non-numeric",
        ),
        pytest.param(
            lambda d: (d / "forecast_vs_actual.csv").write_text(
                "timestamp,predicted_load_kw,actual_load_kw\n"
                "2018-07-15 07:00:00+00:00,-5,40\n",
                encoding="utf-8",
            ),
            id="negative-load",
        ),
    ],
)
def test_reader_refuses_a_broken_directory(tmp_path, break_it) -> None:
    """Anything malformed raises, and every caller reads that as 'fall back'."""
    root = tmp_path / "backtests"
    break_it(write_backtest(root))

    with pytest.raises(backtest_reader.BacktestUnavailable):
        backtest_reader.load(root)


def test_reader_treats_metadata_as_optional(tmp_path) -> None:
    """
    The CSV is the contract; metadata only enriches it.

    The offset comes from the first row measured against the directory's date,
    so a missing metadata.json costs the algorithm name and nothing else. That
    is also why reading this needs no timezone database, which Python does not
    ship on Windows.
    """
    root = tmp_path / "backtests"
    (write_backtest(root) / "metadata.json").unlink()

    result = backtest_reader.load(root)

    assert result.predicted_kw == PREDICTED
    assert result.utc_offset == "-07:00"
    assert result.algorithm == "unknown"
    assert result.timezone == ""


def test_reader_rejects_a_short_day(tmp_path) -> None:
    root = tmp_path / "backtests"
    directory = write_backtest(root)
    lines = (directory / "forecast_vs_actual.csv").read_text(encoding="utf-8").splitlines()
    (directory / "forecast_vs_actual.csv").write_text(
        "\n".join(lines[:-3]) + "\n", encoding="utf-8"
    )

    with pytest.raises(backtest_reader.BacktestUnavailable, match="21 rows"):
        backtest_reader.load(root)


def test_reader_falls_back_on_a_file_that_is_not_utf8(tmp_path) -> None:
    """
    Decoding happens lazily inside csv.DictReader, so it raises ValueError,
    not OSError. Catching only OSError let a UnicodeDecodeError escape to the
    route as a 500 on every request, with /health still reporting green.
    """
    root = tmp_path / "backtests"
    path = write_backtest(root) / "forecast_vs_actual.csv"
    path.write_bytes(path.read_bytes().replace(b"LightGBM", b"") + b"\xe9\xff\xfe")

    with pytest.raises(backtest_reader.BacktestUnavailable):
        backtest_reader.load(root)


def test_reader_falls_back_on_a_truncated_row(tmp_path) -> None:
    """
    csv.DictReader fills a short row's missing fields with None, and the header
    check cannot see it because the key is present. `.strip()` on that None
    raised AttributeError straight out of the request.
    """
    root = tmp_path / "backtests"
    path = write_backtest(root) / "forecast_vs_actual.csv"
    # A leading index column, as df.to_csv(path) without index=False writes,
    # then a line cut off after it.
    lines = path.read_text(encoding="utf-8").splitlines()
    body = [",".join([str(i), line]) for i, line in enumerate(lines[1:])]
    path.write_text(
        ",".join(["", "timestamp", "predicted_load_kw", "actual_load_kw", "error_kw", "absolute_error_kw"])
        + "\n"
        + "\n".join(body)
        + "\n23\n",
        encoding="utf-8",
    )

    with pytest.raises(backtest_reader.BacktestUnavailable):
        backtest_reader.load(root)


def test_a_broken_file_falls_back_instead_of_500ing(backtest_mode, client: TestClient) -> None:
    """The end-to-end guarantee: a corrupt directory never fails a request."""
    path = backtest_mode / DATE / "forecast_vs_actual.csv"
    path.write_bytes(b"\xff\xfe\x00not a csv at all\x00")
    forecast_service._BACKTEST_WARNED = False

    for url, params in (
        ("/api/forecast", {"building_id": OFFICE}),
        ("/api/dashboard/summary", {"building_id": OFFICE}),
    ):
        response = client.get(url, params=params)
        assert response.status_code == 200, f"{url} returned {response.status_code}"

    served = client.get("/api/forecast", params={"building_id": OFFICE}).json()
    assert [p["predicted_load_kw"] for p in served["points"]] == list(
        get_fixture(OFFICE).baseline_grid
    )


def test_reader_rejects_a_gap_in_the_day(tmp_path) -> None:
    """A duplicated hour keeps the row count right and is still not a day."""
    root = tmp_path / "backtests"
    path = write_backtest(root) / "forecast_vs_actual.csv"
    lines = path.read_text(encoding="utf-8").splitlines()
    lines[-1] = lines[-2]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with pytest.raises(backtest_reader.BacktestUnavailable, match="contiguous"):
        backtest_reader.load(root)


# --------------------------------------------------------------------------- #
# The service                                                                  #
# --------------------------------------------------------------------------- #


def test_forecast_serves_the_real_shape_on_the_site_scale(backtest_mode, client: TestClient) -> None:
    """
    The model's day drives the chart, mapped onto this site's own peak.

    Publishing the raw kW put a 73 kW forecast beside a 522 kW impact chart,
    because the optimizer's levers, the device facts and the agent's narration
    are all authored at the site's scale. Both series are multiplied by one
    factor instead, so the shape and the model's relative error survive exactly.
    """
    fixture = get_fixture(OFFICE)
    body = client.get("/api/forecast", params={"building_id": OFFICE}).json()
    grid = [p["predicted_load_kw"] for p in body["points"]]

    assert max(grid) == pytest.approx(max(fixture.baseline_grid), abs=0.1)
    assert body["peak_threshold_kw"] == fixture.peak_threshold_kw

    # The shape is the model's, not the fixture's: same argmax hour, same
    # normalised curve, to rounding.
    assert grid.index(max(grid)) == PREDICTED.index(max(PREDICTED))
    scale = max(fixture.baseline_grid) / max(PREDICTED)
    assert grid == [round(v * scale, 1) for v in PREDICTED]

    # Measured load stops at "now", the way metered_actuals does.
    measured = [p["actual_load_kw"] for p in body["points"]]
    assert measured[:NOW_HOUR] == [round(v * scale, 1) for v in ACTUAL[:NOW_HOUR]]
    assert all(v is None for v in measured[NOW_HOUR:])

    # The relative error is the model's real one, unchanged by the mapping.
    real_wape = sum(abs(a - p) for a, p in zip(ACTUAL, PREDICTED)) / sum(ACTUAL)
    served_wape = sum(
        abs(measured[h] - grid[h]) for h in range(NOW_HOUR)
    ) / sum(measured[:NOW_HOUR])
    reference = sum(abs(ACTUAL[h] - PREDICTED[h]) for h in range(NOW_HOUR)) / sum(
        ACTUAL[:NOW_HOUR]
    )
    assert served_wape == pytest.approx(reference, rel=1e-3)
    assert real_wape > 0


def test_the_whole_app_stays_on_one_scale_and_one_day(backtest_mode, client: TestClient) -> None:
    """
    The forecast, the summary and the plan must not contradict each other.

    This is the invariant the first cut of this mode broke: a real-kW forecast
    next to a fixture-scale plan, on two different calendar days.
    """
    forecast = client.get("/api/forecast", params={"building_id": OFFICE}).json()
    summary = client.get("/api/dashboard/summary", params={"building_id": OFFICE}).json()

    run_id = client.post("/api/gridshift/run", json={"building_id": OFFICE}).json()["run_id"]
    poll_until_complete(client, run_id)
    plan = client.get(f"/api/gridshift/{run_id}/plan").json()

    day = forecast["points"][0]["timestamp"][:10]
    assert summary["timestamp"].startswith(day)
    assert all(p["timestamp"].startswith(day) for p in plan["impact"])

    forecast_peak = max(p["predicted_load_kw"] for p in forecast["points"])
    baseline_peak = max(p["baseline_kw"] for p in plan["impact"])
    assert baseline_peak == pytest.approx(forecast_peak, rel=0.25)

    # And the agent's own view of the day agrees with the endpoint's. The
    # tool_result event carries the tool's output; tool_call carries its args.
    events = client.get(f"/api/gridshift/{run_id}/events").json()["events"]
    result = next(
        e["payload"]
        for e in events
        if e["type"] == "tool_result" and e["tool_name"] == "get_energy_forecast"
    )
    assert result["threshold_kw"] == forecast["peak_threshold_kw"]
    assert result["peak_kw"] == pytest.approx(forecast_peak, abs=0.1)
    assert result["peak_time"].startswith(day)


def test_flow_identity_holds(backtest_mode, client: TestClient) -> None:
    body = client.get("/api/forecast", params={"building_id": OFFICE}).json()

    for point in body["points"]:
        flows = point["flows"]
        residual = flows["grid_kw"] - (
            flows["base_kw"]
            + flows["ev_kw"]
            + flows["hvac_kw"]
            - flows["solar_kw"]
            - flows["battery_kw"]
        )
        assert abs(residual) < 0.05, point["timestamp"]
        assert flows["grid_kw"] == pytest.approx(point["predicted_load_kw"], abs=0.05)
        for field in ("base_kw", "ev_kw", "hvac_kw", "solar_kw"):
            assert flows[field] >= 0, f"{field} went negative at {point['timestamp']}"


def test_summary_agrees_with_the_forecast(backtest_mode, client: TestClient) -> None:
    """One curve feeds both payloads, so the tiles cannot contradict the chart."""
    summary = client.get("/api/dashboard/summary", params={"building_id": OFFICE}).json()
    forecast = client.get("/api/forecast", params={"building_id": OFFICE}).json()

    peak = max(forecast["points"], key=lambda p: p["predicted_load_kw"])
    assert summary["predicted_peak_kw"] == peak["predicted_load_kw"]
    assert summary["predicted_peak_time"] == peak["timestamp"]
    assert summary["peak_threshold_kw"] == forecast["peak_threshold_kw"]
    assert summary["timestamp"] == forecast["generated_at"]

    # The authored tile is pinned to the fixture's curve; once a model drives
    # the chart it has to follow, or the headline contradicts the line.
    assert summary["current_load_kw"] == forecast["points"][NOW_HOUR]["predicted_load_kw"]


def test_other_buildings_keep_their_fixture_curve(backtest_mode, client: TestClient) -> None:
    """The database holds one building; the rest are untouched, not broken."""
    fixture = get_fixture(WAREHOUSE)
    body = client.get("/api/forecast", params={"building_id": WAREHOUSE}).json()

    assert [p["predicted_load_kw"] for p in body["points"]] == list(fixture.baseline_grid)
    assert body["peak_threshold_kw"] == fixture.peak_threshold_kw


def test_a_missing_backtest_falls_back_instead_of_failing(tmp_path, monkeypatch, client: TestClient) -> None:
    """A dashboard drawing the demo beats one drawing an error page."""
    monkeypatch.setenv("GRIDSHIFT_FORECAST", "backtest")
    monkeypatch.setenv("GRIDSHIFT_BACKTEST_PATH", str(tmp_path / "nothing-here"))
    get_settings.cache_clear()
    forecast_service._BACKTEST_WARNED = False
    try:
        response = client.get("/api/forecast", params={"building_id": OFFICE})
        assert response.status_code == 200
        assert [p["predicted_load_kw"] for p in response.json()["points"]] == list(
            get_fixture(OFFICE).baseline_grid
        )
    finally:
        get_settings.cache_clear()
        forecast_service._BACKTEST_WARNED = False


def test_health_reports_which_day_is_on_screen(backtest_mode, client: TestClient) -> None:
    """The fallback is silent, so health is where you check that it took."""
    body = client.get("/health").json()

    assert body["forecast"] == "backtest"
    assert body["backtest"]["available"] == [DATE]
    assert body["backtest"]["building"] == OFFICE
    assert body["backtest"]["requested_date"] == "latest"
