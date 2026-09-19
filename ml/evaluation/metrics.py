"""
GridShift Component 2 — evaluation metrics.

Regression metrics are PRIMARY for load forecasting (MAE / RMSE / MAPE / R2).
Peak-event classification metrics (precision / recall / F1) are SECONDARY and
require a peak threshold. GridShift has NOT defined a real threshold yet, so
`provisional_peak_threshold` is a placeholder only.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import (
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    precision_score,
    r2_score,
    recall_score,
)


def mape(y_true, y_pred, eps: float = 1e-6) -> float:
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    mask = np.abs(y_true) > eps
    if not mask.any():
        return float("nan")
    return float(np.mean(np.abs((y_true[mask] - y_pred[mask]) / y_true[mask])) * 100)


def regression_metrics(y_true, y_pred) -> dict[str, float]:
    return {
        "MAE_kW": float(mean_absolute_error(y_true, y_pred)),
        "RMSE_kW": float(np.sqrt(mean_squared_error(y_true, y_pred))),
        "MAPE_pct": mape(y_true, y_pred),
        "R2": float(r2_score(y_true, y_pred)),
    }


def provisional_peak_threshold(y_train, quantile: float = 0.95) -> float:
    """TEMPORARY PROTOTYPE ONLY.

    Derived from the training load distribution because GridShift has not yet
    defined a building-specific peak threshold. Replace with the team value.
    """
    return float(np.quantile(np.asarray(y_train, dtype=float), quantile))


def peak_metrics(y_true, y_pred, threshold: float) -> dict[str, float]:
    true_peak = np.asarray(y_true, dtype=float) >= threshold
    pred_peak = np.asarray(y_pred, dtype=float) >= threshold
    return {
        "threshold_kW": float(threshold),
        "n_true_peaks": int(true_peak.sum()),
        "precision": float(precision_score(true_peak, pred_peak, zero_division=0)),
        "recall": float(recall_score(true_peak, pred_peak, zero_division=0)),
        "f1": float(f1_score(true_peak, pred_peak, zero_division=0)),
    }


def comparison_table(results: dict[str, dict[str, float]]) -> pd.DataFrame:
    """results: {model_name: {metric: value}} -> DataFrame sorted by test MAE."""
    table = pd.DataFrame(results).T
    sort_col = "test_MAE_kW" if "test_MAE_kW" in table.columns else table.columns[0]
    return table.sort_values(sort_col).round(4)
