'use client';

/**
 * Building models for the 3D energy scene.
 *
 * Renders only the building shell, its ground pad, signage and the junction box
 * at `junction(type)`. Devices (solar, HVAC, battery, EV, conduits) and the
 * scene foundation (canvas, lights, camera) live in the sibling modules.
 *
 * Geometry always comes from `BUILDING_SPECS[building.type]`, never from
 * `building.floors`, so the scene stays consistent with the layout contract.
 */
import { useMemo } from 'react';
import type { BuildingModelProps } from '../contracts';
import { Pickable, ringsFor } from '../interaction/Pickable';
import { GENERATED, GeneratedBuilding } from './Generated';
import { Hospital } from './Hospital';
import { House } from './House';
import { OfficeTower } from './OfficeTower';
import { Warehouse } from './Warehouse';

function Procedural(props: BuildingModelProps) {
  switch (props.building.type) {
    case 'hospital':
      return <Hospital {...props} />;
    case 'warehouse':
      return <Warehouse {...props} />;
    case 'residence':
      return <House {...props} />;
    case 'office':
    default:
      return <OfficeTower {...props} />;
  }
}

/**
 * The generated shell for this type if there is one, and the procedural
 * building either way -- in flight, on failure, and for the types whose model
 * did not survive the quality gate (see `Generated.tsx`).
 */
function Shell(props: BuildingModelProps) {
  const spec = GENERATED[props.building.type];
  if (!spec) return <Procedural {...props} />;
  return <GeneratedBuilding {...props} spec={spec} fallback={<Procedural {...props} />} />;
}

/**
 * The shell, wrapped so that any part of it -- wall, roof, sign, pad -- selects
 * the site itself. Devices sit in their own pick groups in front of it and stop
 * propagation, so clicking a battery never reads as clicking the building.
 */
export function BuildingModel(props: BuildingModelProps) {
  const ring = useMemo(() => ringsFor(props.building).building, [props.building]);
  return (
    <Pickable node="building" ring={ring}>
      <Shell {...props} />
    </Pickable>
  );
}

export default BuildingModel;

export { Hospital } from './Hospital';
export { House } from './House';
export { OfficeTower } from './OfficeTower';
export { Warehouse } from './Warehouse';
