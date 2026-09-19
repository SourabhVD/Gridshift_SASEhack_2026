'use client';

/**
 * Everything that sits *around* the building: the grid intake, the battery, the
 * charging court, the plant, and the conduits carrying light between them and
 * the junction box on the front face.
 *
 * This is the 3D translation of `flow/EnergyFlowDiagram`, and it keeps that
 * component's reading rules intact so the two views never contradict each other:
 *
 *   conduit thickness  share of the busiest flow this hour
 *   particle speed     the same share (busy runs move fast)
 *   particle direction which way the power is actually going
 *   colour             per device, with the same alert/optimized overrides
 *   pulsing ring       the node the agent is querying right now
 *
 * Direction rules -- a conduit is authored device -> junction, and particles run
 * forward for power arriving at the building, backwards for power leaving it:
 *
 *   grid     -> building   always
 *   solar    -> building   always
 *   battery  -> building   when discharging (battery_kw > 0)
 *   battery  <- building   when charging    (battery_kw < 0)
 *   ev       <- building   always
 *   hvac     <- building   always
 *
 * Below 0.5 kW a flow is dormant: the conduit drops to 0.18 opacity and its
 * particles are not rendered at all.
 *
 * ## Colour
 *
 * Five channels, five colours, and exactly ONE of them ever changes state --
 * the grid. Everything else keeps its own colour at every load and in every
 * mode, so an approve reads as one line changing rather than three:
 *
 *   grid      stage blue #6EA0FF; alert #FF7B75 over the threshold, good
 *             #7BEAAB once an optimized plan is holding it under -- and good
 *             unconditionally once that plan has been APPROVED, which is what
 *             the approve moment settles to
 *   solar     stage amber #FFBE5C
 *   battery   stage violet #D5B8FF
 *   ev        stage teal #4CD9C3
 *   hvac      stage grey #9FA6B3 -- it never warms up, it only thickens
 *
 * ## Draw calls
 *
 * The budget is 32. A commercial lot spends 30: transformer 5, battery 4,
 * charging court 8, array 2, plant 3, five conduit tubes, one particle mesh, one
 * approve-pulse bead and one highlight mesh. The residence spends 27. Every prop
 * groups its geometry by material rather than by object to get there -- see
 * `Instanced.tsx`.
 *
 * ## The approve moment
 *
 * `runStatus` is read from the store rather than taken as a prop: react-three-
 * fiber bridges React context into the canvas, and threading one more boolean
 * through `EnergySceneProps` for a beat that only this subtree stages would put
 * the plumbing further from the thing it drives. Approval does two things here,
 * and both are frame-loop work on materials that already exist -- nothing is
 * remounted:
 *
 *   colour   the grid conduit, its beads and the pylon conductors walk to
 *            `good` over 800 ms (see Conduit / FlowParticles / Transformer)
 *   pulse    one bright bead runs the grid conduit transformer -> junction,
 *            once (see ApprovePulse)
 */

import { useMemo } from 'react';
import { CatmullRomCurve3 } from 'three';
import { useGridShift } from '@/lib/store';
import type { DevicesProps } from '../contracts';
import { RESIDENCE_WALL_BATTERY, anchorsFor } from '../layout';
import { ApprovePulse } from './ApprovePulse';
import { BatteryCabinet } from './BatteryCabinet';
import { C, evPlan, isResidence, maxFlowKw, v3 } from './common';
import { Conduit, conduitScale } from './Conduit';
import { EvBays } from './EvBays';
import { FlowParticles, type ParticleStream } from './FlowParticles';
import { Highlight } from './Highlight';
import {
  HVAC_DROP_X,
  SOLAR_DROP_X,
  groundConduit,
  hvacOrigin,
  residenceConduit,
  roofConduit,
  solarOrigin,
} from './paths';
import { RoofHvac } from './RoofHvac';
import { RoofSolar } from './RoofSolar';
import { CONDUCTOR_IDLE, Transformer } from './Transformer';
import { Pickable, ringsFor } from '../interaction/Pickable';

/** Conduit gauge. A utility feeder is not the same object as a domestic run. */
const COMMERCIAL_RADII: [number, number] = [0.08, 0.22];
const RESIDENCE_RADII: [number, number] = [0.03, 0.08];

type Channel = 'grid' | 'solar' | 'battery' | 'ev' | 'hvac';
const CHANNELS: Channel[] = ['grid', 'solar', 'battery', 'ev', 'hvac'];

