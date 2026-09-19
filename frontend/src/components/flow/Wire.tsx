/**
 * One conductor between a device node and the building.
 *
 * Three stacked paths: a dark base line that is always there, a faint tinted
 * underlay, and the animated dashed overlay that carries the direction. Only
 * the overlay reacts to load, and its stroke width is set through `style` so
 * the CSS transition in the parent's stylesheet picks up hour-to-hour changes.
 */

import {
  MIN_WIRE_KW,
  cubicPath,
  wireDurationS,
  wireRatio,
  wireStrokeWidth,
  type WireGeometry,
} from './geometry';

export interface WireProps {
  geometry: WireGeometry;
  /**
   * Draw the path end-for-end. Geometry is authored device -> building, so
   * set this for flows that run building -> device (EV, HVAC, charging
   * battery); the dashes then travel away from the building.
   */
  reverse?: boolean;
  /** Signed kW for this wire. Only the magnitude drives width and speed. */
  kw: number;
  /** Largest magnitude among the five flows this hour. */
  maxKw: number;
  /** A `var(--color-…)` string. */
  color: string;
  /** Hover tooltip describing what this wire is doing. */
  label: string;
}

export function Wire({ geometry, reverse = false, kw, maxKw, color, label }: WireProps) {
  const d = cubicPath(geometry, reverse);
  const active = Math.abs(kw) >= MIN_WIRE_KW;
  const ratio = wireRatio(kw, maxKw);
  const width = wireStrokeWidth(ratio);
  const duration = wireDurationS(ratio);

  return (
    <g>
      <title>{label}</title>

      <path
        d={d}
        fill="none"
        stroke="var(--color-line)"
        strokeWidth={2}
        strokeLinecap="round"
        className="gsflow-tween"
        style={{ opacity: active ? 0.9 : 0.35 }}
      />

      {active && (
        <>
          <path
            d={d}
            fill="none"
            stroke={color}
            strokeLinecap="round"
            className="gsflow-tween"
            style={{ strokeWidth: width, opacity: 0.16 }}
          />
          <path
            d={d}
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeDasharray="6 10"
            className="gsflow-tween gsflow-dash"
            style={{ strokeWidth: width, animationDuration: `${duration.toFixed(2)}s` }}
          />
        </>
      )}
    </g>
  );
}

export default Wire;
