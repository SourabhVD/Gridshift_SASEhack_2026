/**
 * Deterministic building-fixture kit.
 *
 * Every number the demo shows is produced here from a handful of control
 * points -- no Math.random anywhere, so two page loads always agree and the
 * charts, the KPI tiles, the flow diagram and the plan cannot drift apart.
 *
 * The one rule the whole file exists to enforce:
 *
 *   grid_kw = base_kw + ev_kw + hvac_kw - solar_kw - battery_kw
 *
 * `battery_kw` is the only signed field: positive means the pack is
 * discharging into the building, negative means it is charging from the grid.
 *
 * Two ways to build an hour:
 *   - grid-pinned:    the grid curve is authored, `baseFromGrid()` solves for
 *                     base_kw. Used when a curve is already published (the
 *                     office baseline) or hand-shaped from control points.
 *   - component-first: base/ev/hvac/solar/battery are authored and
 *                     `gridFromComponents()` derives the grid curve. Used for
 *                     every optimized curve, so an action's kW really is what
 *                     moves the line.
 */

import type {
  Action,
  ActionPlan,
  AgentEvent,
  Building,
  DashboardSummary,
  EnergyFlows,
  ForecastPoint,
  ForecastResponse,
  ImpactPoint,
} from '@/types/api';

/* -------------------------------------------------------------------------- */
/* Calendar                                                                    */
/* -------------------------------------------------------------------------- */

/** Thursday. Pinned so fixtures stay byte-stable across runs. */
export const DEMO_DATE = '2025-09-18';
/** Seattle, PDT. All three buildings share the day and the tariff. */
export const TZ_OFFSET = '-07:00';

export const HOURS = 24;

/** ISO 8601 timestamp for the start of hour `h` on the demo day. */
/**
 * Inclusive start and exclusive end hour spanned by a lever's activity.
 *
 * A lever the optimizer left alone returns [0, 0], which collapses to a
 * zero-length window and is how `makeFixture` knows to drop its action row.
 * Mirrors `action_window` in the backend's fixtures/generator.py, so the two
 * agree on how many actions a plan has.
 */
export function actionWindow(delta: Record<number, number>): [number, number] {
  const active = Object.keys(delta)
    .map(Number)
    .filter((h) => Math.abs(delta[h] ?? 0) > 1e-9)
    .sort((a, b) => a - b);
  if (active.length === 0) return [0, 0];
  return [active[0], Math.min(active[active.length - 1] + 1, HOURS)];
}

export function isoHour(h: number): string {
  return DEMO_DATE + 'T' + String(h).padStart(2, '0') + ':00:00' + TZ_OFFSET;
}

/** The demo's "now". Hours before this have metered actuals. */
export const NOW_HOUR = 10;
export const NOW_ISO = isoHour(NOW_HOUR);

/* -------------------------------------------------------------------------- */
/* Small deterministic math                                                    */
/* -------------------------------------------------------------------------- */

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 24 zeros -- the starting point for every sparse component array. */
export function zeros(): number[] {
  return new Array<number>(HOURS).fill(0);
}

/** 24 copies of `value`. */
export function flat(value: number): number[] {
  return new Array<number>(HOURS).fill(value);
}

/** Writes `value` into `hours` of a fresh copy of `series`. */
export function withHours(series: number[], hours: number[], value: number): number[] {
  const next = [...series];
  for (const h of hours) next[h] = value;
  return next;
}

/** Inclusive-start, exclusive-end hour list: `range(14, 17)` -> [14, 15, 16]. */
export function range(startHour: number, endHour: number): number[] {
  const out: number[] = [];
  for (let h = startHour; h < endHour; h += 1) out.push(h);
  return out;
}

/**
 * A 24-hour curve through sparse `[hour, value]` control points, linearly
 * interpolated between them and held flat outside the first/last point.
 */
export function piecewise(points: Array<[number, number]>): number[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  return Array.from({ length: HOURS }, (_, h) => {
    if (h <= sorted[0][0]) return sorted[0][1];
    const last = sorted[sorted.length - 1];
    if (h >= last[0]) return last[1];
    let i = 0;
    while (sorted[i + 1][0] < h) i += 1;
    const [h0, v0] = sorted[i];
    const [h1, v1] = sorted[i + 1];
    return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
  });
}

