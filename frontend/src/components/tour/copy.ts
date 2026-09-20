/**
 * Every sentence the chapter tour says, and the arithmetic behind it.
 *
 * The tour replaced a card of labelled fields with prose, so this module is
 * where a number becomes a claim. Three rules hold everywhere below:
 *
 *   short      no sentence runs past 13 words. A chapter that needs a
 *              paragraph is a chapter that has not been decided yet.
 *   sited      every site says the same thing in its own vocabulary: a
 *              warehouse has vans, a hospital has ambulance chargers, a house
 *              has a car on the drive. `building.type` is the only switch.
 *   live       nothing is hard-coded. Every figure comes from `flowsAt(hour)`,
 *              the building's nameplate or the plan, so scrubbing the timeline
 *              rewrites the copy hour by hour.
 *
 * The one constant that is not on the wire is the battery reserve floor: the
 * agent reports it in a tool payload that only exists mid-run, so the policy is
 * mirrored here per site type. Keep it in step with src/mocks/buildings/*.
 */

import { formatHour, formatHourIndex, formatPrice, formatUsd } from '@/lib/format';
import type {
  Action,
  ActionPlan,
  ActionType,
  Building,
  BuildingType,
  EnergyFlows,
  RunStatus,
} from '@/types/api';

/* -------------------------------------------------------------------------- */
/* The chapters                                                                */
/* -------------------------------------------------------------------------- */

/** A chapter that is also a prop in the 3D scene, and shares its `SceneNode`. */
export type DeviceChapter = 'grid' | 'solar' | 'battery' | 'ev' | 'hvac';

/** The two closing chapters are about the day, not about a device. */
export type ChapterId = DeviceChapter | 'peak' | 'plan';

/** Reading order: round the site, then the problem, then the answer. */
export const CHAPTERS: readonly ChapterId[] = [
  'grid',
  'solar',
  'battery',
  'ev',
  'hvac',
  'peak',
  'plan',
];

const DEVICE_IDS: ReadonlySet<string> = new Set<DeviceChapter>([
  'grid',
  'solar',
  'battery',
  'ev',
  'hvac',
]);

export function isDeviceChapter(id: ChapterId): id is DeviceChapter {
  return DEVICE_IDS.has(id);
}

/**
 * Which chapter each agent tool is about.
 *
 * Deliberately not `TOOL_NODES` from the scene layout, which answers a
 * different question: that one maps a tool to the props it lights up in 3D,
 * so everything without a mesh lands on 'building'. The column has two
 * chapters with no device at all -- the peak and the plan -- and they are
 * exactly the ones the interesting tools are about. Reusing the scene's map
 * left both of them dark for the whole run.
 */
export const TOOL_CHAPTERS: Readonly<Record<string, readonly ChapterId[]>> = {
  get_energy_forecast: ['peak'],
  get_electricity_prices: ['grid'],
  get_battery_state: ['battery'],
  get_ev_requirements: ['ev'],
  get_hvac_constraints: ['hvac'],
  run_schedule_optimizer: ['battery', 'ev', 'hvac', 'plan'],
  validate_schedule: ['battery', 'ev', 'hvac', 'plan'],
  save_action_plan: ['plan'],
  request_human_approval: ['plan'],
};

/** The chapter a plan row asks a human about. */
export const ACTION_CHAPTERS: Readonly<Record<ActionType, ChapterId>> = {
  battery_discharge: 'battery',
  ev_charging_shift: 'ev',
  hvac_setpoint: 'hvac',
};

/**
 * Each device chapter's channel colour, as a CSS variable. The tour is where
 * the scene's colours and the dashboard's meet, so it reads the UI hexes -- the
 * lighter stage ramp belongs to emissive materials, not to DOM.
 */
export const CHANNEL: Record<DeviceChapter, string> = {
  grid: 'var(--color-forecast)',
  solar: 'var(--color-solar)',
  battery: 'var(--color-battery)',
  ev: 'var(--color-ev)',
  hvac: 'var(--color-hvac)',
};

/** Which field of `EnergyFlows` a device chapter is about. */
export const FLOW_KEY: Record<DeviceChapter, keyof EnergyFlows> = {
  grid: 'grid_kw',
  solar: 'solar_kw',
  battery: 'battery_kw',
  ev: 'ev_kw',
  hvac: 'hvac_kw',
};

/** Which chapter owns each kind of plan action. */
export const ACTION_CHAPTER: Record<ActionType, DeviceChapter> = {
  battery_discharge: 'battery',
  ev_charging_shift: 'ev',
  hvac_setpoint: 'hvac',
};