export function Devices({
  building,
  flows,
  mode,
  overThreshold,
  activeNodes,
  running,
}: DevicesProps) {
  const { runStatus } = useGridShift();
  const approved = runStatus === 'approved';

  const type = building.type;
  const residence = isResidence(type);
  const maxKw = maxFlowKw(flows);
  const plan = useMemo(() => evPlan(building, flows.ev_kw), [building, flows.ev_kw]);

  /* Anchors. `anchorsFor` hands the residence the string 'wall' for its battery,
   * because the pack is bolted to the gable end rather than standing on grade. */
  const anchors = useMemo(() => {
    const a = anchorsFor(type);
    const battery = a.battery;
    return {
      grid: v3(a.grid),
      battery: typeof battery === 'string' ? v3(RESIDENCE_WALL_BATTERY) : v3(battery),
      ev: v3(a.ev),
    };
  }, [type]);

  /* Routing depends only on the building shape, so the curves -- and with them
   * the tube geometries and the particle lookup tables -- survive every hour,
   * mode and colour change. */
  const curves = useMemo(() => {
    const points = residence
      ? {
          grid: residenceConduit('grid'),
          solar: residenceConduit('solar'),
          battery: residenceConduit('battery'),
          ev: residenceConduit('ev'),
          hvac: residenceConduit('hvac'),
        }
      : {
          grid: groundConduit(type, anchors.grid),
          solar: roofConduit(type, solarOrigin(type), SOLAR_DROP_X),
          battery: groundConduit(type, anchors.battery),
          ev: groundConduit(type, anchors.ev),
          hvac: roofConduit(type, hvacOrigin(type), HVAC_DROP_X),
        };
    return {
      grid: new CatmullRomCurve3(points.grid, false, 'centripetal', 0.5),
      solar: new CatmullRomCurve3(points.solar, false, 'centripetal', 0.5),
      battery: new CatmullRomCurve3(points.battery, false, 'centripetal', 0.5),
      ev: new CatmullRomCurve3(points.ev, false, 'centripetal', 0.5),
      hvac: new CatmullRomCurve3(points.hvac, false, 'centripetal', 0.5),
    };
  }, [type, residence, anchors]);

  /* Colours ---------------------------------------------------------------- */

  const optimized = mode === 'optimized';

  /* The grid is the only channel with states: red over the billed threshold,
   * green once an optimized plan is holding it under. Every other conduit
   * keeps its own channel colour in both modes -- three lines changing at once
   * is why the approve moment used to land on nothing in particular. */
  const gridColor = approved
    ? C.good
    : overThreshold
      ? C.alert
      : optimized
        ? C.good
        : C.grid;
  /* The span off the pylon joins the grid channel once the plan is committed;
     until then it is bare aluminium, or red while the site is over threshold. */
  const conductorColor = approved ? C.good : overThreshold ? C.alert : CONDUCTOR_IDLE;
  const solarColor = C.solar;
  const batteryColor = C.battery;
  const evColor = C.ev;
  const hvacColor = C.hvac;

  /* Flow ------------------------------------------------------------------- */

  const [minR, maxR] = residence ? RESIDENCE_RADII : COMMERCIAL_RADII;
  const kw: Record<Channel, number> = {
    grid: flows.grid_kw,
    solar: flows.solar_kw,
    battery: flows.battery_kw,
    ev: flows.ev_kw,
    hvac: flows.hvac_kw,
  };
  const color: Record<Channel, string> = {
    grid: gridColor,
    solar: solarColor,
    battery: batteryColor,
    ev: evColor,
    hvac: hvacColor,
  };
  const toward: Record<Channel, boolean> = {
    grid: true,
    solar: true,
    battery: flows.battery_kw >= 0,
    ev: false,
    hvac: false,
  };
  const scales = {
    grid: conduitScale(kw.grid, maxKw, minR, maxR),
    solar: conduitScale(kw.solar, maxKw, minR, maxR),
    battery: conduitScale(kw.battery, maxKw, minR, maxR),
    ev: conduitScale(kw.ev, maxKw, minR, maxR),
    hvac: conduitScale(kw.hvac, maxKw, minR, maxR),
  };

  /* One InstancedMesh carries every bead on the site; each channel owns a slice. */
  const streams = useMemo<ParticleStream[]>(
    () =>
      CHANNELS.map((channel) => ({
        curve: curves[channel],
        count: scales[channel].count,
        speed: scales[channel].speed,
        reverse: !toward[channel],
        color: color[channel],
        radius: scales[channel].radius,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      curves,
      scales.grid.count, scales.grid.speed, scales.grid.radius, color.grid, toward.grid,
      scales.solar.count, scales.solar.speed, scales.solar.radius, color.solar,
      scales.battery.count, scales.battery.speed, scales.battery.radius, color.battery, toward.battery,
      scales.ev.count, scales.ev.speed, scales.ev.radius, color.ev,
      scales.hvac.count, scales.hvac.speed, scales.hvac.radius, color.hvac,
    ],
  );

  /* One pick target per device, with the ring that marks it. Wrapping here
   * rather than inside each prop keeps the props themselves ignorant of the
   * interaction, and means the conduits and the particle mesh -- which are not
   * wrapped -- are never even raycast. */
  const rings = useMemo(() => ringsFor(building), [building]);

  return (
    <group name="devices">
      <Pickable node="grid" ring={rings.grid}>
        <Transformer
          type={type}
          position={anchors.grid}
          gridKw={flows.grid_kw}
          overThreshold={overThreshold}
          conductorColor={conductorColor}
        />
      </Pickable>
      <Pickable node="battery" ring={rings.battery}>
        <BatteryCabinet
          type={type}
          position={anchors.battery}
          batteryKw={flows.battery_kw}
          socPct={flows.battery_soc_pct}
          accent={batteryColor}
        />
      </Pickable>
      <Pickable node="ev" ring={rings.ev}>
        <EvBays
          type={type}
          position={anchors.ev}
          plan={plan}
          totalBays={building.ev_bays}
          evKw={flows.ev_kw}
          accent={evColor}
        />
      </Pickable>
      <Pickable node="solar" ring={rings.solar}>
        <RoofSolar building={building} solarKw={flows.solar_kw} />
      </Pickable>
      <Pickable node="hvac" ring={rings.hvac}>
        <RoofHvac building={building} hvacKw={flows.hvac_kw} maxKw={maxKw} />
      </Pickable>

      {CHANNELS.map((channel) => (
        <Conduit
          key={channel}
          curve={curves[channel]}
          scale={scales[channel]}
          color={color[channel]}
        />
      ))}
      <FlowParticles streams={streams} />

      {/* Fires once on the rising edge of `approved`, then parks itself. */}
      <ApprovePulse
        curve={curves.grid}
        active={approved}
        radius={scales.grid.radius}
        color={C.good}
      />

      <Highlight
        building={building}
        anchors={anchors}
        plan={plan}
        activeNodes={activeNodes}
        running={running}
      />
    </group>
  );
}

export default Devices;
