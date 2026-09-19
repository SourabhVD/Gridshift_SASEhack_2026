import numpy as np
import pandas as pd
import pytest

from ml.day_ahead import direct_features, baseline_features, weather_for_origin, forecast_next_24_hours, recursive_predict
from ml.database_adapter import WEATHER


def sample():
    index = pd.date_range("2018-01-01", periods=500, freq="h", tz="UTC")
    return pd.DataFrame({"load_kw": np.arange(500, dtype=float) + 10,
                         "temperature_c": np.arange(500, dtype=float) / 100,
                         "humidity_pct": 70.0, "wind_speed_mps": 3.0}, index=index)


def test_24_hour_features_never_read_future_load():
    frame = sample()
    before = direct_features(frame.iloc[:400], frame.iloc[400:424], "America/Los_Angeles")
    frame.loc[frame.index[400:], "load_kw"] = 9999999
    after = direct_features(frame.iloc[:400], frame.iloc[400:424], "America/Los_Angeles")
    pd.testing.assert_frame_equal(before, after)
    assert before.iloc[-1].load_lag_24 == 409
    assert before.iloc[0].origin_load_lag_1 == 409


def test_weather_proxy_is_available_at_origin():
    frame = sample()
    before = weather_for_origin(frame, 400, "persistence")
    frame.loc[frame.index[400:], WEATHER] = 999999
    after = weather_for_origin(frame, 400, "persistence")
    pd.testing.assert_frame_equal(before, after)


def test_calendar_uses_building_local_timezone():
    frame = sample()
    features = direct_features(frame.iloc[:400], frame.iloc[400:424], "America/Los_Angeles")
    assert features.iloc[0].hour == frame.index[400].tz_convert("America/Los_Angeles").hour


def test_gaps_and_stale_weather_are_rejected():
    frame = sample()
    with pytest.raises(ValueError, match="regular"):
        direct_features(frame.iloc[:400].drop(frame.index[380]), frame.iloc[400:424], "UTC")
    with pytest.raises(ValueError, match="immediately"):
        direct_features(frame.iloc[:400], frame.iloc[401:425], "UTC")


def test_weekly_baseline_and_nonnegative_forecast():
    frame = sample()
    forecast = forecast_next_24_hours({"name": "naive_168", "timezone": "UTC", "model": None},
                                     frame.iloc[:400], frame.iloc[400:424][WEATHER])
    np.testing.assert_array_equal(forecast.predicted_load_kw, frame.load_kw.iloc[232:256])


def test_recursive_baseline_features_shift_before_target():
    frame = sample()
    features = baseline_features(frame)
    assert features.loc[frame.index[400], "load_lag_1"] == 409
    assert features.loc[frame.index[400], "rolling_mean_3h"] == np.mean([407, 408, 409])


def test_optimized_recursion_matches_full_feature_recomputation():
    class FeatureModel:
        def predict(self, frame):
            return (frame.load_lag_1 * .5 + frame.load_lag_24 * .2
                    + frame.rolling_mean_24h * .2 + frame.rolling_std_24h * .1).to_numpy()
    frame = sample()
    history, future = frame.iloc[:400], frame.iloc[400:424][WEATHER]
    work = pd.concat([history.tail(336), future.assign(load_kw=np.nan)])
    model = FeatureModel()
    for timestamp in future.index:
        work.loc[timestamp, "load_kw"] = model.predict(baseline_features(work).loc[[timestamp]])[0]
    np.testing.assert_allclose(recursive_predict(model, history, future), work.loc[future.index, "load_kw"], rtol=1e-12)
