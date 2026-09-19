/**
 * Shared display formatters.
 *
 * Every component that renders a timestamp, a kW value or a dollar figure
 * should use these so the dashboard reads consistently. Timestamps from the API
 * are ISO 8601 with a timezone offset; these helpers render them in the
 * viewer's local zone, which for the demo is the building's own zone.
 */

/** "2025-09-18T15:00:00-07:00" -> "15:00" */
export function formatHour(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:00`;
}

/** "2025-09-18T15:00:00-07:00" -> "3 PM" (compact chart axis label) */
export function formatHourShort(iso: string): string {
  const h = new Date(iso).getHours();
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

/** 521.6 -> "522 kW" */
export function formatKw(kw: number, digits = 0): string {
  return `${kw.toFixed(digits)} kW`;
}

/** 869.59 -> "$869.59" */
export function formatUsd(usd: number, digits = 2): string {
  return `$${usd.toFixed(digits)}`;
}

/** 0.09 -> "$0.09/kWh" */
export function formatPrice(usdPerKwh: number): string {
  return `$${usdPerKwh.toFixed(2)}/kWh`;
}

/** 82 -> "82%" */
export function formatPct(pct: number, digits = 0): string {
  return `${pct.toFixed(digits)}%`;
}

/** 71 -> "71°F" */
export function formatTempF(f: number): string {
  return `${Math.round(f)}°F`;
}

/** 2312 -> "2.3s"; 840 -> "840ms" */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** "battery_discharge" -> "Battery discharge" */
export function humanizeSnake(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
