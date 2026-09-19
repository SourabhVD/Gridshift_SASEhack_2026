/**
 * The five device nodes: a glyph, a label, a value, and an optional pulsing
 * ring for whichever node the agent is currently querying.
 *
 * Every glyph is authored around local (0, 0) inside a translated <g>, so the
 * only coordinates that matter outside this file are the node centres in
 * geometry.ts.
 */

import type { ReactNode } from 'react';
import { clamp, type Point } from './geometry';

export interface FlowNodeProps {
  center: Point;
  /** e.g. "EV · 8 bays". */
  label: string;
  /** e.g. "84 kW" or "→ 90 kW discharging". */
  value: string;
  /** Override the value colour (grid goes red over threshold). */
  valueColor?: string;
  /** Text under the glyph (top and left nodes) or over it (bottom nodes). */
  placement: 'below' | 'above';
  highlighted: boolean;
  ringRadius?: number;
  /** The glyph, drawn around local (0, 0). */
  children: ReactNode;
  /** Extra local-coordinate content, e.g. the EV bay dots. */
  extra?: ReactNode;
}

export function FlowNode({
  center,
  label,
  value,
  valueColor = 'var(--color-ink)',
  placement,
  highlighted,
  ringRadius = 34,
  children,
  extra,
}: FlowNodeProps) {
  const below = placement === 'below';
  // Offsets clear the widest highlight ring, so the pulse never strikes text.
  const labelY = below ? 46 : -54;
  const valueY = below ? 62 : -38;

  return (
    <g transform={`translate(${center.x} ${center.y})`}>
      {highlighted && (
        <circle
          className="gsflow-pulse"
          cx={0}
          cy={0}
          r={ringRadius}
          fill="none"
          stroke="var(--color-forecast)"
          strokeWidth={2}
        />
      )}

      {children}
      {extra}

      <text
        x={0}
        y={labelY}
        textAnchor="middle"
        fontSize={11}
        fill="var(--color-muted)"
        letterSpacing="0.02em"
      >
        {label}
      </text>
      <text x={0} y={valueY} textAnchor="middle" fontSize={12.5} fill={valueColor}>
        {value}
      </text>
    </g>
  );
}

/* -------------------------------------------------------------------------- */
/* Glyphs                                                                      */
/* -------------------------------------------------------------------------- */

interface GlyphProps {
  accent: string;
}

const GLYPH_STROKE = {
  fill: 'none',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** Transmission pylon. */
export function GridGlyph({ accent }: GlyphProps) {
  return (
    <g stroke={accent} {...GLYPH_STROKE}>
      <path d="M -18 26 L -6 -22 M 18 26 L 6 -22" />
      <path d="M -6 -22 L 0 -30 L 6 -22" />
      <path d="M -10 6 L 10 6 M -13.5 -7 L 13.5 -7" />
      <path d="M -13.5 -7 L 10 6 M 13.5 -7 L -10 6" opacity={0.45} strokeWidth={1.25} />
      <path d="M -20 26 L 20 26" />
    </g>
  );
}

/** Tilted PV array on a post. */
export function SolarGlyph({ accent }: GlyphProps) {
  return (
    <g stroke={accent} {...GLYPH_STROKE}>
      <path
        d="M -30 8 L -22 -10 L 30 -10 L 22 8 Z"
        fill="var(--color-surface-2)"
        strokeLinejoin="round"
      />
      <path d="M -26 -1 L 26 -1" strokeWidth={1.25} opacity={0.6} />
      <path d="M -4.7 -10 L -12.7 8 M 12.3 -10 L 4.3 8" strokeWidth={1.25} opacity={0.6} />
      <path d="M 0 8 L 0 20 M -11 20 L 11 20" />
    </g>
  );
}

export interface BatteryGlyphProps extends GlyphProps {
  /** 0–100. Drives the fill bar width. */
  socPct: number;
}

/** Battery outline with a state-of-charge fill bar. */
export function BatteryGlyph({ accent, socPct }: BatteryGlyphProps) {
  const soc = clamp(socPct, 0, 100);
  const innerW = 48;
  return (
    <g>
      <rect
        x={-30}
        y={-15}
        width={56}
        height={30}
        rx={5}
        fill="var(--color-surface-2)"
        stroke={accent}
        strokeWidth={2}
      />
      <rect x={26} y={-6} width={5} height={12} rx={2} fill={accent} />
      <rect
        className="gsflow-tween"
        x={-26}
        y={-11}
        width={(innerW * soc) / 100}
        height={22}
        rx={3}
        fill={accent}
        style={{ opacity: 0.55 }}
      />
      <text
        x={-2}
        y={4}
        textAnchor="middle"
        fontSize={11}
        fill="var(--color-ink)"
        fontFamily="var(--font-mono), ui-monospace, monospace"
      >
        {Math.round(soc)}%
      </text>
    </g>
  );
}

export interface EvGlyphProps extends GlyphProps {
  /** Bay dots to draw (capped at 12 by the caller). */
  bays: number;
  /** How many of those dots read as in use. */
  activeBays: number;
}

/** Car on a charge post, plus a row of bay indicators. */
export function EvGlyph({ accent }: GlyphProps) {
  return (
    <g transform="translate(-5 0)" stroke={accent} {...GLYPH_STROKE}>
      <path d="M -26 0 L -21 -11 Q -19 -14 -15 -14 L 7 -14 Q 11 -14 13 -11 L 18 0" />
      <rect
        x={-30}
        y={0}
        width={52}
        height={12}
        rx={4}
        fill="var(--color-surface-2)"
        stroke={accent}
      />
      <path d="M -13 -11 L -13 0" strokeWidth={1.25} opacity={0.6} />
      <circle cx={-17} cy={14} r={3.5} />
      <circle cx={9} cy={14} r={3.5} />
      <path d="M 22 6 L 29 6" strokeWidth={1.5} />
      <rect x={29} y={-2} width={11} height={15} rx={3} fill="var(--color-surface-2)" />
      <path d="M 32 -2 L 32 -7 M 37 -2 L 37 -7" strokeWidth={1.5} />
    </g>
  );
}

/** The dot row under the EV glyph, in node-local coordinates. */
export function EvBays({ accent, bays, activeBays }: EvGlyphProps) {
  const count = clamp(Math.round(bays), 0, 12);
  const active = clamp(Math.round(activeBays), 0, count);
  const spacing = 10;
  const left = -((count - 1) * spacing) / 2;

  return (
    <g>
      {Array.from({ length: count }, (_, i) => (
        <circle
          key={`bay-${i}`}
          className="gsflow-tween"
          cx={left + i * spacing}
          cy={28}
          r={3}
          fill={i < active ? accent : 'var(--color-line)'}
        />
      ))}
    </g>
  );
}

export interface HvacGlyphProps extends GlyphProps {
  /** Spin the blades while the HVAC is drawing power. */
  spinning: boolean;
}

/** Three-blade fan in a housing. */
export function HvacGlyph({ accent, spinning }: HvacGlyphProps) {
  return (
    <g stroke={accent} {...GLYPH_STROKE}>
      <circle cx={0} cy={0} r={24} fill="var(--color-surface-2)" stroke={accent} />
      <g className={spinning ? 'gsflow-fan' : undefined}>
        {[0, 120, 240].map((angle) => (
          <ellipse
            key={angle}
            cx={0}
            cy={-9}
            rx={4.5}
            ry={9}
            transform={`rotate(${angle})`}
            strokeWidth={1.75}
          />
        ))}
      </g>
      <circle cx={0} cy={0} r={2.75} fill={accent} stroke="none" />
    </g>
  );
}
