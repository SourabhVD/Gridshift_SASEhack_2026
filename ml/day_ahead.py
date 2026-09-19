"""Origin-safe 24-hour forecasting and the existing branch's recursive baseline.

Direct features may read observed load only before the forecast origin. This
avoids the short-lag error accumulation of a recursively rolled one-step model.
"""

import numpy as np
import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar
from lightgbm import LGBMRegressor

WEATHER = ["temperature_c", "humidity_pct", "wind_speed_mps"]
HISTORY_HOURS = 336
HORIZON = 24


def validate_history_future(history, future):
    if len(history) < HISTORY_HOURS or len(future) != HORIZON:
        raise ValueError("Need 336 observed hourly loads and exactly 24 future weather hours")
    for frame in (history, future):
        if not isinstance(frame.index, pd.DatetimeIndex) or frame.index.tz is None:
            raise ValueError("Use timezone-aware timestamp indexes")
        if frame.index.has_duplicates or not frame.index.is_monotonic_increasing:
            raise ValueError("Timestamps must be unique and increasing")
        if not (frame.index.to_series().diff().dropna() == pd.Timedelta(hours=1)).all():
            raise ValueError("History/future must be regular hourly data")
    if future.index[0] != history.index[-1] + pd.Timedelta(hours=1):
        raise ValueError("Future weather must immediately follow observed load history")
    if not np.isfinite(history.load_kw.tail(HISTORY_HOURS)).all():
        raise ValueError("Missing/nonfinite recent load")


def calendar(index, timezone):
    local = index.tz_convert(timezone)
    out = pd.DataFrame(index=index)
    out["hour"] = local.hour
    out["day_of_week"] = local.dayofweek
    out["day_of_year"] = local.dayofyear
    out["month"] = local.month
    out["is_weekend"] = (local.dayofweek >= 5).astype(int)
    out["hour_sin"] = np.sin(2 * np.pi * local.hour / 24)
    out["hour_cos"] = np.cos(2 * np.pi * local.hour / 24)
    out["dow_sin"] = np.sin(2 * np.pi * local.dayofweek / 7)
    out["dow_cos"] = np.cos(2 * np.pi * local.dayofweek / 7)
    return out


def weather_features(frame):
    out = frame[WEATHER].copy()
    out["temperature_squared"] = out.temperature_c ** 2
    out["heating_degree"] = (18 - out.temperature_c).clip(lower=0)
    out["cooling_degree"] = (out.temperature_c - 18).clip(lower=0)
    return out


def direct_features(history, future, timezone):
    validate_history_future(history, future)
    out = pd.concat([calendar(future.index, timezone), weather_features(future)], axis=1)
    local = future.index.tz_convert(timezone).tz_localize(None)
    holidays = USFederalHolidayCalendar().holidays(local.min().normalize(), local.max().normalize())
    out["is_federal_holiday"] = local.normalize().isin(holidays).astype(int)
    out["horizon_hour"] = np.arange(1, HORIZON + 1)
    loads = history.load_kw
    for lag in (24, 48, 168, 336):
        out[f"load_lag_{lag}"] = loads.reindex(future.index - pd.Timedelta(hours=lag)).to_numpy()
    for lag in (1, 2, 3, 24):
        out[f"origin_load_lag_{lag}"] = float(loads.iloc[-lag])
    for window in (6, 24, 168, 336):
        out[f"origin_mean_{window}"] = loads.tail(window).mean()
        out[f"origin_std_{window}"] = loads.tail(window).std()
    out["weekly_change"] = out.load_lag_168 - out.load_lag_336
    for field in WEATHER:
        out[f"{field}_last_week"] = history[field].reindex(future.index - pd.Timedelta(hours=168)).to_numpy()
    out["temperature_change_week"] = out.temperature_c - out.temperature_c_last_week
    return out


def baseline_features(frame):
    # Reproduce the reviewed feature/ml-forecasting branch's feature set. UTC is
    # what that implementation sees when supplied a UTC database contract frame.
    out = pd.concat([frame[WEATHER], calendar(frame.index, "UTC")], axis=1)
    extras = weather_features(frame)
    out = pd.concat([out, extras.drop(columns=WEATHER)], axis=1)
    for lag in (1, 2, 3, 24, 48, 168):
        out[f"load_lag_{lag}"] = frame.load_kw.shift(lag)
    past = frame.load_kw.shift(1)
    for window in (3, 6, 24):
        out[f"rolling_mean_{window}h"] = past.rolling(window).mean()
    out["rolling_std_24h"] = past.rolling(24).std()
    return out


