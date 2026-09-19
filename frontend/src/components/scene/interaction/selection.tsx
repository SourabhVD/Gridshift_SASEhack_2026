'use client';

/**
 * Who is selected, who is hovered, and where the viewer has dragged the shot.
 *
 * This is deliberately NOT React state. The scene lives on both sides of a
 * `<Canvas>` boundary and re-rendering the whole tree because the pointer
 * crossed a battery cabinet would cost a frame every time; so the three pieces
 * of state live in a plain mutable object and components opt in with
 * `useSyncExternalStore`:
 *
 *   selected   the node whose close-up the camera is holding; drives the card
 *   hovered    pointer feedback only: the ground ring and the label pill
 *   look       drag offsets in degrees, mutated in place and read by the
 *              CameraRig inside useFrame -- it never causes a render at all
 *
 * The store instance is handed down through context, but its identity never
 * changes, so the provider itself renders exactly once. Only the handful of
 * components that actually call `useSelected()` / `useHovered()` re-render when
 * something is picked, and `children` passed through them bail out.
 *
 * `@react-three/fiber` bridges React context across the Canvas (its-fine), so
 * the same store reaches the CameraRig and the Pickables inside the scene as
 * well as the HTML card outside it.
 */

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { SceneNode } from '../layout';

/** Drag-look offsets, in degrees, relative to the selected node's shot. */
export interface LookOffset {
  az: number;
  el: number;
}

/**
 * Live gesture bookkeeping. `moved` is what keeps a drag from also counting as
 * a click: the pointerdown resets it, a few pixels of travel sets it, and both
 * `Pickable` and the Canvas's `onPointerMissed` bail out while it is true.
 */
export interface Gesture {
  dragging: boolean;
  moved: boolean;
}

export interface SelectionStore {
  getSelected: () => SceneNode | null;
  getHovered: () => SceneNode | null;
  /** Null clears. Selecting the node that is already selected clears it too. */
  select: (node: SceneNode | null) => void;
  hover: (node: SceneNode | null) => void;
  subscribe: (listener: () => void) => () => void;
  subscribeHover: (listener: () => void) => () => void;
  /**
   * The live drag offset. Read every frame by the camera; written only through
   * `setLook`, because a store handed out by a hook may not be assigned into
   * from the outside.
   */
  look: Readonly<LookOffset>;
  setLook: (az: number, el: number) => void;
  isDragging: () => boolean;
  setDragging: (dragging: boolean) => void;
  /** True once a gesture has travelled far enough to stop being a click. */
  hasMoved: () => boolean;
  setMoved: (moved: boolean) => void;
}

export function createSelectionStore(): SelectionStore {
  let selected: SceneNode | null = null;
  let hovered: SceneNode | null = null;
  const selectedListeners = new Set<() => void>();
  const hoveredListeners = new Set<() => void>();
  const look: LookOffset = { az: 0, el: 0 };
  const gesture: Gesture = { dragging: false, moved: false };

  return {
    getSelected: () => selected,
    getHovered: () => hovered,
    select(node) {
      const next = node === selected ? null : node;
      if (next === selected) return;
      selected = next;
      /* A new subject gets a fresh viewpoint: the drag the viewer applied to
         the last one would otherwise carry over into an unrelated framing. */
      look.az = 0;
      look.el = 0;
      for (const listener of selectedListeners) listener();
    },
    hover(node) {
      if (node === hovered) return;
      hovered = node;
      for (const listener of hoveredListeners) listener();
    },
    subscribe(listener) {
      selectedListeners.add(listener);
      return () => selectedListeners.delete(listener);
    },
    subscribeHover(listener) {
      hoveredListeners.add(listener);
      return () => hoveredListeners.delete(listener);
    },
    look,
    setLook(az, el) {
      look.az = az;
      look.el = el;
    },
    isDragging: () => gesture.dragging,
    setDragging(dragging) {
      gesture.dragging = dragging;
    },
    hasMoved: () => gesture.moved,
    setMoved(moved) {
      gesture.moved = moved;
    },
  };
}

const SelectionContext = createContext<SelectionStore | null>(null);

/**
 * Mount one per scene, keyed on the building id: a different site is a
 * different set of props, so the old selection dies with the old store.
 */
export function SelectionProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => createSelectionStore(), []);
  return <SelectionContext.Provider value={store}>{children}</SelectionContext.Provider>;
}

export function useSelectionStore(): SelectionStore {
  const store = useContext(SelectionContext);
  if (!store) throw new Error('useSelectionStore() must be used inside <SelectionProvider>.');
  return store;
}

const NOTHING = () => null;

/** Subscribes this component -- and only this component -- to the selection. */
export function useSelected(): SceneNode | null {
  const store = useSelectionStore();
  return useSyncExternalStore(store.subscribe, store.getSelected, NOTHING);
}

/** Same, for hover feedback. Kept separate so the card ignores hover entirely. */
export function useHovered(): SceneNode | null {
  const store = useSelectionStore();
  return useSyncExternalStore(store.subscribeHover, store.getHovered, NOTHING);
}
