"""
GridShift Component 2 — model training, comparison and persistence.

Chronological split only (70 / 15 / 15). Never shuffle time series.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import (
    GradientBoostingRegressor,
    HistGradientBoostingRegressor,
    RandomForestRegressor,
)

from evaluation.metrics import comparison_table, regression_metrics

try:  # optional dependency
    from lightgbm import LGBMRegressor

    HAS_LIGHTGBM = True
except ImportError:  # pragma: no cover
    HAS_LIGHTGBM = False

RANDOM_STATE = 42


class Naive24:
    """Baseline: load(t) = load(t - 24h). Reads the `load_lag_24` feature."""

    name = "Naive-24h"

    def fit(self, X, y=None):
        if "load_lag_24" not in X.columns:
            raise ValueError("Naive24 requires the 'load_lag_24' feature.")
        return self

    def predict(self, X) -> np.ndarray:
        return X["load_lag_24"].to_numpy(dtype=float)


def build_models() -> dict[str, Any]:
    models: dict[str, Any] = {
        "Naive-24h": Naive24(),
        "RandomForest": RandomForestRegressor(
            n_estimators=300, min_samples_leaf=2, random_state=RANDOM_STATE, n_jobs=-1
        ),
        "GradientBoosting": GradientBoostingRegressor(random_state=RANDOM_STATE),
        "HistGradientBoosting": HistGradientBoostingRegressor(random_state=RANDOM_STATE),
    }
    if HAS_LIGHTGBM:
        models["LightGBM"] = LGBMRegressor(
            n_estimators=500, learning_rate=0.05, num_leaves=31,
            random_state=RANDOM_STATE, n_jobs=-1, verbose=-1,
        )
    return models


@dataclass
class SplitData:
    X_train: pd.DataFrame
    y_train: pd.Series
    X_val: pd.DataFrame
    y_val: pd.Series
    X_test: pd.DataFrame
    y_test: pd.Series
    ts_train: pd.Series
    ts_val: pd.Series
    ts_test: pd.Series


def chronological_split(X, y, timestamps, train_frac=0.70, val_frac=0.15) -> SplitData:
    n = len(X)
    i_train = int(n * train_frac)
    i_val = int(n * (train_frac + val_frac))
    sl = lambda obj, a, b: obj.iloc[a:b].reset_index(drop=True)  # noqa: E731
    return SplitData(
        sl(X, 0, i_train), sl(y, 0, i_train),
        sl(X, i_train, i_val), sl(y, i_train, i_val),
        sl(X, i_val, n), sl(y, i_val, n),
        sl(timestamps, 0, i_train), sl(timestamps, i_train, i_val), sl(timestamps, i_val, n),
    )


@dataclass
class TrainingResult:
    comparison: pd.DataFrame
    best_name: str
    best_model: Any
    feature_names: list[str] = field(default_factory=list)
    split: SplitData | None = None
    predictions: dict[str, np.ndarray] = field(default_factory=dict)


def train_models(X, y, timestamps, models: dict[str, Any] | None = None) -> TrainingResult:
    split = chronological_split(X, y, timestamps)
    models = models or build_models()

    results: dict[str, dict[str, float]] = {}
    predictions: dict[str, np.ndarray] = {}
    fitted: dict[str, Any] = {}

    for name, model in models.items():
        model.fit(split.X_train, split.y_train)
        val_pred = model.predict(split.X_val)
        test_pred = model.predict(split.X_test)

        row = {f"val_{k}": v for k, v in regression_metrics(split.y_val, val_pred).items()}
        row.update({f"test_{k}": v for k, v in regression_metrics(split.y_test, test_pred).items()})
        results[name] = row
        predictions[name] = test_pred
        fitted[name] = model

    table = comparison_table(results)
    # pick the best LEARNED model on validation MAE (never the naive baseline)
    learned = table.drop(index="Naive-24h", errors="ignore")
    best_name = learned["val_MAE_kW"].idxmin()

    return TrainingResult(
        comparison=table,
        best_name=best_name,
        best_model=fitted[best_name],
        feature_names=list(X.columns),
        split=split,
        predictions=predictions,
    )


def feature_importance(model, feature_names: list[str]) -> pd.DataFrame | None:
    importances = getattr(model, "feature_importances_", None)
    if importances is None:
        return None
    return (
        pd.DataFrame({"feature": feature_names, "importance": importances})
        .sort_values("importance", ascending=False)
        .reset_index(drop=True)
    )


def save_model(result: TrainingResult, path: str | Path, extra: dict | None = None) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    bundle = {
        "model": result.best_model,
        "model_name": result.best_name,
        "feature_names": result.feature_names,
        "trained_on": "synthetic prototype data (TEMPORARY)",
    }
    bundle.update(extra or {})
    joblib.dump(bundle, path)
    return path


def load_model(path: str | Path) -> dict:
    return joblib.load(Path(path))
