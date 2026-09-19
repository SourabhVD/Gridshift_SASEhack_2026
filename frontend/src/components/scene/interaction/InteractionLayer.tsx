'use client';

/**
 * Everything that has to touch the container element rather than the scene: the
 * drag-to-look gesture and the cursor.
 *
 * It renders nothing. It exists as its own component purely so that the hover
 * and selection subscriptions live in a leaf — `EnergyScene` itself never
 * subscribes, so picking a device does not re-render the Canvas tree.
 *
 * Cursor precedence, in one place so the two sources never fight:
 *
 *   pointer    over a pickable prop
 *   grabbing   mid-drag (set by the gesture itself)
 *   grab       something is selected, so a drag would do something
 *   default    nothing selected: the home view does not move
 */

import { useEffect, type RefObject } from 'react';
import type { BuildingType } from '@/types/api';
import { useHovered, useSelected, useSelectionStore } from './selection';
import { useDragLook } from './useDragLook';

export interface InteractionLayerProps {
  containerRef: RefObject<HTMLDivElement | null>;
  type: BuildingType;
}

export function InteractionLayer({ containerRef, type }: InteractionLayerProps) {
  const store = useSelectionStore();
  const selected = useSelected();
  const hovered = useHovered();

  useDragLook(containerRef, type);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || store.isDragging()) return;
    el.style.cursor = hovered ? 'pointer' : selected ? 'grab' : '';
  }, [containerRef, hovered, selected, store]);

  return null;
}

export default InteractionLayer;
