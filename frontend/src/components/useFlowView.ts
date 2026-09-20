'use client';

/**
 * Which presentation of the energy flow the viewer has chosen: the 3D scene or
 * the 2D single-line diagram.
 *
 * localStorage as a tiny external store, so the preference can be read during
 * render without a setState-in-effect round trip. The server snapshot is the
 * default view, which is what the first client paint renders too.
 *
 * Lives here rather than in a component because two of them present the same
 * pair -- the full-bleed hero and the card-shaped EnergyFlowPanel -- and they
 * must never disagree about the stored key.
 */

import { useSyncExternalStore } from 'react';

export type FlowView = '3d' | '2d';

/** localStorage key holding the last view the user picked. */
export const FLOW_VIEW_STORAGE_KEY = 'gridshift.flowView';

export const FLOW_VIEWS: readonly FlowView[] = ['3d', '2d'];

const DEFAULT_VIEW: FlowView = '3d';

let currentView: FlowView | null = null;
const listeners = new Set<() => void>();

function snapshot(): FlowView {
  if (currentView === null) {
    try {
      const stored = localStorage.getItem(FLOW_VIEW_STORAGE_KEY);
      currentView = stored === '3d' || stored === '2d' ? stored : DEFAULT_VIEW;
    } catch {
      currentView = DEFAULT_VIEW;
    }
  }
  return currentView;
}

function serverSnapshot(): FlowView {
  return DEFAULT_VIEW;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Pick a view and remember it. Safe to call from anywhere. */
export function setFlowView(next: FlowView): void {
  currentView = next;
  try {
    localStorage.setItem(FLOW_VIEW_STORAGE_KEY, next);
  } catch {
    /* private mode, quota, disabled storage -- the choice just will not stick */
  }
  for (const listener of listeners) listener();
}

/** The stored view. `'3d'` during SSR and the hydrating paint. */
export function useFlowView(): FlowView {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
