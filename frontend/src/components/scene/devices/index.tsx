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
 * Five channels, five colours, and exactly one of them may ever turn red:
 *
 *   grid      sky #38bdf8, or alert #ef4444 over the threshold
 *   solar     amber #f59e0b
 *   battery   violet #a78bfa, or good #10b981 when an optimized plan is
 *             discharging it
 *   ev        teal #2dd4bf, or good #10b981 when an optimized plan has shifted
 *             the charging away
 *   hvac      neutral #9ca3af, amber once it out-draws the chargers
 *
 * ## Draw calls
 *
 * The budget is 32. A commercial lot spends 29: transformer 5, battery 4,
 * charging court 8, array 2, plant 3, five conduit tubes, one particle mesh and
 * one highlight mesh. The residence spends 26. Every prop groups its geometry by
 * material rather than by object to get there -- see `Instanced.tsx`.
 */

import { useMemo } from 'react';
import { CatmullRomCurve3 } from 'three';
import type { DevicesProps } from '../contracts';
import { RESIDENCE_WALL_BATTERY, anchorsFor } from '../layout';
import { BatteryCabinet } from './BatteryCabinet';
import { C, DORMANT_KW, evPlan, isResidence, maxFlowKw, v3 } from './common';
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
import { Transformer } from './Transformer';

/** An optimized plan that has quietened the chargers this far gets the win colour. */
const EV_QUIET_RATIO = 0.3;

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
  const discharging = flows.battery_kw > DORMANT_KW;

  // Only the grid channel is ever allowed to take the alert red.
  const gridColor = overThreshold ? C.alert : C.grid;
  const solarColor = C.solar;
  // In an optimized plan a discharging battery and a throttled charger are the
  // agent's doing: colour them as the win they are. Same rule as the 2D wires.
  const batteryColor = optimized && discharging ? C.good : C.battery;
  const evColor = optimized && plan.ratio < EV_QUIET_RATIO ? C.good : C.ev;
  // HVAC only earns the amber "biggest load" colour when it out-draws the EVs.
  const hvacColor = flows.hvac_kw > 0 && flows.hvac_kw >= flows.ev_kw ? C.solar : C.hvac;

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

  return (
    <group name="devices">
      <Transformer
        type={type}
        position={anchors.grid}
        gridKw={flows.grid_kw}
        overThreshold={overThreshold}
      />
      <BatteryCabinet
        type={type}
        position={anchors.battery}
        batteryKw={flows.battery_kw}
        socPct={flows.battery_soc_pct}
        accent={batteryColor}
      />
      <EvBays
        type={type}
        position={anchors.ev}
        plan={plan}
        totalBays={building.ev_bays}
        evKw={flows.ev_kw}
        accent={evColor}
      />
      <RoofSolar building={building} solarKw={flows.solar_kw} />
      <RoofHvac building={building} hvacKw={flows.hvac_kw} maxKw={maxKw} />

      {CHANNELS.map((channel) => (
        <Conduit
          key={channel}
          curve={curves[channel]}
          scale={scales[channel]}
          color={color[channel]}
        />
      ))}
      <FlowParticles streams={streams} />

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
