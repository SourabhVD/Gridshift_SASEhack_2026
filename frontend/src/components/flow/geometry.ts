/**
 * Pure layout maths for the energy-flow diagram.
 *
 * Everything here is deterministic (no Math.random, no Date) so the server and
 * the client render byte-identical markup. All coordinates are in the
 * 800 x 420 viewBox space, never in pixels.
 */

import type { BuildingType } from './types';

export interface Point {
  x: number;
  y: number;
}

export const VIEW_W = 800;
export const VIEW_H = 420;

/** The five device nodes plus the building, at their fixed anchor points. */
export const NODE_CENTERS = {
  building: { x: 400, y: 210 },
  grid: { x: 90, y: 210 },
  solar: { x: 200, y: 60 },
  battery: { x: 200, y: 360 },
  ev: { x: 610, y: 60 },
  hvac: { x: 610, y: 360 },
} as const satisfies Record<string, Point>;

export type FlowNodeId = keyof typeof NODE_CENTERS;

/** The five wires. Keys match `EnergyFlows` prefixes. */
export type WireId = 'grid' | 'solar' | 'battery' | 'ev' | 'hvac';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/* -------------------------------------------------------------------------- */
/* Building elevation                                                          */
/* -------------------------------------------------------------------------- */

/** Tall towers stop growing rows here; the glyph is a cue, not a floor plan. */
export const MAX_FLOOR_ROWS = 8;

export interface BuildingShape {
  /** Body rect. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Top of the whole silhouette, roof included. Used for the highlight ring. */
  top: number;
  /** Polygon points for a pitched roof, or null for a flat-topped tower. */
  roof: string | null;
  rows: number;
  cols: number;
  /** Where wires attach. */
  anchors: {
    left: Point;
    topLeft: Point;
    topRight: Point;
    bottomLeft: Point;
    bottomRight: Point;
  };
}

/**
 * A stylised elevation derived from the building record: offices and hospitals
 * are flat-topped towers whose row count tracks `floors`; warehouses are one
 * wide low bay under a shallow pitched roof.
 */
export function buildingShape(type: BuildingType, floors: number): BuildingShape {
  if (type === 'warehouse') {
    const x = 298;
    const y = 196;
    const w = 204;
    const h = 76;
    return {
      x,
      y,
      w,
      h,
      top: 156,
      roof: '298,196 400,156 502,196',
      rows: 1,
      cols: 7,
      anchors: {
        left: { x, y: y + h / 2 },
        // On the roof slope, so the wire meets the silhouette rather than air.
        topLeft: { x: 350, y: 176 },
        topRight: { x: 450, y: 176 },
        // Near the corners, so the bottom wires clear the centred name label.
        bottomLeft: { x: x + 8, y: y + h },
        bottomRight: { x: x + w - 8, y: y + h },
      },
    };
  }

  const x = 312;
  const y = 148;
  const w = 176;
  const h = 124;
  const rows = clamp(Math.round(floors) || 1, 1, MAX_FLOOR_ROWS);
  return {
    x,
    y,
    w,
    h,
    top: y,
    roof: null,
    rows,
    cols: 6,
    anchors: {
      left: { x, y: y + h / 2 },
      topLeft: { x: x + 38, y },
      topRight: { x: x + w - 38, y },
      // Near the corners, so the bottom wires clear the centred name label.
      bottomLeft: { x: x + 8, y: y + h },
      bottomRight: { x: x + w - 8, y: y + h },
    },
  };
}

export interface WindowRect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The grid of lit windows inside the body rect, centred vertically. */
export function windowGrid(s: BuildingShape): WindowRect[] {
  const gap = s.rows > 5 ? 5 : 7;
  const padX = 18;
  const padY = 16;

  const cellW = (s.w - padX * 2 - (s.cols - 1) * gap) / s.cols;
  const maxCellH = s.rows === 1 ? 24 : 14;
  const cellH = Math.min(maxCellH, (s.h - padY * 2 - (s.rows - 1) * gap) / s.rows);

  const blockH = s.rows * cellH + (s.rows - 1) * gap;
  const top = s.y + (s.h - blockH) / 2;

  const out: WindowRect[] = [];
  for (let row = 0; row < s.rows; row += 1) {
    for (let col = 0; col < s.cols; col += 1) {
      out.push({
        key: `w${row}-${col}`,
        x: s.x + padX + col * (cellW + gap),
        y: top + row * (cellH + gap),
        w: cellW,
        h: cellH,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Wires                                                                       */
/* -------------------------------------------------------------------------- */

export interface WireGeometry {
  from: Point;
  c1: Point;
  c2: Point;
  to: Point;
}

/**
 * Geometry is always authored building-ward (device -> building). `Wire`
 * reverses it when the flow runs the other way, which also reverses the
 * direction the dashes travel.
 */
export function wireGeometries(b: BuildingShape): Record<WireId, WireGeometry> {
  const a = b.anchors;
  return {
    grid: {
      from: { x: 126, y: 210 },
      c1: { x: 196, y: 210 },
      c2: { x: a.left.x - 58, y: a.left.y },
      to: a.left,
    },
    solar: {
      from: { x: 240, y: 48 },
      c1: { x: 306, y: 48 },
      c2: { x: a.topLeft.x - 6, y: a.topLeft.y - 58 },
      to: a.topLeft,
    },
    ev: {
      from: { x: 572, y: 48 },
      c1: { x: 506, y: 48 },
      c2: { x: a.topRight.x + 6, y: a.topRight.y - 58 },
      to: a.topRight,
    },
    battery: {
      from: { x: 240, y: 352 },
      c1: { x: 306, y: 352 },
      c2: { x: a.bottomLeft.x - 6, y: a.bottomLeft.y + 54 },
      to: a.bottomLeft,
    },
    hvac: {
      from: { x: 574, y: 352 },
      c1: { x: 508, y: 352 },
      c2: { x: a.bottomRight.x + 6, y: a.bottomRight.y + 54 },
      to: a.bottomRight,
    },
  };
}

/** Cubic path string; `reverse` flips it end-for-end (and so flips the dashes). */
export function cubicPath(g: WireGeometry, reverse = false): string {
  const [p0, p1, p2, p3] = reverse ? [g.to, g.c2, g.c1, g.from] : [g.from, g.c1, g.c2, g.to];
  return `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
}

/** Below this a wire is drawn as a dormant line: base stroke only, no dashes. */
export const MIN_WIRE_KW = 0.5;

/** 0..1 share of the busiest wire in this hour. */
export function wireRatio(kw: number, maxKw: number): number {
  if (maxKw <= 0) return 0;
  return clamp(Math.abs(kw) / maxKw, 0, 1);
}

export function wireStrokeWidth(ratio: number): number {
  return 1.5 + 6 * ratio;
}

/**
 * Seconds per dash cycle. The busiest wire of the hour runs at 3 s and quiet
 * wires stretch out from there, capped so a trickle still visibly moves.
 */
export function wireDurationS(ratio: number): number {
  if (ratio <= 0) return 8;
  return clamp(3 / ratio, 0.5, 8);
}

/**
 * Distance the dashes travel per cycle, in viewBox units. A multiple of the
 * 16-unit "6 10" dash period so the loop is seamless.
 */
export const DASH_CYCLE = 144;

/** The largest magnitude among the five device flows; never below 1 kW. */
export function maxFlowKw(values: readonly number[]): number {
  return Math.max(1, ...values.map(Math.abs));
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic width estimate for pill backgrounds. SVG text cannot be
 * measured during render, and measuring on the client would desync SSR.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.58;
}
