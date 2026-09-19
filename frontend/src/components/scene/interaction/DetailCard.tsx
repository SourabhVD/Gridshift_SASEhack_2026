'use client';

/**
 * The glass card that opens when a device is picked.
 *
 * It is HTML over the canvas rather than anything in-world: the numbers stay
 * crisp at any dpr, they use the dashboard's own type and tokens, and the
 * approve / reject buttons are real buttons that keyboard and screen readers
 * already understand.
 *
 * It reads the store directly and follows `viewHour` and `viewMode` exactly
 * like every other panel on the page, so scrubbing the timeline (or pressing
 * play) with a card open updates it hour by hour. Nothing here writes to the
 * store except the two decisions and the chart's own hour picking.
 *
 * Layout: a 300 px column pinned to the right of the viewport on desktop, and a
 * full-width bottom sheet under 640 px, where a side rail would leave the scene
 * a letterbox.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  BatteryCharging,
  Building2,
  Car,
  ChevronLeft,
  LoaderCircle,
  Sun,
  Thermometer,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { formatHour, formatHourIndex, formatPrice } from '@/lib/format';
import { useGridShift } from '@/lib/store';
import type { Action, ActionType, Building, EnergyFlows } from '@/types/api';
import type { SceneNode } from '../layout';
import { MiniChart } from './MiniChart';
import { useSelected, useSelectionStore } from './selection';

/* -------------------------------------------------------------------------- */
/* Per-node vocabulary                                                         */
/* -------------------------------------------------------------------------- */

type FlowKey = 'grid_kw' | 'solar_kw' | 'battery_kw' | 'ev_kw' | 'hvac_kw';

const FLOW_KEY: Record<SceneNode, FlowKey> = {
  building: 'grid_kw',
  grid: 'grid_kw',
  solar: 'solar_kw',
  battery: 'battery_kw',
  ev: 'ev_kw',
  hvac: 'hvac_kw',
};

const ICON: Record<SceneNode, LucideIcon> = {
  building: Building2,
  grid: Zap,
  solar: Sun,
  battery: BatteryCharging,
  ev: Car,
  hvac: Thermometer,
};

/** Which plan actions belong to which node. Grid and building show all of them. */
const ACTION_NODE: Record<ActionType, SceneNode> = {
  battery_discharge: 'battery',
  ev_charging_shift: 'ev',
  hvac_setpoint: 'hvac',
};

/** Nameplate of one bay, mirrored from devices/common. */
const PER_BAY_KW = 11;

function titleFor(node: SceneNode, building: Building): string {
  const residence = building.type === 'residence';
  switch (node) {
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
    case 'building':
    default:
      return building.name;
  }
}

/** 27 kWh across two wall units reads as "2 × 13.5 kWh", which is what is on the wall. */
function batterySubtitle(building: Building): string {
  const max = `${trim(building.battery_max_kw)} kW`;
  if (building.type === 'residence') {
    return `2 × ${trim(building.battery_capacity_kwh / 2)} kWh · ${max}`;
  }
  return `${trim(building.battery_capacity_kwh)} kWh · ${max}`;
}