def estimator(**overrides):
    params = dict(n_estimators=500, learning_rate=0.05, num_leaves=31,
                  random_state=42, n_jobs=2, verbose=-1)
    params.update(overrides)
    return LGBMRegressor(**params)


def recursive_predict(model, history, future):
    validate_history_future(history, future)
    work = pd.concat([history.tail(HISTORY_HOURS), future.assign(load_kw=np.nan)])
    # Calendar/weather and lags >=24 stay fixed across this horizon. Recompute
    # only short lags and rolling summaries after each recursive prediction.
    fixed = baseline_features(work).loc[future.index]
    loads = history.load_kw.tail(HISTORY_HOURS).tolist()
    predictions = []
    for timestamp in future.index:
        features = fixed.loc[[timestamp]].copy()
        for lag in (1, 2, 3):
            features[f"load_lag_{lag}"] = loads[-lag]
        for window in (3, 6, 24):
            features[f"rolling_mean_{window}h"] = np.mean(loads[-window:])
        features["rolling_std_24h"] = np.std(loads[-24:], ddof=1)
        value = max(0, float(model.predict(features)[0]))
        loads.append(value)
        predictions.append(value)
    return np.asarray(predictions)


def forecast_next_24_hours(bundle, history, future_weather):
    validate_history_future(history, future_weather)
    name = bundle["name"]
    if name == "recursive_lightgbm":
        values = recursive_predict(bundle["model"], history, future_weather)
    else:
        features = direct_features(history, future_weather, bundle["timezone"])
        if name == "naive_24":
            values = features.load_lag_24.to_numpy()
        elif name == "naive_168":
            values = features.load_lag_168.to_numpy()
        else:
            values = bundle["model"].predict(features)
            if name.startswith("residual_"):
                values = values + features.load_lag_168.to_numpy()
    return pd.DataFrame({"timestamp": future_weather.index, "predicted_load_kw": np.maximum(0, values)})


def weather_for_origin(frame, origin, mode):
    future = frame.iloc[origin:origin + HORIZON][WEATHER].copy()
    if mode == "persistence":
        # A forecast proxy obtainable at issue time; no future observations used.
        future.loc[:, WEATHER] = frame.iloc[origin - 168:origin - 168 + HORIZON][WEATHER].to_numpy()
    elif mode != "observed":
        raise ValueError("Unknown weather scenario")
    return future


def training_matrix(frame, timezone):
    pieces, targets = [], []
    for origin in range(HISTORY_HOURS, len(frame) - HORIZON + 1, HORIZON):
        pieces.append(direct_features(frame.iloc[:origin], frame.iloc[origin:origin + HORIZON][WEATHER], timezone))
        targets.append(frame.load_kw.iloc[origin:origin + HORIZON])
    if not pieces:
        raise ValueError("Insufficient training history")
    return pd.concat(pieces), pd.concat(targets)


CANDIDATES = ("naive_24", "naive_168", "recursive_lightgbm", "direct_lightgbm", "residual_regularized", "residual_shallow")


def fit_candidates(frame, timezone, names=CANDIDATES):
    direct_x, direct_y = training_matrix(frame, timezone)
    result = {}
    for name in names:
        model = None
        if name == "recursive_lightgbm":
            features = baseline_features(frame).iloc[168:]
            valid = features.notna().all(axis=1)
            model = estimator().fit(features.loc[valid], frame.load_kw.reindex(features.index).loc[valid])
        elif name == "direct_lightgbm":
            model = estimator().fit(direct_x, direct_y)
        elif name.startswith("residual_"):
            params = {"num_leaves": 15, "reg_lambda": 10, "min_child_samples": 40}
            if name == "residual_shallow":
                params.update(num_leaves=7, reg_lambda=20, n_estimators=300)
            model = estimator(**params).fit(direct_x, direct_y - direct_x.load_lag_168)
        result[name] = {"name": name, "model": model, "timezone": timezone}
    return result
