'use client';

/**
 * The surface the site stands on -- and deliberately, almost nothing else.
 *
 * There is no lawn, no sky and no drive. The 3D view is not a window onto a
 * field; it is the top of a dark dashboard, and the way to make it feel
 * embedded rather than pasted on is to let the page's own colour be the
 * background. So the Canvas clears to transparent, the scene has no
 * `background`, and everything below exists only to stop the models floating:
 *
 *   - a shadow catcher: one very large disc with `ShadowMaterial`, invisible
 *     except where the sun's shadow falls on it. It gives the long directional
 *     shadow that says "ten in the morning" without introducing a floor colour
 *     that would then have to be reconciled with the page.
 *   - drei <ContactShadows>: a soft occlusion pool directly under the geometry,
 *     which is what actually welds a building to a surface. Its material is an
 *     ordinary alpha-blended plane, so it composites over the transparent
 *     background and onto the page exactly as it would over a floor.
 *   - fog in the page's own colour, so anything far enough back dissolves into
 *     the background rather than ending.
 *
 * The result reads as an object resting on the dashboard rather than as a
 * diorama in a box.
 */

import { useMemo } from 'react';
import { ContactShadows } from '@react-three/drei';
import type { BuildingType } from '@/types/api';
import { lotOf } from './Environment';

/**
 * --color-base, the page background.
 *
 * The scene is the page's hero now, not an inset panel: the fog, the shadow
 * tint and `bg-base` all have to be the same black or the frame shows up as a
 * rectangle exactly where the hero is trying not to have one.
 */
export const PAGE_BASE = '#0a0f1a';

/**
 * How dark the sun's cast shadow is allowed to get on the bare page. Lower than
 * it would be on a lawn: there is no lit surface next to it to judge it
 * against, so a shadow that reads as "strong sunlight" outdoors reads as a hole
 * punched in the dashboard here. A touch stronger than it was inside a card --
 * the page is darker than the card was, so the same opacity read as nothing.
 */
const SUN_SHADOW_OPACITY = 0.36;
/** The contact pool is lighter; the two stack wherever both apply. */
const CONTACT_OPACITY = 0.22;

/**
 * Contact shadows sit 4 cm up so that nothing at grade -- a device pad, a
 * painted bay, the catcher itself -- is caught by their upward-looking camera
 * and painted black.
 */
const CONTACT_Y = 0.04;

export interface StageProps {
  /** 0-23, the hour being viewed. Only used to re-bake the contact shadows. */
  hour: number;
  type: BuildingType;
}

export function Stage({ hour, type }: StageProps) {
  const lot = useMemo(() => lotOf(type), [type]);

  return (
    <>
      {/* No <color attach="background"> on purpose: the scene stays
          transparent and the dashboard shows through. */}
      <fog attach="fog" args={[PAGE_BASE, 150, 650]} />

      {/* Shadow catcher. Invisible wherever nothing is shadowed, which is most
          of it, so there is no floor colour to reconcile with the page. Tinted
          to the page's own black rather than pure black, so the shadow deepens
          the background instead of punching through it. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[400, 64]} />
        <shadowMaterial
          transparent
          color={PAGE_BASE}
          opacity={SUN_SHADOW_OPACITY}
          depthWrite={false}
        />
      </mesh>

      {/* One bake is enough -- the geometry never moves. Keyed so a building
          swap or an hour change regenerates it. */}
      <ContactShadows
        key={`${type}-${Math.round(hour)}`}
        position={[lot.centre.x, CONTACT_Y, lot.centre.z]}
        /* Follows the lot, so a 25 m house lot is not paying for a 120 m map. */
        scale={lot.half * 2}
        resolution={1024}
        blur={2.2}
        opacity={CONTACT_OPACITY}
        /* Only the first 12 m above grade occludes. Higher than that and a
           38 m tower paints a grey slab that no sun direction explains. */
        far={12}
        frames={1}
      />
    </>
  );
}

export default Stage;
