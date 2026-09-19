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
import type { BuildingModelProps } from '../contracts';
import { Hospital } from './Hospital';
import { House } from './House';
import { OfficeTower } from './OfficeTower';
import { Warehouse } from './Warehouse';

export function BuildingModel(props: BuildingModelProps) {
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

export default BuildingModel;

export { Hospital } from './Hospital';
export { House } from './House';
export { OfficeTower } from './OfficeTower';
export { Warehouse } from './Warehouse';
