/**
 * The animated single-line diagram: where this building's power is coming from
 * and going to, for one hour of the day.
 *
 * Purely presentational. It takes the building record, the flows for the hour
 * being viewed, and the agent's current state, and owns none of them — the
 * integrator wires it to the store. Nothing here reads `Date`, `Math.random` or
 * `window`, so the server and client trees match exactly.
 *
 * Reading the picture:
 *   - wire thickness  = share of the busiest flow this hour
 *   - dash speed      = the same share (busy wires move fast)
 *   - dash direction  = which way the power is actually going
 *   - window glow     = grid draw against the building's peak threshold
 *   - pulsing ring    = the node the agent is querying right now
 */

import clsx from 'clsx';
import { formatHourIndex, formatKw } from '@/lib/format';
import {
  DASH_CYCLE,
  MIN_WIRE_KW,
  NODE_CENTERS,
  VIEW_H,
  VIEW_W,
  buildingShape,
  clamp,
  estimateTextWidth,
  maxFlowKw,
  windowGrid,
  wireGeometries,
  type FlowNodeId,
} from './geometry';
import {
  BatteryGlyph,
  EvBays,
  EvGlyph,
  FlowNode,
  GridGlyph,
  HvacGlyph,
  SolarGlyph,
} from './Node';
import { Wire } from './Wire';
import type { Building, EnergyFlows, FlowTool } from './types';

export interface EnergyFlowDiagramProps {
  building: Building | null;
  /** Flows for the hour being viewed. */
  flows: EnergyFlows | null;
  /** 0–23, the hour being viewed. */
  hour: number;
  mode: 'baseline' | 'optimized';
  /** `flows.grid_kw > building.peak_threshold_kw`, decided by the caller. */
  overThreshold: boolean;
  /** Tool the agent is calling right now, or null. */
  activeTool: string | null;
  runStatus: 'idle' | 'running' | 'awaiting_approval' | 'approved' | 'rejected' | 'failed';
  className?: string;
}

/** Which node lights up while a given tool is in flight. */
const TOOL_NODES: Record<FlowTool, readonly FlowNodeId[]> = {
  get_energy_forecast: ['building'],
  get_electricity_prices: ['grid'],
  get_battery_state: ['battery'],
  get_ev_requirements: ['ev'],
  get_hvac_constraints: ['hvac'],
  run_schedule_optimizer: ['battery', 'ev', 'hvac'],
  validate_schedule: ['battery', 'ev', 'hvac'],
  save_action_plan: ['building'],
  request_human_approval: ['building'],
};

const NO_NODES: ReadonlySet<FlowNodeId> = new Set();

function highlightedNodes(activeTool: string | null, running: boolean): ReadonlySet<FlowNodeId> {
  if (!running || !activeTool) return NO_NODES;
  const lookup: Record<string, readonly FlowNodeId[] | undefined> = TOOL_NODES;
  const ids = lookup[activeTool];
  return ids ? new Set(ids) : NO_NODES;
}

/** Nominal draw of one occupied EV bay, used to size the bay-dot row. */
const KW_PER_EV_BAY = 7;

/**
 * Keyframes live here rather than in globals.css, which this component does not
 * own. Class names are prefixed `gsflow-` so they cannot collide.
 */
const FLOW_CSS = `
@keyframes gsflowDash { to { stroke-dashoffset: ${-DASH_CYCLE}px; } }
.gsflow-dash {
  animation-name: gsflowDash;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}
@keyframes gsflowPulse {
  0%   { opacity: 0.55; transform: scale(0.86); }
  70%  { opacity: 0;    transform: scale(1.24); }
  100% { opacity: 0;    transform: scale(1.24); }
}
.gsflow-pulse {
  transform-box: fill-box;
  transform-origin: center;
  animation: gsflowPulse 1.2s ease-out infinite;
}
@keyframes gsflowSpin { to { transform: rotate(360deg); } }
.gsflow-fan {
  transform-box: fill-box;
  transform-origin: center;
  animation: gsflowSpin 3.2s linear infinite;
}
.gsflow-tween {
  transition:
    stroke-width 250ms ease,
    opacity 250ms ease,
    fill-opacity 250ms ease,
    width 250ms ease,
    fill 250ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .gsflow-dash, .gsflow-pulse, .gsflow-fan { animation: none; }
  .gsflow-pulse { opacity: 0.4; }
  .gsflow-tween { transition: none; }
}
`;

/** Whole kW with a typographic minus; negatives bracketed so "− battery (−40)" reads. */
function term(kw: number): string {
  const n = Math.round(kw);
  return n < 0 ? `(−${Math.abs(n)})` : String(n);
}

