/**
 * The building registry.
 *
 * Three Seattle sites on the same September weekday, same tariff, same "now".
 * The office is the default and is byte-identical to the original single-
 * building demo; the hospital and the warehouse exist to give the flow diagram
 * and the building selector something with a different shape to say.
 */

import type { Building, EnergyFlows } from '@/types/api';
import { flowResidual, round1, type BuildingFixture } from './shared';
import { OFFICE_ID, officeFixture } from './office';
import { HOSPITAL_ID, hospitalFixture } from './hospital';
import { WAREHOUSE_ID, warehouseFixture } from './warehouse';

export { OFFICE_ID, HOSPITAL_ID, WAREHOUSE_ID };
export type { BuildingFixture };

/** The building the app opens on when nothing is stored. */
export const DEFAULT_BUILDING_ID = OFFICE_ID;

/** Registry order is UI order: the default first. */
export const FIXTURES: readonly BuildingFixture[] = [
  officeFixture,
  hospitalFixture,
  warehouseFixture,
];

const BY_ID = new Map<string, BuildingFixture>(
  FIXTURES.map((fixture) => [fixture.building.id, fixture]),
);

export const BUILDINGS: readonly Building[] = FIXTURES.map((f) => f.building);

export function isKnownBuilding(id: string): boolean {
  return BY_ID.has(id);
}

/** Returns undefined for an unknown id; callers decide whether that is a 404. */
export function getFixture(id: string): BuildingFixture | undefined {
  return BY_ID.get(id);
}

/* -------------------------------------------------------------------------- */
/* Dev-time self-check                                                         */
/* -------------------------------------------------------------------------- */

/** Anything the flow identity or the published curves disagree about. */
export interface FixtureViolation {
  building_id: string;
  hour: number;
  check: string;
  expected: number;
  actual: number;
  residual: number;
}

export interface FixtureReport {
  violations: FixtureViolation[];
  /** Largest absolute residual seen across every check, in kW. */
  maxResidual: number;
}

/** Half a rounding step: flows are published to 0.1 kW. */
const TOLERANCE_KW = 0.05;

function checkFlows(
  buildingId: string,
  hour: number,
  check: string,
  flows: EnergyFlows,
): { violation: FixtureViolation | null; residual: number } {
  const residual = flowResidual(flows);
  if (Math.abs(residual) <= TOLERANCE_KW) return { violation: null, residual };
  return {
    violation: {
      building_id: buildingId,
      hour,
      check,
      expected: flows.grid_kw,
      actual: round1(flows.grid_kw - residual),
      residual,
    },
    residual,
  };
}

/**
 * Verifies, for all three buildings and all 24 hours:
 *   1. the flow identity on baseline and optimized flows,
 *   2. `predicted_load_kw === flows.grid_kw`,
 *   3. `baseline_kw === baseline_flows.grid_kw`,
 *   4. `optimized_kw === optimized_flows.grid_kw`.
 * Pure; safe to call from a script or a test.
 */
export function checkFixtures(): FixtureReport {
  const violations: FixtureViolation[] = [];
  let maxResidual = 0;

  const track = (r: number) => {
    maxResidual = Math.max(maxResidual, Math.abs(r));
  };

  for (const fixture of FIXTURES) {
    const id = fixture.building.id;
    const forecast = fixture.buildForecast();
    const plan = fixture.buildPlan('check');

    for (let h = 0; h < 24; h += 1) {
      for (const [check, flows] of [
        ['baseline_flows_identity', fixture.baselineFlows[h]],
        ['optimized_flows_identity', fixture.optimizedFlows[h]],
      ] as const) {
        const { violation, residual } = checkFlows(id, h, check, flows);
        track(residual);
        if (violation) violations.push(violation);
      }

      const series: Array<[string, number, number]> = [
        [
          'forecast_grid_matches_predicted',
          forecast.points[h].predicted_load_kw,
          forecast.points[h].flows.grid_kw,
        ],
        [
          'impact_baseline_grid_matches_series',
          plan.impact[h].baseline_kw,
          plan.impact[h].baseline_flows.grid_kw,
        ],
        [
          'impact_optimized_grid_matches_series',
          plan.impact[h].optimized_kw,
          plan.impact[h].optimized_flows.grid_kw,
        ],
      ];

      for (const [check, expected, actual] of series) {
        const residual = expected - actual;
        track(residual);
        if (Math.abs(residual) > TOLERANCE_KW) {
          violations.push({ building_id: id, hour: h, check, expected, actual, residual });
        }
      }
    }
  }

  return { violations, maxResidual };
}

let checked = false;

/** Runs `checkFixtures()` once per process in dev and warns about failures. */
export function validateFixtures(): void {
  if (checked || process.env.NODE_ENV === 'production') return;
  checked = true;

  const { violations, maxResidual } = checkFixtures();
  if (violations.length > 0) {
    console.warn(
      `[gridshift] ${violations.length} fixture violation(s); max residual ${maxResidual.toFixed(4)} kW`,
      violations.slice(0, 12),
    );
  }
}
