'use client';

/**
 * Everything that sits *around* the building: the grid intake, the battery, the
 * charging court, the rooftop plant, and the conduits carrying light between
 * them and the junction box on the front face.
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
 * Below 0.5 kW a flow is dormant: the conduit drops to 0.25 opacity and its
 * particles are not rendered at all.
 */

import { useMemo } from 'react';
import type { DevicesProps } from '../contracts';
import { ANCHORS } from '../layout';
import { BatteryCabinet } from './BatteryCabinet';
import { C, DORMANT_KW, evPlan, maxFlowKw } from './common';
import { Conduit } from './Conduit';
import { EvBays } from './EvBays';
import { Highlight } from './Highlight';
import {
  HVAC_DROP_X,
  SOLAR_DROP_X,
  groundConduit,
  hvacOrigin,
  roofConduit,
  solarOrigin,
} from './paths';
import { RoofHvac } from './RoofHvac';
import { RoofSolar } from './RoofSolar';
import { Transformer } from './Transformer';

/** An optimized plan that has quietened the chargers this far gets the win colour. */
const EV_QUIET_RATIO = 0.3;

export function Devices({
  building,
  flows,
  mode,
  overThreshold,
  activeNodes,
  running,
}: DevicesProps) {
  const type = building.type;
  const maxKw = maxFlowKw(flows);
  const plan = useMemo(() => evPlan(building, flows.ev_kw), [building, flows.ev_kw]);

  /* Routing depends only on the building shape, so the curves -- and with them
   * the tube geometries and the particle lookup tables -- survive every hour,
   * mode and colour change. */
  const paths = useMemo(
    () => ({
      grid: groundConduit(type, ANCHORS.grid),
      battery: groundConduit(type, ANCHORS.battery),
      ev: groundConduit(type, ANCHORS.ev),
      solar: roofConduit(type, solarOrigin(type), SOLAR_DROP_X),
      hvac: roofConduit(type, hvacOrigin(type), HVAC_DROP_X),
    }),
    [type],
  );

  /* Colours ---------------------------------------------------------------- */

  const optimized = mode === 'optimized';
  const discharging = flows.battery_kw > DORMANT_KW;

  const gridColor = overThreshold ? C.alert : C.grid;
  const solarColor = C.solar;
  // In an optimized plan a discharging battery and a throttled charger are the
  // agent's doing: colour them as the win they are. Same rule as the 2D wires.
  const batteryColor = optimized && discharging ? C.good : C.battery;
  const evColor = optimized && plan.ratio < EV_QUIET_RATIO ? C.good : C.grid;
  // HVAC only earns the amber "biggest load" colour when it out-draws the EVs.
  const hvacColor = flows.hvac_kw > 0 && flows.hvac_kw >= flows.ev_kw ? C.solar : C.hvac;

  return (
    <group name="devices">
      <Transformer position={ANCHORS.grid} gridKw={flows.grid_kw} overThreshold={overThreshold} />
      <BatteryCabinet
        position={ANCHORS.battery}
        batteryKw={flows.battery_kw}
        socPct={flows.battery_soc_pct}
        accent={batteryColor}
      />
      <EvBays
        position={ANCHORS.ev}
        plan={plan}
        totalBays={building.ev_bays}
        evKw={flows.ev_kw}
        accent={evColor}
      />
      <RoofSolar building={building} solarKw={flows.solar_kw} />
      <RoofHvac building={building} hvacKw={flows.hvac_kw} maxKw={maxKw} />

      <Conduit
        points={paths.grid}
        kw={flows.grid_kw}
        maxKw={maxKw}
        color={gridColor}
        towardBuilding
      />
      <Conduit
        points={paths.solar}
        kw={flows.solar_kw}
        maxKw={maxKw}
        color={solarColor}
        towardBuilding
      />
      <Conduit
        points={paths.battery}
        kw={flows.battery_kw}
        maxKw={maxKw}
        color={batteryColor}
        towardBuilding={flows.battery_kw >= 0}
      />
      <Conduit
        points={paths.ev}
        kw={flows.ev_kw}
        maxKw={maxKw}
        color={evColor}
        towardBuilding={false}
      />
      <Conduit
        points={paths.hvac}
        kw={flows.hvac_kw}
        maxKw={maxKw}
        color={hvacColor}
        towardBuilding={false}
      />

      <Highlight building={building} plan={plan} activeNodes={activeNodes} running={running} />
    </group>
  );
}

export default Devices;