export function EnergyFlowDiagram({
  building,
  flows,
  hour,
  mode,
  overThreshold,
  activeTool,
  runStatus,
  className,
}: EnergyFlowDiagramProps) {
  if (!building || !flows) {
    return (
      <div
        role="status"
        aria-label="Energy flow diagram loading"
        className={clsx(
          'aspect-[800/420] w-full animate-pulse rounded-lg bg-surface-2',
          className,
        )}
      />
    );
  }

  const shape = buildingShape(building.type, building.floors);
  const windows = windowGrid(shape);
  const wires = wireGeometries(shape);
  const lit = highlightedNodes(activeTool, runStatus === 'running');

  const maxKw = maxFlowKw([
    flows.grid_kw,
    flows.solar_kw,
    flows.battery_kw,
    flows.ev_kw,
    flows.hvac_kw,
  ]);

  /* Colours ---------------------------------------------------------------- */

  const optimized = mode === 'optimized';
  const evCapacityKw = Math.max(building.ev_bays * KW_PER_EV_BAY, 1);
  const evLoadRatio = clamp(flows.ev_kw / evCapacityKw, 0, 1);

  const gridColor = overThreshold ? 'var(--color-alert)' : 'var(--color-forecast)';
  const solarColor = 'var(--color-peak)';
  // In an optimized plan, a discharging battery and a throttled charger are the
  // agent's doing: colour them as the win they are.
  const batteryColor =
    optimized && flows.battery_kw > 0 ? 'var(--color-good)' : 'var(--color-battery)';
  const evColor = optimized && evLoadRatio < 0.3 ? 'var(--color-good)' : 'var(--color-forecast)';
  const hvacLeads = flows.hvac_kw > 0 && flows.hvac_kw >= flows.ev_kw;
  const hvacColor = hvacLeads ? 'var(--color-peak)' : 'var(--color-muted)';

  const outline = overThreshold ? 'var(--color-alert)' : 'var(--color-line)';

  /* Building ---------------------------------------------------------------- */

  const loadRatio =
    building.peak_threshold_kw > 0 ? flows.grid_kw / building.peak_threshold_kw : 0;
  const windowOpacity = 0.15 + 0.75 * clamp(loadRatio, 0, 1);
  const windowFill = overThreshold ? 'var(--color-alert)' : 'var(--color-peak)';

  const typeText = `${building.type} · ${building.floors} ${
    building.floors === 1 ? 'floor' : 'floors'
  }`.toUpperCase();
  const typePillW = estimateTextWidth(typeText, 10) + 20;

  /* Readouts ---------------------------------------------------------------- */

  const hourText = `${formatHourIndex(hour)} · ${mode}`;
  const hourPillW = estimateTextWidth(hourText, 11) + 24;

  const batteryValue =
    Math.abs(flows.battery_kw) < 0.5
      ? 'idle'
      : flows.battery_kw > 0
        ? `→ ${formatKw(flows.battery_kw)} discharging`
        : `← ${formatKw(Math.abs(flows.battery_kw))} charging`;

  const balance =
    `base ${term(flows.base_kw)} + ev ${term(flows.ev_kw)} + hvac ${term(flows.hvac_kw)}` +
    ` − solar ${term(flows.solar_kw)} − battery ${term(flows.battery_kw)}` +
    ` = grid ${term(flows.grid_kw)}`;

  const summary =
    `Energy flow for ${building.name} at ${formatHourIndex(hour)}, ${mode} plan. ` +
    `Grid ${formatKw(flows.grid_kw)}${overThreshold ? ' (over peak threshold)' : ''}, ` +
    `solar ${formatKw(flows.solar_kw)}, battery ${batteryValue}, ` +
    `EV ${formatKw(flows.ev_kw)}, HVAC ${formatKw(flows.hvac_kw)}.`;

  return (
    <div className={clsx('w-full', className)}>
      <style>{FLOW_CSS}</style>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={summary}
        style={{ width: '100%', height: 'auto', fontFamily: 'inherit' }}
      >
        {/* ---- wires (under every node) ---- */}
        <Wire
          geometry={wires.grid}
          kw={flows.grid_kw}
          maxKw={maxKw}
          color={gridColor}
          label={`Grid → building · ${formatKw(flows.grid_kw)}`}
        />
        <Wire
          geometry={wires.solar}
          kw={flows.solar_kw}
          maxKw={maxKw}
          color={solarColor}
          label={`Solar → building · ${formatKw(flows.solar_kw)}`}
        />
        <Wire
          geometry={wires.battery}
          // Authored battery → building; reverse it while charging.
          reverse={flows.battery_kw < 0}
          kw={flows.battery_kw}
          maxKw={maxKw}
          color={batteryColor}
          label={`Battery · ${batteryValue}`}
        />
        <Wire
          geometry={wires.ev}
          reverse
          kw={flows.ev_kw}
          maxKw={maxKw}
          color={evColor}
          label={`Building → EV chargers · ${formatKw(flows.ev_kw)}`}
        />
        <Wire
          geometry={wires.hvac}
          reverse
          kw={flows.hvac_kw}
          maxKw={maxKw}
          color={hvacColor}
          label={`Building → HVAC · ${formatKw(flows.hvac_kw)}`}
        />

        {/* ---- building ---- */}
        {lit.has('building') && (
          <rect
            className="gsflow-pulse"
            x={shape.x - 14}
            y={shape.top - 14}
            width={shape.w + 28}
            height={shape.y + shape.h - shape.top + 28}
            rx={16}
            fill="none"
            stroke="var(--color-forecast)"
            strokeWidth={2}
          />
        )}
        <g style={overThreshold ? { filter: 'drop-shadow(0 0 7px var(--color-alert))' } : undefined}>
          {shape.roof && (
            <polygon
              points={shape.roof}
              fill="var(--color-surface-2)"
              stroke={outline}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          )}
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.w}
            height={shape.h}
            rx={6}
            fill="var(--color-surface)"
            stroke={outline}
            strokeWidth={1.5}
          />
          {windows.map((w) => (
            <rect
              key={w.key}
              className="gsflow-tween"
              x={w.x}
              y={w.y}
              width={w.w}
              height={w.h}
              rx={1.5}
              fill={windowFill}
              style={{ fillOpacity: windowOpacity }}
            />
          ))}
        </g>

        <text
          x={NODE_CENTERS.building.x}
          y={shape.y + shape.h + 26}
          textAnchor="middle"
          // Long names step down a size rather than run into the corner wires.
          fontSize={building.name.length > 26 ? 11.5 : 13.5}
          fill="var(--color-ink)"
        >
          {building.name}
        </text>
        <rect
          x={NODE_CENTERS.building.x - typePillW / 2}
          y={shape.y + shape.h + 38}
          width={typePillW}
          height={19}
          rx={9.5}
          fill="var(--color-surface-2)"
          stroke="var(--color-line)"
        />
        <text
          x={NODE_CENTERS.building.x}
          y={shape.y + shape.h + 51.5}
          textAnchor="middle"
          fontSize={10}
          letterSpacing="0.08em"
          fill="var(--color-muted)"
        >
          {typeText}
        </text>

        {/* ---- device nodes ---- */}
        <FlowNode
          center={NODE_CENTERS.grid}
          label="Grid"
          value={formatKw(flows.grid_kw)}
          valueColor={overThreshold ? 'var(--color-alert)' : 'var(--color-ink)'}
          placement="below"
          highlighted={lit.has('grid')}
          ringRadius={40}
        >
          <GridGlyph accent={gridColor} />
        </FlowNode>

        <FlowNode
          center={NODE_CENTERS.solar}
          label="Solar"
          value={formatKw(flows.solar_kw)}
          placement="below"
          highlighted={lit.has('solar')}
        >
          <SolarGlyph accent={solarColor} />
        </FlowNode>

        <FlowNode
          center={NODE_CENTERS.battery}
          label="Battery"
          value={batteryValue}
          placement="above"
          highlighted={lit.has('battery')}
        >
          <BatteryGlyph accent={batteryColor} socPct={flows.battery_soc_pct} />
        </FlowNode>

        <FlowNode
          center={NODE_CENTERS.ev}
          label={`EV · ${building.ev_bays} bays`}
          value={formatKw(flows.ev_kw)}
          placement="below"
          highlighted={lit.has('ev')}
          extra={
            <EvBays
              accent={evColor}
              bays={Math.min(building.ev_bays, 12)}
              activeBays={
                flows.ev_kw > 0
                  ? Math.max(1, Math.round(evLoadRatio * Math.min(building.ev_bays, 12)))
                  : 0
              }
            />
          }
        >
          <EvGlyph accent={evColor} />
        </FlowNode>

        <FlowNode
          center={NODE_CENTERS.hvac}
          label={`HVAC · ${building.hvac_zones} zones`}
          value={formatKw(flows.hvac_kw)}
          placement="above"
          highlighted={lit.has('hvac')}
        >
          {/* Same threshold as the wire, so a dormant wire never has a live fan. */}
          <HvacGlyph accent={hvacColor} spinning={flows.hvac_kw >= MIN_WIRE_KW} />
        </FlowNode>

        {/* ---- corner readouts ---- */}
        <rect
          x={16}
          y={14}
          width={hourPillW}
          height={24}
          rx={12}
          fill="var(--color-surface-2)"
          stroke="var(--color-line)"
        />
        <text
          x={16 + hourPillW / 2}
          y={30}
          textAnchor="middle"
          fontSize={11}
          letterSpacing="0.04em"
          fill="var(--color-muted)"
        >
          {hourText}
        </text>

        <text x={784} y={24} textAnchor="end" fontSize={10} letterSpacing="0.08em" fill="var(--color-muted)">
          NET GRID DRAW
        </text>
        <text
          x={784}
          y={50}
          textAnchor="end"
          fontSize={26}
          fill={overThreshold ? 'var(--color-alert)' : 'var(--color-ink)'}
          fontFamily="var(--font-mono), ui-monospace, monospace"
        >
          {formatKw(flows.grid_kw)}
        </text>

        <text
          x={VIEW_W / 2}
          y={409}
          textAnchor="middle"
          fontSize={10}
          fill="var(--color-muted)"
          fontFamily="var(--font-mono), ui-monospace, monospace"
        >
          {balance}
        </text>
      </svg>
    </div>
  );
}

export default EnergyFlowDiagram;
