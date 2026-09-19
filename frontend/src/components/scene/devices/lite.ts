'use client';

/**
 * "Lite" is the campus's answer to four sites on screen at once.
 *
 * At portfolio level -- and for every site that is not the active one at site
 * level -- a lot still has to READ as a lot: the transformer, the cabinet, the
 * charging court and the plant are all there, standing in the right places.
 * What it does not get is anything that is only legible up close, or anything
 * that costs a frame:
 *
 *   particles, the approve pulse and the agent's highlight rings  not mounted
 *   pointer targets                                               not wrapped
 *   conduits                                                      dormant gauge
 *   floating kW pills                                             suppressed
 *
 * The last one is why this context exists rather than a prop. The pills are
 * rendered by each device prop, several modules down; a boolean threaded
 * through five components to reach one `return null` would put the plumbing
 * further from the thing it drives, so `devices/index` provides the flag and
 * `devices/NodeLabel` is the single place that reads it.
 */

import { createContext, useContext } from 'react';

export const LiteContext = createContext(false);

/** True when this device subtree is a background site. */
export function useLite(): boolean {
  return useContext(LiteContext);
}