/**
 * Clear-day PV curve: a raised cosine that reaches `peakKw` at `peakHour` and
 * touches zero `halfWidthH` hours either side. `exponent` sharpens the
 * shoulders -- 2 gives the usual fat-middle, thin-tails solar shape.
 */
export function solarBell(
  peakKw: number,
  peakHour: number,
  halfWidthH: number,
  exponent = 2,
): number[] {
  return Array.from({ length: HOURS }, (_, h) => {
    const offset = Math.abs(h - peakHour);
    if (offset >= halfWidthH) return 0;
    const c = Math.cos((offset / halfWidthH) * (Math.PI / 2));
    return round1(peakKw * Math.pow(c, exponent));
  });
}

/* -------------------------------------------------------------------------- */
/* Weather -- one Seattle September day, shared by all three sites             */
/* -------------------------------------------------------------------------- */

/** Pinned so that 10:00 reads 71 °F, which is what the office KPI tile shows. */
export const OUTDOOR_TEMP_F: number[] = piecewise([
  [0, 60],
  [4, 55],
  [7, 59],
  [10, 71],
  [13, 77],
  [16, 80],
  [19, 72],
  [21, 66],
  [23, 62],
]).map(round1);

const TEMP_MIN = Math.min(...OUTDOOR_TEMP_F);
const TEMP_MAX = Math.max(...OUTDOOR_TEMP_F);

/** Outdoor temperature normalised to 0..1. Drives the HVAC share of load. */
export const TEMP_SHAPE: number[] = OUTDOOR_TEMP_F.map(
  (t) => (t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN),
);

/* -------------------------------------------------------------------------- */
/* Tariff                                                                      */
/* -------------------------------------------------------------------------- */

/** Seattle City Light style TOU: $0.09/kWh off-peak, $0.16/kWh 14:00-20:00. */
export const PRICE_PER_KWH: number[] = Array.from({ length: HOURS }, (_, h) =>
  h >= 14 && h < 20 ? 0.16 : 0.09,
);

/** Monthly demand charge used for the avoided-demand-charge figure. */
export const DEMAND_CHARGE_USD_PER_KW = 8.5;

export function energyCost(loadKw: number[]): number {
  return loadKw.reduce((sum, kw, h) => sum + kw * PRICE_PER_KWH[h], 0);
}

/* -------------------------------------------------------------------------- */
/* HVAC                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * HVAC is expressed as a share of the hour's grid load, sliding from `dayMin`
 * to `dayMax` with outdoor temperature so the afternoon is chiller-heavy.
 */
export interface HvacShareSpec {
  /** Share outside the occupied band. */
  night: number;
  dayMin: number;
  dayMax: number;
  /** Occupied band, inclusive start / exclusive end. */
  dayStart: number;
  dayEnd: number;
}

export function hvacProfile(grid: number[], spec: HvacShareSpec): number[] {
  return grid.map((kw, h) => {
    const occupied = h >= spec.dayStart && h < spec.dayEnd;
    const share = occupied
      ? spec.dayMin + (spec.dayMax - spec.dayMin) * TEMP_SHAPE[h]
      : spec.night;
    return round1(share * kw);
  });
}

/* -------------------------------------------------------------------------- */
/* Flow assembly                                                               */
/* -------------------------------------------------------------------------- */

/** The five consumer/source series plus the battery's state of charge. */
export interface FlowComponents {
  base: number[];
  ev: number[];
  hvac: number[];
  solar: number[];
  /** Signed: > 0 discharging into the building, < 0 charging from the grid. */
  battery: number[];
  /** State of charge at the end of each hour. */
  soc: number[];
}

/** Solve the identity for base_kw, given an authored grid curve. */
export function baseFromGrid(
  grid: number[],
  parts: Omit<FlowComponents, 'base' | 'soc'>,
): number[] {
  return grid.map((kw, h) =>
    round1(kw - parts.ev[h] - parts.hvac[h] + parts.solar[h] + parts.battery[h]),
  );
}

/** Solve the identity for grid_kw, given authored consumers and sources. */
export function gridFromComponents(parts: Omit<FlowComponents, 'soc'>): number[] {
  return parts.base.map((kw, h) =>
    round1(kw + parts.ev[h] + parts.hvac[h] - parts.solar[h] - parts.battery[h]),
  );
}

