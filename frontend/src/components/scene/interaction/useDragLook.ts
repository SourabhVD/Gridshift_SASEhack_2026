'use client';

/**
 * Look around the close-up -- a little.
 *
 * This is not an orbit control and must never become one. The home view is
 * fixed by the rig's own rule ("a dashboard panel that drifts in the corner of
 * your eye is a bad neighbour"), so dragging does nothing at all until a node
 * is selected. Once one is, the drag walks the shot's own azimuth and elevation
 * inside a small window and never touches the distance:
 *
 *   azimuth    +-35 deg of the shot
 *   elevation  [max(12, shot - 15), min(60, shot + 18)] deg
 *
 * The offsets are written into the selection store's `look` object, which the
 * camera reads inside `useFrame`; a drag therefore causes no React render at
 * all. Releasing leaves the view where it was left; selecting something else or
 * deselecting zeroes the offsets, so the camera slides back to the shot and
 * then home.
 *
 * Pointer capture means touch and pen behave like the mouse, and a drag of more
 * than a few pixels sets `gesture.moved`, which is how `Pickable` and the
 * Canvas's `onPointerMissed` know that the click that follows was the tail of a
 * gesture rather than a pick.
 */

import { useEffect, type RefObject } from 'react';
import type { BuildingType } from '@/types/api';
import type { SceneNode } from '../layout';
import { useSelected, useSelectionStore } from './selection';
import { shotElevation } from './shots';

/** Degrees of rotation per pixel of drag. ~120 px covers the whole azimuth range. */
const SENSITIVITY = 0.3;
/** Travel, in pixels, past which the gesture stops being a click. */
const SLOP = 4;

const MAX_AZIMUTH = 35;
const MIN_ELEVATION = 12;
const MAX_ELEVATION = 60;
const DOWN_RANGE = 15;
const UP_RANGE = 18;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The elevation offsets this shot allows, as [down, up] deltas in degrees. */
export function elevationLimits(node: SceneNode, type: BuildingType): [number, number] {
  const base = shotElevation(node, type);
  return [
    Math.max(MIN_ELEVATION, base - DOWN_RANGE) - base,
    Math.min(MAX_ELEVATION, base + UP_RANGE) - base,
  ];
}

export function useDragLook(
  containerRef: RefObject<HTMLDivElement | null>,
  type: BuildingType,
): void {
  const store = useSelectionStore();
  const selected = useSelected();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    /* The elevation window belongs to the shot, so it is only meaningful while
       something is selected; the rest of the handler is attached either way,
       because clearing `moved` on every pointerdown is what keeps a stale
       gesture from swallowing the next click. */
    const limits = selected ? elevationLimits(selected, type) : null;
    el.style.cursor = selected ? 'grab' : '';

    let pointer = -1;
    let lastX = 0;
    let lastY = 0;
    let travel = 0;

    const onDown = (event: PointerEvent) => {
      store.setMoved(false);
      if (!limits) return;
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      /* The detail card and the HUD live in the same box; only gestures that
         start on the canvas itself are look-arounds. */
      if (!(event.target instanceof HTMLCanvasElement)) return;
      pointer = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      travel = 0;
      /* Deliberately NOT capturing the pointer yet. Capture retargets the
         click to this container, and r3f listens on the canvas -- so capturing
         on pointerdown would swallow every pick and every click-on-nothing.
         The capture is taken in onMove, once the gesture is really a drag. */
    };

    const onMove = (event: PointerEvent) => {
      if (!limits || event.pointerId !== pointer) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      travel += Math.abs(dx) + Math.abs(dy);
      if (travel > SLOP && !store.hasMoved()) {
        store.setMoved(true);
        store.setDragging(true);
        el.setPointerCapture(event.pointerId);
        el.style.cursor = 'grabbing';
      }
      if (!store.hasMoved()) return;

      /* Dragging right swings the camera left, so the subject follows the
         hand -- the same direction of travel as every map and every viewer. */
      store.setLook(
        clamp(store.look.az - dx * SENSITIVITY, -MAX_AZIMUTH, MAX_AZIMUTH),
        clamp(store.look.el + dy * SENSITIVITY, limits[0], limits[1]),
      );
      /* Touch: stop the page scrolling under the gesture. */
      if (event.pointerType !== 'mouse' && event.cancelable) event.preventDefault();
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      pointer = -1;
      store.setDragging(false);
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
      el.style.cursor = store.getHovered() ? 'pointer' : 'grab';
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove, { passive: false });
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.style.cursor = '';
      store.setDragging(false);
    };
  }, [containerRef, selected, store, type]);
}

export default useDragLook;