/** Steps in the scripted agent run; the plan chapter counts against it. */
export const TOTAL_STEPS = 14;

/** Nameplate of one charging bay, mirrored from scene/devices/common. */
const PER_BAY_KW = 11;

/** Share of the pack each site holds back. Mirrored from the fixtures. */
const RESERVE_FLOOR_PCT: Record<BuildingType, number> = {
  office: 20,
  hospital: 30,
  warehouse: 10,
  residence: 20,
};

export function chapterTitle(id: ChapterId, building: Building): string {
  const residence = building.type === 'residence';
  switch (id) {
    case 'grid':
      return 'Grid intake';
    case 'solar':
      return residence ? 'Roof solar' : 'Rooftop solar';
    case 'battery':
      return 'Battery';
    case 'ev':
      return 'EV charging';
    case 'hvac':
      return residence ? 'Heat pump' : 'HVAC';
    case 'peak':
      return 'The peak';
    case 'plan':
    default:
      return 'The plan';
  }
}

/* -------------------------------------------------------------------------- */
/* Numbers as words                                                            */
/* -------------------------------------------------------------------------- */

/** Drops a trailing ".0" so 13.5 and 10 both read naturally. */
function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * A household runs on single digits and an office on hundreds, so the number of
 * decimals follows the magnitude rather than the site. Returns the bare figure;
 * callers add the unit.
 */
export function kwText(value: number): string {
  return Math.abs(value) < 20 ? value.toFixed(1) : value.toFixed(0);
}

const WORDS = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
];

/** Small numbers are spelled out when they open a sentence, as prose does. */
function spell(n: number): string {
  return n >= 0 && n <= 20 ? WORDS[n] : String(n);
}