export function toFlows(grid: number[], parts: FlowComponents): EnergyFlows[] {
  return grid.map((kw, h) => ({
    grid_kw: round1(kw),
    solar_kw: round1(parts.solar[h]),
    battery_kw: round1(parts.battery[h]),
    ev_kw: round1(parts.ev[h]),
    hvac_kw: round1(parts.hvac[h]),
    base_kw: round1(parts.base[h]),
    battery_soc_pct: round1(parts.soc[h]),
  }));
}

/** Signed residual of the flow identity, in kW. Zero means consistent. */
export function flowResidual(f: EnergyFlows): number {
  return (
    f.grid_kw -
    (f.base_kw + f.ev_kw + f.hvac_kw - f.solar_kw - f.battery_kw)
  );
}

/**
 * State-of-charge walk. Starts at `startPct`, and every hour the battery moves
 * `battery[h]` kW for one hour, so SOC changes by `-battery[h] / capacity`.
 * Positive kW (discharge) drains, negative kW (charge) fills.
 */
export function socWalk(
  battery: number[],
  startPct: number,
  capacityKwh: number,
): number[] {
  let soc = startPct;
  return battery.map((kw) => {
    soc = round1(soc - (kw / capacityKwh) * 100);
    return soc;
  });
}

/** Metered history: deterministic +-0.5% wobble before `untilHour`, null after. */
export function meteredActuals(grid: number[], untilHour: number): (number | null)[] {
  return grid.map((kw, h) =>
    h < untilHour ? round1(kw * (1 + 0.004 * Math.sin(h * 1.7) - 0.005)) : null,
  );
}

/* -------------------------------------------------------------------------- */
/* Agent script                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One scripted agent event. `offset_ms` is how long after the run starts the
 * event becomes visible; mockServer.ts replays it in real time.
 */
export interface ScriptedEvent extends Omit<AgentEvent, 'id' | 'run_id' | 'timestamp'> {
  offset_ms: number;
}

/**
 * Reveal schedule shared by all three buildings: 14 events over 16.8 s, one
 * every 1.2 s except the optimizer call, which is given 2.4 s to "think".
 */
export const SCRIPT_OFFSETS_MS = [
  0, 1200, 2400, 3600, 4800, 6000, 7200, 8400, 9600, 12000, 13200, 14400, 15600,
  16800,
];

/** Stamps the shared offsets onto 14 authored events, keeping seq in step. */
export function scheduleScript(
  events: Array<Omit<ScriptedEvent, 'offset_ms' | 'seq'>>,
): ScriptedEvent[] {
  return events.map((event, i) => ({
    ...event,
    seq: i + 1,
    offset_ms: SCRIPT_OFFSETS_MS[i],
  }));
}

/* -------------------------------------------------------------------------- */
/* Fixture assembly                                                            */
/* -------------------------------------------------------------------------- */

/** Everything the mock server needs to serve one building. */
export interface BuildingFixture {
  building: Building;
  baselineGrid: number[];
  optimizedGrid: number[];
  baselineFlows: EnergyFlows[];
  optimizedFlows: EnergyFlows[];
  baselinePeakKw: number;
  baselinePeakHour: number;
  optimizedPeakKw: number;
  peakReductionKw: number;
  baselineCostUsd: number;
  optimizedCostUsd: number;
  savingsUsd: number;
  demandChargeAvoidedUsd: number;
  script: ScriptedEvent[];
  buildSummary: () => DashboardSummary;
  buildForecast: () => ForecastResponse;
  buildPlan: (runId: string) => ActionPlan;
}

/** The per-building inputs `makeFixture` turns into a BuildingFixture. */
export interface FixtureSpec {
  building: Building;
  baselineGrid: number[];
  baselineParts: FlowComponents;
  /** Optimized components. The optimized grid is derived from them... */
  optimizedParts: FlowComponents;
  /** ...unless a published curve pins it, in which case base_kw absorbs it. */
  pinnedOptimizedGrid?: number[];
  actualLoadKw: (number | null)[];
  /** kWh pushed back into the pack outside the modelled window, billed off-peak. */
  batteryRechargeKwh: number;
  summary: Omit<
    DashboardSummary,
    | 'building_id'
    | 'building_type'
    | 'building_name'
    | 'timestamp'
    | 'predicted_peak_kw'
    | 'predicted_peak_time'
    | 'peak_threshold_kw'
    | 'battery_capacity_kwh'
    | 'battery_max_kw'
    | 'electricity_price_per_kwh'
  >;
  planSummary: string;
  buildActions: (runId: string) => Action[];
  script: ScriptedEvent[];
}

