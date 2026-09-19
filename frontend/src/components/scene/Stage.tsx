'use client';

/**
 * The surface the site stands on -- and deliberately, almost nothing else.
 *
 * There is no lawn, no sky and no drive. The 3D view is not a window onto a
 * field; it is a panel inside a dark dashboard, and the way to make it feel
 * embedded rather than pasted on is to let the card's own colour be the
 * background. So the Canvas clears to transparent, the scene has no
 * `background`, and everything below exists only to stop the models floating:
 *
 *   - a shadow catcher: one very large disc with `ShadowMaterial`, invisible
 *     except where the sun's shadow falls on it. It gives the long directional
 *     shadow that says "ten in the morning" without introducing a floor colour
 *     that would then have to be reconciled with the card.
 *   - drei <ContactShadows>: a soft occlusion pool directly under the geometry,
 *     which is what actually welds a building to a surface. Its material is an
 *     ordinary alpha-blended plane, so it composites over the transparent
 *     background and onto the card exactly as it would over a floor.
 *   - fog in the card's own colour, so anything far enough back dissolves into
 *     the panel rather than ending.
 *
 * The result reads as an object resting on the dashboard rather than as a
 * diorama in a box.
 */

import { useMemo } from 'react';
import { ContactShadows } from '@react-three/drei';
import type { BuildingType } from '@/types/api';
import { lotOf } from './Environment';

/** --color-surface. The fog and the page's card have to agree or the edge shows. */
export const CARD_SURFACE = '#111827';

/**
 * How dark the sun's cast shadow is allowed to get on the bare card. Lower than
 * it would be on a lawn: there is no lit surface next to it to judge it
 * against, so a shadow that reads as "strong sunlight" outdoors reads as a hole
 * punched in the dashboard here.
 */
const SUN_SHADOW_OPACITY = 0.3;
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
      <fog attach="fog" args={[CARD_SURFACE, 150, 650]} />

      {/* Shadow catcher. Invisible wherever nothing is shadowed, which is most
          of it, so there is no floor colour to reconcile with the card. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[400, 64]} />
        <shadowMaterial transparent opacity={SUN_SHADOW_OPACITY} depthWrite={false} />
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