function share(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

/** "90 kW", "+3 degF" -- the sign is only meaningful on a setpoint. */
function magnitudeLabel(action: Action): string {
  const signed =
    action.type === 'hvac_setpoint' && action.magnitude > 0
      ? `+${action.magnitude}`
      : `${action.magnitude}`;
  return `${signed} ${action.unit}`;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

/** The worst hour of the day, when the forecast crosses the billed cap. */
export interface PeakFacts {
  kw: number;
  /** Index into `forecast.points`, i.e. the hour the scrubber understands. */
  hour: number;
  /** How many hours of the day sit above the cap. */
  hours: number;
  threshold: number;
}

/** Everything the copy is allowed to read. Assembled once by <ChapterTour>. */
export interface ChapterCtx {
  building: Building;
  /** `flowsAt(viewHour)` -- follows the scrubber and the baseline/optimized switch. */
  flows: EnergyFlows | null;
  hour: number;
  /** This hour's tariff, when the forecast carries one. */
  price: number | null;
  plan: ActionPlan | null;
  peak: PeakFacts | null;
  runStatus: RunStatus;
  /** Agent events so far, for the plan chapter's progress line. */
  stepCount: number;
  /** The agent's most recent message, for the plan chapter while it runs. */
  latestMessage: string | null;
}

/** One chapter's prose: a bold opening claim, then one or two plain sentences. */
export interface ChapterCopy {
  lead: string;
  body: string[];
}

/* -------------------------------------------------------------------------- */
/* Per-chapter copy                                                            */
/* -------------------------------------------------------------------------- */

function gridCopy(ctx: ChapterCtx): ChapterCopy {
  const { building, flows, hour, price } = ctx;
  const threshold = building.peak_threshold_kw;

  const lead =
    building.type === 'residence'
      ? `One service drop, ${trim(threshold)} kW cap.`
      : building.type === 'hospital'
        ? `${trim(threshold)} kW cap on a site that never sleeps.`
        : building.type === 'warehouse'
          ? `One feeder, ${trim(threshold)} kW cap.`
          : `Billed against a ${trim(threshold)} kW cap.`;

  if (!flows) return { lead, body: [`No reading for ${formatHourIndex(hour)}.`] };

  const over = flows.grid_kw - threshold;
  const body = [
    over > 0
      ? `Importing ${kwText(flows.grid_kw)} kW at ${formatHourIndex(hour)}, ${kwText(over)} kW over.`
      : `Importing ${kwText(flows.grid_kw)} kW at ${formatHourIndex(hour)}, ${share(flows.grid_kw, threshold)} percent of the cap.`,
  ];
  if (price != null) body.push(`Power costs ${formatPrice(price)} this hour.`);
  return { lead, body };
}

function solarCopy(ctx: ChapterCtx): ChapterCopy {
  const { building, flows, hour } = ctx;
  const cap = building.solar_capacity_kw;

  const lead =
    building.type === 'residence'
      ? `${trim(cap)} kW on the front slope.`
      : building.type === 'warehouse'
        ? `${trim(cap)} kW across the roof deck.`
        : building.type === 'hospital'
          ? `${trim(cap)} kW over the annex roof.`
          : `${trim(cap)} kW rooftop array.`;

  if (!flows) return { lead, body: [`No reading for ${formatHourIndex(hour)}.`] };

  if (flows.solar_kw < 0.05) {
    return { lead, body: [`Dark at ${formatHourIndex(hour)}. The array is asleep.`] };
  }

  /* Against what the site is actually consuming, not against the meter: on a
     sunny morning the array can cover the house and still be filling the pack,
     and a grid-relative figure would read as a negative. */
  const demand = flows.base_kw + flows.ev_kw + flows.hvac_kw;
  const covered = share(flows.solar_kw, demand);
  return {
    lead,
    body: [
      `Generating ${kwText(flows.solar_kw)} kW at ${formatHourIndex(hour)}.`,
      covered >= 100
        ? `More than the ${building.type === 'residence' ? 'house' : 'site'} needs this hour.`
        : `That covers ${covered} percent of the load.`,
    ],
  };
}

function batteryCopy(ctx: ChapterCtx): ChapterCopy {
  const { building, flows, hour } = ctx;
  const cap = building.battery_capacity_kwh;
  const max = building.battery_max_kw;

  const lead =
    building.type === 'residence'
      ? `Two wall units, ${trim(cap)} kWh.`
      : building.type === 'hospital'
        ? `${trim(cap)} kWh pack, critical-care rated.`
        : building.type === 'warehouse'
          ? `${trim(cap)} kWh in the yard, ${trim(max)} kW inverter.`
          : `${trim(cap)} kWh cabinet, ${trim(max)} kW inverter.`;

  const floor = `Reserve floor ${RESERVE_FLOOR_PCT[building.type]} percent.`;
  if (!flows) return { lead, body: [`No reading for ${formatHourIndex(hour)}.`, floor] };

  const kw = flows.battery_kw;
  const soc = `${flows.battery_soc_pct.toFixed(0)} percent full`;
  const at = formatHourIndex(hour);

  let line: string;
  if (Math.abs(kw) < 0.5) {
    line = `Idle at ${at}, ${soc}.`;
  } else if (kw < 0) {
    /* The inverter fills the pack from PV before it serves the building, so
       "from solar" is only honest when the array actually covers the charge. */
    const source = flows.solar_kw >= Math.abs(kw) ? 'from solar' : 'from the grid';
    line = `Charging ${kwText(-kw)} kW ${source} at ${at}, ${soc}.`;
  } else {
    line = `Discharging ${kwText(kw)} kW at ${at}, ${soc}.`;
  }

  return { lead, body: [line, floor] };
}

function evCopy(ctx: ChapterCtx): ChapterCopy {
  const { building, flows, hour, plan } = ctx;
  const bays = building.ev_bays;
  const residence = building.type === 'residence';

  const lead = residence
    ? `One driveway charger, ${PER_BAY_KW} kW.`
    : building.type === 'warehouse'
      ? `${bays} vans, ${PER_BAY_KW} kW each.`
      : building.type === 'hospital'
        ? `${bays} ambulance chargers, ${PER_BAY_KW} kW each.`
        : `${bays} bays, ${PER_BAY_KW} kW each.`;

  const body: string[] = [];
  const at = formatHourIndex(hour);

  if (!flows) {
    body.push(`No reading for ${at}.`);
  } else if (residence) {
    body.push(
      flows.ev_kw < 0.05
        ? `Nothing plugged in at ${at}.`
        : `Charging ${kwText(flows.ev_kw)} kW at ${at}.`,
    );
  } else {
    const busy = Math.min(bays, Math.max(0, Math.round(flows.ev_kw / PER_BAY_KW)));
    body.push(
      busy === 0
        ? `No bay is drawing at ${at}.`
        : `${busy} charging at ${at} for ${kwText(flows.ev_kw)} kW.`,
    );
  }

  const shift = plan?.actions.find((action) => action.type === 'ev_charging_shift');
  if (shift) {
    const moved = Math.max(1, Math.round(shift.magnitude / PER_BAY_KW));
    body.push(
      residence
        ? `The car can wait until ${formatHour(shift.end_time)}.`
        : `${spell(moved)} can wait until ${formatHour(shift.end_time)}.`,
    );
  }

  return { lead, body };
}

function hvacCopy(ctx: ChapterCtx): ChapterCopy {
  const { building, flows, hour, plan } = ctx;
  const zones = building.hvac_zones;

  const lead =
    building.type === 'residence'
      ? `One heat pump, ${zones} zones.`
      : building.type === 'hospital'
        ? `${zones} zones, pressure critical.`
        : building.type === 'warehouse'
          ? `${zones} zones over the floor.`
          : `${zones} zones on rooftop plant.`;

  const body: string[] = [
    flows
      ? `Drawing ${kwText(flows.hvac_kw)} kW at ${formatHourIndex(hour)}.`
      : `No reading for ${formatHourIndex(hour)}.`,
  ];

  const setpoint = plan?.actions.find((action) => action.type === 'hvac_setpoint');
  if (setpoint) {
    body.push(
      `Setpoint moves ${magnitudeLabel(setpoint)} from ${formatHour(setpoint.start_time)}.`,
    );
  }

  return { lead, body };
}

function peakCopy(ctx: ChapterCtx): ChapterCopy {
  const { building, peak } = ctx;

  if (!peak) {
    return {
      lead: 'Under the cap all day.',
      body: [`The forecast never reaches ${trim(building.peak_threshold_kw)} kW.`],
    };
  }

  return {
    lead: `Peak ${kwText(peak.kw)} kW at ${formatHourIndex(peak.hour)}.`,
    body: [
      `${spell(peak.hours)} ${peak.hours === 1 ? 'hour' : 'hours'} over the ${trim(
        peak.threshold,
      )} kW cap.`,
    ],
  };
}

function planCopy(ctx: ChapterCtx): ChapterCopy {
  const { plan, runStatus, stepCount, latestMessage } = ctx;

  if (plan) {
    return {
      lead: `Peak ${kwText(plan.baseline_peak_kw)} → ${kwText(plan.optimized_peak_kw)} kW.`,
      body: [
        `${formatUsd(plan.savings_usd)} saved, ${kwText(plan.peak_reduction_kw)} kW off the billed peak.`,
      ],
    };
  }

  if (runStatus === 'running') {
    return {
      lead: 'Agent investigating.',
      body: [
        latestMessage ?? 'Reading the site.',
        `${Math.min(stepCount, TOTAL_STEPS)} of ${TOTAL_STEPS} steps.`,
      ],
    };
  }

  if (runStatus === 'failed') {
    return { lead: 'The run stopped.', body: ['Try GridShift again.'] };
  }

  return {
    lead: 'No plan yet.',
    body: ['Run GridShift to let the agent investigate.'],
  };
}

/** The prose for one chapter, for this hour and this plan. */
export function chapterCopy(id: ChapterId, ctx: ChapterCtx): ChapterCopy {
  switch (id) {
    case 'grid':
      return gridCopy(ctx);
    case 'solar':
      return solarCopy(ctx);
    case 'battery':
      return batteryCopy(ctx);
    case 'ev':
      return evCopy(ctx);
    case 'hvac':
      return hvacCopy(ctx);
    case 'peak':
      return peakCopy(ctx);
    case 'plan':
    default:
      return planCopy(ctx);
  }
}

/* -------------------------------------------------------------------------- */
/* The live number                                                             */
/* -------------------------------------------------------------------------- */

/** The one big figure a device chapter leads its readout with. */
export interface ChapterValue {
  /** Already unsigned: the battery reports its magnitude, the note its direction. */
  kw: number;
  /** Direction or provenance, in lower case, under the figure. */
  note: string;
  /** Grid over the billed cap: the only state that recolours the number. */
  alert: boolean;
}

export function chapterValue(id: DeviceChapter, ctx: ChapterCtx): ChapterValue | null {
  const { building, flows } = ctx;
  if (!flows) return null;

  switch (id) {
    case 'grid':
      return {
        kw: flows.grid_kw,
        note: 'imported from the grid',
        alert: flows.grid_kw > building.peak_threshold_kw,
      };
    case 'solar':
      return { kw: flows.solar_kw, note: 'generated on site', alert: false };
    case 'battery': {
      const direction =
        Math.abs(flows.battery_kw) < 0.5
          ? 'idle'
          : flows.battery_kw > 0
            ? 'discharging into the building'
            : 'charging';
      return { kw: Math.abs(flows.battery_kw), note: direction, alert: false };
    }
    case 'ev':
      return { kw: flows.ev_kw, note: 'charging draw', alert: false };
    case 'hvac':
    default:
      return {
        kw: flows.hvac_kw,
        note: building.type === 'residence' ? 'heating and cooling' : 'cooling draw',
        alert: false,
      };
  }
}