export function makeFixture(spec: FixtureSpec): BuildingFixture {
  const { building, baselineGrid, baselineParts, optimizedParts } = spec;

  // A pinned optimized curve wins; base_kw is re-solved so the identity holds.
  const optimizedGrid = spec.pinnedOptimizedGrid
    ? spec.pinnedOptimizedGrid.map(round1)
    : gridFromComponents(optimizedParts);
  const optimizedResolved: FlowComponents = spec.pinnedOptimizedGrid
    ? { ...optimizedParts, base: baseFromGrid(optimizedGrid, optimizedParts) }
    : optimizedParts;

  const baselineFlows = toFlows(baselineGrid, baselineParts);
  const optimizedFlows = toFlows(optimizedGrid, optimizedResolved);

  const baselinePeakKw = Math.max(...baselineGrid);
  const baselinePeakHour = baselineGrid.indexOf(baselinePeakKw);
  const optimizedPeakKw = Math.max(...optimizedGrid);
  const peakReductionKw = round1(baselinePeakKw - optimizedPeakKw);

  const baselineCostUsd = round2(energyCost(baselineGrid));
  const optimizedCostUsd = round2(
    energyCost(optimizedGrid) + spec.batteryRechargeKwh * PRICE_PER_KWH[0],
  );
  const savingsUsd = round2(baselineCostUsd - optimizedCostUsd);
  const demandChargeAvoidedUsd = round2(peakReductionKw * DEMAND_CHARGE_USD_PER_KW);

  function buildSummary(): DashboardSummary {
    return {
      building_id: building.id,
      building_type: building.type,
      building_name: building.name,
      timestamp: NOW_ISO,
      predicted_peak_kw: baselinePeakKw,
      predicted_peak_time: isoHour(baselinePeakHour),
      peak_threshold_kw: building.peak_threshold_kw,
      battery_capacity_kwh: building.battery_capacity_kwh,
      battery_max_kw: building.battery_max_kw,
      electricity_price_per_kwh: PRICE_PER_KWH[NOW_HOUR],
      ...spec.summary,
    };
  }

  function buildForecast(): ForecastResponse {
    const points: ForecastPoint[] = baselineGrid.map((kw, h) => ({
      timestamp: isoHour(h),
      predicted_load_kw: kw,
      actual_load_kw: spec.actualLoadKw[h],
      price_per_kwh: PRICE_PER_KWH[h],
      is_peak: kw > building.peak_threshold_kw,
      flows: baselineFlows[h],
    }));

    return {
      building_name: building.name,
      generated_at: NOW_ISO,
      peak_threshold_kw: building.peak_threshold_kw,
      points,
    };
  }

  function buildImpact(): ImpactPoint[] {
    return baselineGrid.map((kw, h) => ({
      timestamp: isoHour(h),
      baseline_kw: kw,
      optimized_kw: optimizedGrid[h],
      baseline_flows: baselineFlows[h],
      optimized_flows: optimizedFlows[h],
    }));
  }

  function buildPlan(runId: string): ActionPlan {
    return {
      run_id: runId,
      status: 'awaiting_approval',
      created_at: NOW_ISO,
      summary: spec.planSummary,
      baseline_peak_kw: baselinePeakKw,
      optimized_peak_kw: optimizedPeakKw,
      peak_reduction_kw: peakReductionKw,
      baseline_cost_usd: baselineCostUsd,
      optimized_cost_usd: optimizedCostUsd,
      savings_usd: savingsUsd,
      // A lever the optimizer left alone gets no row. Its window collapses to
      // zero length, which the contract forbids (end_time must be after
      // start_time) and which would render as an action a human is asked to
      // approve when nothing actually happens. The backend drops these in
      // build_plan for the same reason, so the two agree on the count.
      actions: spec.buildActions(runId).filter((a) => a.end_time > a.start_time),
      impact: buildImpact(),
    };
  }

  return {
    building,
    baselineGrid,
    optimizedGrid,
    baselineFlows,
    optimizedFlows,
    baselinePeakKw,
    baselinePeakHour,
    optimizedPeakKw,
    peakReductionKw,
    baselineCostUsd,
    optimizedCostUsd,
    savingsUsd,
    demandChargeAvoidedUsd,
    script: spec.script,
    buildSummary,
    buildForecast,
    buildPlan,
  };
}
