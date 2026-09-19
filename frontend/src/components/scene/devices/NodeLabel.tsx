'use client';

/**
 * The floating kW pill that sits above each device.
 *
 * DOM rather than a texture, so the numbers stay crisp at any zoom and pick up
 * the dashboard's own font. Purely decorative: it never takes pointer events,
 * so orbiting the camera through a label still works.
 */

import { Html } from '@react-three/drei';

export interface NodeLabelProps {
  position: readonly [number, number, number];
  /** "Grid", "Battery - 82%", ... */
  name: string;
  /** "396 kW", "-> 90 kW discharging", ... Omitted for label-only nodes. */
  value?: string;
  /** Tints the value; used for the over-threshold grid readout. */
  valueColor?: string;
}

export function NodeLabel({ position, name, value, valueColor }: NodeLabelProps) {
  return (
    <Html
      position={position as [number, number, number]}
      center
      distanceFactor={14}
      occlude={false}
      zIndexRange={[24, 0]}
      wrapperClass="pointer-events-none"
      style={{ pointerEvents: 'none', userSelect: 'none' }}
    >
      <div className="pointer-events-none whitespace-nowrap rounded-md border border-[#1f2937] bg-[#0a0f1a]/85 px-2 py-0.5 text-[11px] font-medium tabular-nums text-[#e5e7eb]">
        {name}
        {value ? (
          <span className="ml-1.5" style={valueColor ? { color: valueColor } : undefined}>
            {value}
          </span>
        ) : null}
      </div>
    </Html>
  );
}

export default NodeLabel;