function subtitleFor(node: SceneNode, building: Building): string {
  switch (node) {
    case 'grid':
      return `Peak threshold ${trim(building.peak_threshold_kw)} kW`;
    case 'solar':
      return `${trim(building.solar_capacity_kw)} kW array`;
    case 'battery':
      return batterySubtitle(building);
    case 'ev':
      return building.ev_bays === 1
        ? `1 bay · ${PER_BAY_KW} kW`
        : `${building.ev_bays} bays · ${PER_BAY_KW} kW each`;
    case 'hvac':
      return building.type === 'residence'
        ? `${building.hvac_zones} zones · air source`
        : `${building.hvac_zones} zones`;
    case 'building':
    default:
      return `${capitalize(building.type)} · ${building.area_sqft.toLocaleString('en-US')} sq ft`;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Drops a trailing ".0" so 13.5 and 10 both read naturally. */
function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * A household runs on single digits and an office on hundreds, so the number of
 * decimals follows the magnitude rather than the site.
 */
function kw(value: number): string {
  const magnitude = Math.abs(value);
  return `${magnitude < 20 ? value.toFixed(1) : value.toFixed(0)} kW`;
}

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

export function DetailCard() {
  const selected = useSelected();
  /* Keyed on the node: every pick mounts a fresh panel, which is what gives the
     enter transition something to transition from without a reset effect. */
  return selected ? <DetailPanel key={selected} node={selected} /> : null;
}

function DetailPanel({ node }: { node: SceneNode }) {
  const store = useSelectionStore();
  const {
    building,
    forecast,
    plan,
    viewHour,
    setViewHour,
    viewMode,
    flowsAt,
    approve,
    reject,
  } = useGridShift();

  const close = useCallback(() => store.select(null), [store]);

  /* Escape only belongs to the card while the card is open; it is mounted only
     then, so the listener's lifetime is the rule. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  /* Mount, then paint, then transition -- otherwise the browser coalesces the
     two frames and the card simply appears. */
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const flows = flowsAt(viewHour);

  const series = useMemo(() => {
    if (!forecast) return null;
    const key = FLOW_KEY[node];
    const baseline = forecast.points.map((point) => point.flows[key]);
    const optimized = plan ? plan.impact.map((point) => point.optimized_flows[key]) : null;
    return { baseline, optimized };
  }, [node, forecast, plan]);

  if (!building) return null;

  const Icon = ICON[node];
  const value = flows ? flows[FLOW_KEY[node]] : null;
  const threshold = building.peak_threshold_kw;
  const overThreshold = flows != null && flows.grid_kw > threshold;
  const showsThreshold = node === 'grid' || node === 'building';
  const price = forecast?.points[viewHour]?.price_per_kwh ?? null;

  const actions: Action[] = !plan
    ? []
    : node === 'grid' || node === 'building'
      ? plan.actions
      : plan.actions.filter((action) => ACTION_NODE[action.type] === node);

  return (
    <aside
      aria-label={`${titleFor(node, building)} detail`}
      className={clsx(
        /* Above the in-world kW pills, which drei parks at z-index 24. */
        'pointer-events-auto absolute z-30 flex flex-col overflow-hidden',
        'rounded-xl border border-white/10 bg-[#0a0f1a]/70 shadow-2xl backdrop-blur-md',
        'top-3 right-3 bottom-3 w-[300px]',
        'max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[78%] max-sm:w-full',
        'max-sm:rounded-b-none',
        'transition-[opacity,transform] duration-[220ms] ease-out',
        entered ? 'translate-x-0 opacity-100' : 'translate-x-3 opacity-0 max-sm:translate-x-0 max-sm:translate-y-3',
      )}
    >
      {/* header */}
      <div className="flex items-start gap-2 border-b border-white/10 px-3 py-2.5">
        <button
          type="button"
          onClick={close}
          aria-label="Back to the site view"
          className="-ml-1 rounded-md p-1 text-muted transition-colors hover:bg-white/5 hover:text-ink focus-visible:ring-1 focus-visible:ring-forecast/60 focus-visible:outline-none"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>

        <span
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/5 text-ink"
          aria-hidden="true"
        >
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-ink">
            {titleFor(node, building)}
          </h2>
          <p className="truncate text-[11px] text-muted">{subtitleFor(node, building)}</p>
        </div>

        <NodeBadge
          node={node}
          flows={flows}
          overThreshold={overThreshold}
          optimized={viewMode === 'optimized' && plan != null}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {/* now */}
        <NowBlock
          node={node}
          value={value}
          flows={flows}
          threshold={threshold}
          price={price}
          hour={viewHour}
        />

        {/* 24 hours */}
        {series ? (
          <div className="mt-3">
            <div className="mb-1 flex items-baseline justify-between text-[10px] text-muted">
              <span className="tracking-[0.08em] uppercase">24 hours</span>
              <span className="tabular-nums">{formatHourIndex(viewHour)}</span>
            </div>
            <MiniChart
              label={titleFor(node, building)}
              baseline={series.baseline}
              optimized={series.optimized}
              hour={viewHour}
              onPick={setViewHour}
              threshold={showsThreshold ? threshold : null}
              signed={node === 'battery'}
            />
            {series.optimized ? (
              <div className="mt-1 flex items-center gap-3 text-[10px] text-muted">
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-3 rounded-sm bg-muted/40" /> baseline
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-[1.5px] w-3 rounded-sm bg-good" /> optimized
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* plan */}
        <PlanSection
          node={node}
          actions={actions}
          hasPlan={plan != null}
          onApprove={approve}
          onReject={reject}
        />
      </div>

      <div className="border-t border-white/10 px-3 py-2 text-[10px] text-muted">
        Esc to exit · drag to look around
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* Header badge                                                                */
/* -------------------------------------------------------------------------- */

function NodeBadge({
  node,
  flows,
  overThreshold,
  optimized,
}: {
  node: SceneNode;
  flows: EnergyFlows | null;
  overThreshold: boolean;
  optimized: boolean;
}) {
  if (!flows) return null;

  if ((node === 'grid' || node === 'building') && overThreshold) {
    return <Badge tone="alert">over</Badge>;
  }
  if (optimized) {
    /* Only claim a win where the plan actually did something this hour. */
    const helping =
      node === 'battery'
        ? flows.battery_kw > 0.5
        : node === 'ev'
          ? flows.ev_kw < 0.5
          : node === 'grid' || node === 'building' || node === 'hvac';
    if (helping) {
      let tone: BadgeTone = 'good';
      if (node === 'solar') tone = 'neutral';
      return <Badge tone={tone}>optimized</Badge>;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Now                                                                         */
/* -------------------------------------------------------------------------- */

function NowBlock({
  node,
  value,
  flows,
  threshold,
  price,
  hour,
}: {
  node: SceneNode;
  value: number | null;
  flows: EnergyFlows | null;
  threshold: number;
  price: number | null;
  hour: number;
}) {
  if (value == null || !flows) {
    return <p className="text-xs text-muted">No data for {formatHourIndex(hour)}.</p>;
  }

  if (node === 'battery') {
    const direction =
      Math.abs(value) < 0.5 ? 'idle' : value > 0 ? 'discharging' : 'charging';
    return (
      <div>
        <div className="font-mono text-3xl leading-none text-ink tabular-nums">
          {direction === 'idle' ? '0 kW' : kw(Math.abs(value))}
        </div>
        <p className="mt-1.5 text-xs text-muted">
          <span className={direction === 'discharging' ? 'text-good' : undefined}>
            {direction}
          </span>
          {' · '}
          {flows.battery_soc_pct.toFixed(0)}% charged
        </p>
      </div>
    );
  }

  if (node === 'building') {
    const ratio = threshold > 0 ? Math.min(1.35, flows.grid_kw / threshold) : 0;
    const over = flows.grid_kw > threshold;
    return (
      <div>
        <div
          className={clsx(
            'font-mono text-3xl leading-none tabular-nums',
            over ? 'text-alert' : 'text-ink',
          )}
        >
          {kw(flows.grid_kw)}
        </div>
        <p className="mt-1.5 text-xs text-muted">
          net from grid · threshold {trim(threshold)} kW
        </p>
        <div className="relative mt-2 h-1 overflow-hidden rounded-full bg-white/10">
          <div
            className={clsx('h-full rounded-full', over ? 'bg-alert' : 'bg-forecast')}
            style={{ width: `${Math.min(100, (ratio / 1.35) * 100)}%` }}
          />
          <div
            className="absolute top-0 h-full w-px bg-white/50"
            style={{ left: `${(1 / 1.35) * 100}%` }}
          />
        </div>
      </div>
    );
  }

  const over = node === 'grid' && flows.grid_kw > threshold;
  return (
    <div>
      <div
        className={clsx(
          'font-mono text-3xl leading-none tabular-nums',
          over ? 'text-alert' : 'text-ink',
        )}
      >
        {kw(value)}
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {node === 'grid'
          ? `imported${price != null ? ` · ${formatPrice(price)}` : ''}`
          : node === 'solar'
            ? 'generated on site'
            : node === 'ev'
              ? 'charging draw'
              : 'cooling draw'}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

function magnitudeLabel(action: Action): string {
  const signed =
    action.type === 'hvac_setpoint' && action.magnitude > 0
      ? `+${action.magnitude}`
      : `${action.magnitude}`;
  return `${signed} ${action.unit}`;
}

function StatusBadge({ status }: { status: Action['status'] }) {
  if (status === 'approved') return <Badge tone="good">Approved</Badge>;
  if (status === 'rejected') return <Badge tone="neutral">Rejected</Badge>;
  if (status === 'executed') return <Badge tone="info">Executed</Badge>;
  return <Badge tone="warn">Pending</Badge>;
}

function PlanSection({
  node,
  actions,
  hasPlan,
  onApprove,
  onReject,
}: {
  node: SceneNode;
  actions: Action[];
  hasPlan: boolean;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<{ id: string; decision: 'approve' | 'reject' } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setBusy({ id, decision });
    try {
      await (decision === 'approve' ? onApprove(id) : onReject(id));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  if (!hasPlan) return null;

  return (
    <div className="mt-4 border-t border-white/10 pt-3">
      <p className="mb-2 text-[10px] tracking-[0.08em] text-muted uppercase">Plan</p>

      {node === 'solar' ? (
        <p className="text-xs text-muted">Generation is forecast, not controllable.</p>
      ) : actions.length === 0 ? (
        <p className="text-xs text-muted">No action touches this device.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {actions.map((action) => (
            <li key={action.id} className="rounded-md border border-white/10 bg-white/[0.03] p-2">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 flex-1 text-xs font-medium text-ink">{action.title}</p>
                <StatusBadge status={action.status} />
              </div>
              <p className="mt-1 text-[11px] text-muted tabular-nums">
                {formatHour(action.start_time)}&ndash;{formatHour(action.end_time)} ·{' '}
                {magnitudeLabel(action)}
              </p>

              {action.status === 'pending' ? (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Approve: ${action.title}`}
                    disabled={busy !== null}
                    onClick={() => void decide(action.id, 'approve')}
                    className="inline-flex items-center gap-1.5 rounded-md bg-good px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-base)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy?.id === action.id && busy.decision === 'approve' ? (
                      <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : null}
                    Approve
                  </button>
                  <button
                    type="button"
                    aria-label={`Reject: ${action.title}`}
                    disabled={busy !== null}
                    onClick={() => void decide(action.id, 'reject')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1 text-[11px] font-medium text-muted transition hover:border-alert/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy?.id === action.id && busy.decision === 'reject' ? (
                      <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : null}
                    Reject
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default DetailCard;
