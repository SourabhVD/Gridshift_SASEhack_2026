'use client';

/**
 * The floating kW pill that sits above each device.
 *
 * DOM rather than a texture, so the numbers stay crisp at any zoom and pick up
 * the dashboard's own font. Purely decorative: it never takes pointer events,
 * so orbiting the camera through a label still works.
 *
 * There is exactly one label per device -- grid, solar, battery, EV, HVAC --
 * so the frame never carries more than five. Two of those five are suppressed
 * when they have nothing to say: `RoofSolar` and `RoofHvac` pass
 * `hideBelow={DORMANT_KW}` so a parked fan or a dark array stops competing with
 * the readouts that are actually moving.
 */

import { Html } from '@react-three/drei';
import { usePickEmphasis } from '../interaction/Pickable';

export interface NodeLabelProps {
  position: readonly [number, number, number];
  /** "Grid", "Battery - 82%", ... */
  name: string;
  /** "396 kW", "-> 90 kW discharging", ... Omitted for label-only nodes. */
  value?: string;
  /** Tints the value; used for the over-threshold grid readout. */
  valueColor?: string;
  /** When false the label is not mounted at all. */
  show?: boolean;
}

export function NodeLabel({ position, name, value, valueColor, show = true }: NodeLabelProps) {
  /* Every label is mounted inside its device's <Pickable>, so it can lift
   * itself when the pointer is on that device. This is the only thing in the
   * device subtree that re-renders on a hover. */
  const emphasis = usePickEmphasis();
  if (!show) return null;
  return (
    <Html
      position={position as [number, number, number]}
      center
      /* Deliberately NO `distanceFactor`. It scales the pill by 1/distance, and
       * the camera rig pulls back to 90 m for the office tower and the
       * warehouse -- which rendered the 11px text at about 1.6px, i.e. nothing.
       * Unscaled is also what "HUD" means: the same pill at every framing. */
      occlude={false}
      zIndexRange={[24, 0]}
      wrapperClass="pointer-events-none"
      style={{ pointerEvents: 'none', userSelect: 'none' }}
    >
      <div
        className={
          'pointer-events-none whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums backdrop-blur-sm transition-colors duration-150 ' +
          (emphasis === 'none'
            ? 'border-white/10 bg-black/55 text-white/90'
            : 'border-white/30 bg-black/70 text-white')
        }
      >
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
